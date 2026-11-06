"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useAccount, useConfig, useWriteContract } from "wagmi";
import { getAccount, waitForTransactionReceipt } from "wagmi/actions";
import { erc20Abi, formatUnits, type Address, type Hash } from "viem";
import { publicClient, rpcChainMismatch } from "../chain";
import { DEPLOYMENT, IS_TESTNET } from "../deployment";
import { MarketRipPoolAbi, ErodoroVaultAbi } from "../abis";
import { useNow } from "../use-now";
import { addFill, type PoolLot, type RipFill, type RipPosition, type RipSource } from "./model";
import { demoLots, demoMark } from "./demo";
import { useDemoConsumed, useStoredPositions, positionsKey } from "./store";
import { byClaim, heldPosition, loadSnapshot, lotFor, poolHouse, selectLiveLots, validatePool, type Snapshot } from "./live";
import { purchaseError, decodePack, decodePurchase, inventoryCommitment, packsAvailable } from "./purchase";
import { RIPS_SHOW_DEMO } from "./ui";
import { prefetchStockPrices, stockPrice, type StockPrice } from "./prices";

export type Mark = { value: number | null; spot: number | null; marked: "model" | "quote" | "settlement" | "unavailable" };
export type BuyResult = { ok: true; position: RipPosition; fill: RipFill; lot: PoolLot } | { ok: false; reason: string };
export type PackPull = { position: RipPosition; fill: RipFill; lot: PoolLot };
export type PackResult = { ok: true; pulls: PackPull[]; hash: Hash } | { ok: false; reason: string };
/** A $1 pack: $0.10 on each of ten stocks (MarketRipPool.ripPack). */
/**
 * Random draws are made in the block that includes the transaction, not the one
 * a wallet estimated against, and a draw that reaches listings this buyer has
 * never bought from writes more storage. A plain estimate can then run out of
 * gas (seen on a mainnet fork), so blind buys carry 50% headroom.
 */
const withHeadroom = (estimate: bigint) => estimate * 3n / 2n;

/**
 * One approval should cover a session of $1 buys, not just the next one, or
 * every pack costs two signatures. Approve up to $20, never more than the
 * wallet holds and never less than this purchase.
 */
const APPROVAL_CAP_DOLLARS = 20n;
const approvalAmount = (paid: bigint, funds: bigint, decimals: number) => {
  const cap = APPROVAL_CAP_DOLLARS * 10n ** BigInt(decimals);
  const wanted = funds < cap ? funds : cap;
  return wanted > paid ? wanted : paid;
};

export const PACK_SIZE = 10;
const PACK_SLICE_RAW = 100_000n;

/** Public RPCs drop occasional reads; retry twice before surfacing an error. */
export async function retryRead<T>(read: () => Promise<T>): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try { return await read(); } catch (error) {
      if (attempt >= 2) throw error;
      await new Promise(resolve => setTimeout(resolve, 600 * 3 ** attempt));
    }
  }
}

const purchaseLocks = new Set<string>();
const EMPTY: Snapshot = { batchId: 0n, positions: [], holdings: [] };

export function useRipsState() {
  const { address, chainId } = useAccount();
  const config = useConfig();
  const { writeContractAsync } = useWriteContract();
  const now = Number(useNow());
  const [mode, chooseMode] = useState<RipSource>("live");
  const [modeReady, setModeReady] = useState(false);
  const [snapshot, setSnapshot] = useState<Snapshot>(EMPTY);
  const [loadedOwner, setLoadedOwner] = useState<string | undefined>(undefined);
  const [balanceOwner, setBalanceOwner] = useState<string | undefined>(undefined);
  const [liveLots, setLiveLots] = useState<PoolLot[]>([]);
  const [liveState, setLiveState] = useState<"loading" | "ready" | "undeployed" | "error">("loading");
  const [error, setError] = useState<string | null>(null);
  const [supported, setSupported] = useState(false);
  const [balance, setBalance] = useState<number | null>(null);
  const [phase, setPhase] = useState("idle");
  const [transaction, setTransaction] = useState<Hash | null>(null);
  const busy = useRef(false);
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const epoch = useRef(0);
  const owner = useRef(address);
  useEffect(() => { owner.current = address; }, [address]);
  const selectedMode = useRef(mode);
  useEffect(() => { selectedMode.current = mode; }, [mode]);
  const { consumed, consume } = useDemoConsumed();
  const stored = useStoredPositions(positionsKey(null, true));
  const savedDemo = useRef(stored.positions);
  useEffect(() => { savedDemo.current = stored.positions; }, [stored.positions]);

  const setMode = useCallback((m: RipSource) => {
    if (busy.current || (!IS_TESTNET && m === "demo")) return;
    chooseMode(m);
    try { localStorage.setItem(`erodoro.rips.base.mode:${DEPLOYMENT.chainId}`, m); } catch { /* Session choice remains. */ }
  }, []);
  useEffect(() => {
    const init = setTimeout(() => {
    try { if (RIPS_SHOW_DEMO && IS_TESTNET && localStorage.getItem(`erodoro.rips.base.mode:${DEPLOYMENT.chainId}`) === "demo") chooseMode("demo"); } catch { /* Live default. */ }
    setModeReady(true);
    }, 0);
    return () => clearTimeout(init);
  }, []);

  const refresh = useCallback(async () => {
    const sequence = ++epoch.current;
    if (!DEPLOYMENT.contracts.ripPool) {
      setSnapshot(EMPTY); setLiveLots([]); setLiveState("undeployed");
      return;
    }
    try {
      const { enabled, next, lots } = await retryRead(async () => {
        // Independent reads: validating the pool need not delay reading it.
        // The purchase-history scan pages through logs 200 blocks at a time on
        // public RPC; render from getters first and add timestamps after.
        const [enabled, next] = await Promise.all([validatePool(), loadSnapshot(address, false)]);
        const lots = await Promise.all(next.positions.filter(({ row }) => row.direction === 0 && row.unitsPerRip > 0n).map(({ id, row }) => lotFor(id, row)));
        return { enabled, next, lots };
      });
      if (sequence !== epoch.current || owner.current !== address) return;
      setSnapshot(next); setLoadedOwner(address); setLiveLots(lots); setSupported(enabled); setError(null); setLiveState("ready");
      if (address && next.holdings.length) {
        void loadSnapshot(address).then((full) => {
          if (sequence === epoch.current && owner.current === address) setSnapshot(full);
        }).catch(() => { /* Timestamps are optional; getter totals already shown. */ });
      }
    } catch {
      if (sequence !== epoch.current) return;
      // Keep this wallet's last verified snapshot during a transient RPC failure.
      // Wallet changes clear it in the effect below; failed reads disable buying.
      setSupported(false); setError("Could not refresh on-chain Rips. Any shown data is from the last successful read. Retry to get current balances and positions."); setLiveState("error");
    }
  }, [address]);

  const refreshBalance = useCallback(async () => {
    if (!address || !DEPLOYMENT.quote) { setBalance(null); return; }
    try {
      const raw = await publicClient.readContract({ address: DEPLOYMENT.quote.token, abi: erc20Abi, functionName: "balanceOf", args: [address] });
      if (owner.current === address) { setBalance(Number(formatUnits(raw, DEPLOYMENT.quote.decimals))); setBalanceOwner(address); }
    } catch { if (owner.current === address) setBalance(null); }
  }, [address]);
  useEffect(() => {
    const kickoff = setTimeout(() => {
      setSnapshot(EMPTY); setLiveLots([]); setBalance(null); setLiveState("loading");
      void refresh(); void refreshBalance();
    }, 0);
    const timer = setInterval(() => { void refresh(); void refreshBalance(); }, 15_000);
    return () => { clearTimeout(kickoff); clearInterval(timer); };
  }, [refresh, refreshBalance]);

  const demo = useMemo(() => IS_TESTNET && now > 0 ? demoLots(now, consumed) : [], [now, consumed]);
  const liveCatalog = selectLiveLots(liveLots, snapshot.positions, BigInt(now));
  const eligible = liveState === "ready" ? liveCatalog.executable : [];
  const positions = mode === "demo" ? stored.positions : byClaim((loadedOwner === address ? snapshot.holdings : []).filter(h => h.position.direction === 0)).map(heldPosition);
  // Chainlink reference prices for every live symbol on screen (display only).
  const [prices, setPrices] = useState<Map<string, StockPrice>>(new Map());
  // Warm every stock's Chainlink read while the pool loads, rather than after it.
  useEffect(() => { prefetchStockPrices(); }, []);
  const liveSymbols = [...new Set([...liveCatalog.catalog.map(l => l.symbol), ...positions.filter(p => p.source === "live").map(p => p.symbol)])].sort().join(",");
  useEffect(() => {
    if (!liveSymbols) return;
    let cancelled = false;
    const load = () => void Promise.all(liveSymbols.split(",").map(async s => [s, await stockPrice(s)] as const)).then(rows => {
      if (!cancelled) setPrices(new Map(rows.filter((r): r is readonly [string, StockPrice] => r[1] !== null)));
    });
    load();
    const timer = setInterval(load, 60_000);
    return () => { cancelled = true; clearInterval(timer); };
  }, [liveSymbols]);

  const marks = new Map<string, Mark>();
  for (const p of positions) {
    if (p.source === "demo") {
      const mark = demoMark(p.symbol, p.strike, p.expiryTs, now);
      marks.set(p.id, { value: mark.value * p.fills.reduce((s, f) => s + f.qty, 0), spot: mark.spot, marked: "model" });
    } else {
      const h = snapshot.holdings.find(h => h.positionId.toString() === p.lotId)!;
      // A sale quote is not a liquidation bid. No market P/L is invented.
      const raw = h.settled ? h.settlementValue : null;
      marks.set(p.id, { value: raw === null ? null : Number(formatUnits(raw, 6)), spot: prices.get(p.symbol)?.price ?? null, marked: h.settled ? "settlement" : "unavailable" });
    }
  }

  const buy = useCallback(async (lot: PoolLot, budget: number, kind: "rip" | "buy"): Promise<BuyResult> => {
    const lock = `${DEPLOYMENT.chainId}:${lot.source === "demo" ? "demo" : address}`;
    if (busy.current || purchaseLocks.has(lock)) return { ok: false, reason: "A purchase is already in progress." };
    if (![1, 5, 20].includes(budget)) return { ok: false, reason: "Choose a supported purchase amount." };
    if (lot.source !== selectedMode.current) return { ok: false, reason: "The pool changed. Choose your position again." };
    busy.current = true; purchaseLocks.add(lock); setTransaction(null);
    try {
      if (lot.source === "demo") {
        if (!IS_TESTNET) throw new Error("Demo is available only on test networks.");
        if (lot.availableUsd < budget) throw new Error("This simulated lot sold out. Choose another position.");
        setPhase("Pulling a simulated position");
        const fill: RipFill = { kind, qty: budget / lot.askPrice, paid: budget, at: Date.now() };
        const next = addFill(savedDemo.current, lot, fill);
        stored.save(next.positions); consume(lot.id, budget);
        return { ok: true, position: next.position, fill, lot };
      }
      const pool = DEPLOYMENT.contracts.ripPool;
      const quote = DEPLOYMENT.quote;
      const account = getAccount(config);
      if (!address || account.address !== address) throw new Error("Connect a wallet to buy a Rip.");
      if (account.chainId !== DEPLOYMENT.chainId) throw new Error(`Switch your wallet to ${DEPLOYMENT.chainName}.`);
      if (!pool || !quote || !supported) throw new Error("This network needs the upgraded, funded Rips pool before purchases can open.");
      const rpcMismatch = await rpcChainMismatch();
      if (rpcMismatch) throw new Error(rpcMismatch);
      const reviewed = snapshot.positions.find(p => p.id.toString() === lot.id)?.row;
      if (!reviewed) throw new Error("This position is no longer available. Refresh the pool.");
      const expectedInventory = inventoryCommitment(snapshot.batchId, snapshot.positions, BigInt(now));
      const paidRaw = BigInt(budget) * 10n ** BigInt(quote.decimals);
      const assertWallet = () => {
        if (!mounted.current) throw new Error("The purchase screen changed before submission. Return to Rips and retry.");
        const current = getAccount(config);
        if (current.address !== address || current.chainId !== DEPLOYMENT.chainId) throw new Error("The wallet or network changed. Reconnect and retry.");
      };
      const funds = await publicClient.readContract({ address: quote.token, abi: erc20Abi, functionName: "balanceOf", args: [address] });
      if (funds < paidRaw) throw new Error(`Insufficient ${quote.symbol}. You need ${budget} ${quote.symbol} plus ${IS_TESTNET ? "testnet ETH" : "ETH"} for gas.`);
      const allowance = await publicClient.readContract({ address: quote.token, abi: erc20Abi, functionName: "allowance", args: [address, pool] });
      if (allowance < paidRaw) {
        assertWallet(); setPhase("Approve the payment token in your wallet");
        const approval = await writeContractAsync({ account: address, chainId: DEPLOYMENT.chainId as 84532 | 8453, address: quote.token, abi: erc20Abi, functionName: "approve", args: [pool, approvalAmount(paidRaw, funds, quote.decimals)] });
        setTransaction(approval); setPhase("Waiting for token approval");
        const receipt = await waitForTransactionReceipt(config, { hash: approval, chainId: DEPLOYMENT.chainId as 84532 | 8453 });
        if (receipt.status !== "success") throw new Error("Token approval failed. No Rip was purchased.");
        // Load-balanced RPC nodes can lag the approval block; simulating against one would falsely revert.
        await retryRead(async () => {
          const visible = await publicClient.readContract({ address: quote.token, abi: erc20Abi, functionName: "allowance", args: [address, pool] });
          if (visible < paidRaw) throw new Error("Approval not visible yet.");
        }).catch(() => undefined);
      }
      assertWallet();
      // Refresh the exact quote AFTER approval; old quantities never silently become new ones.
      const row = await publicClient.readContract({ address: pool, abi: MarketRipPoolAbi, functionName: "position", args: [BigInt(lot.id)] });
      const chainTime = (await publicClient.getBlock()).timestamp;
      if (kind === "buy" && (row.unitsPerRip !== reviewed.unitsPerRip || row.quoteRef !== reviewed.quoteRef)) throw new Error("The quote changed. Refresh the pool and review the new quantity before retrying.");
      if (row.direction !== 0 || chainTime >= row.expiry || chainTime > row.quoteValidUntil || row.remainingUnits < row.unitsPerRip * BigInt(budget)) throw new Error("This position has no available liquidity at a current quote. Refresh the pool.");
      // A random pull commits to the pool's inventory as it is now, read just before
      // signing: a snapshot can be minutes old and any house quote refresh changes
      // the hash. Anything that changes after signing still reverts the purchase.
      const hashInput = kind === "rip"
        ? await publicClient.readContract({ address: pool, abi: MarketRipPoolAbi, functionName: "upInventoryHash" })
        : expectedInventory;
      setPhase("Confirm your purchase in your wallet");
      const request = kind === "rip"
        ? { address: pool, abi: MarketRipPoolAbi, functionName: "ripUp" as const, args: [hashInput] as const, account: address }
        : { address: pool, abi: MarketRipPoolAbi, functionName: "buyPosition" as const, args: [BigInt(lot.id), BigInt(budget), row.unitsPerRip, row.quoteRef] as const, account: address };
      if (request.functionName === "ripUp") await publicClient.simulateContract(request);
      else await publicClient.simulateContract(request);
      assertWallet();
      const hash = request.functionName === "ripUp"
        ? await writeContractAsync({ ...request, gas: withHeadroom(await publicClient.estimateContractGas(request)), chainId: DEPLOYMENT.chainId as 84532 | 8453 })
        : await writeContractAsync({ ...request, chainId: DEPLOYMENT.chainId as 84532 | 8453 });
      setTransaction(hash); setPhase("Waiting for purchase confirmation");
      const receipt = await retryRead(() => waitForTransactionReceipt(config, { hash, chainId: DEPLOYMENT.chainId as 84532 | 8453 }));
      const purchase = decodePurchase(receipt, pool, address, paidRaw);
      // The purchase is final from here; a failed follow-up read must not be reported as a failed purchase.
      const confirmed = <T,>(read: () => Promise<T>) => retryRead(read).catch(() => { throw new Error("Purchase confirmed on chain, but loading it failed. Use the receipt link below; reload My Rips to show it."); });
      // Only what the reveal needs; the purchase history reloads in the background below.
      // Load-balanced RPC nodes can trail the receipt's block, so re-read until the
      // purchased position is visible (about 8 seconds at most) before giving up.
      let next = await confirmed(() => loadSnapshot(address, false));
      for (let attempt = 0; attempt < 8 && !next.holdings.some(h => h.positionId === purchase.positionId); attempt++) {
        await new Promise(resolve => setTimeout(resolve, 1_000));
        next = await confirmed(() => loadSnapshot(address, false));
      }
      const holding = next.holdings.find(h => h.positionId === purchase.positionId);
      if (!holding) throw new Error("Purchase confirmed. Refresh My Rips to recover its on-chain position.");
      const position = heldPosition(holding);
      const actualLot = await confirmed(() => lotFor(purchase.positionId, holding.position));
      const block = await confirmed(() => publicClient.getBlock({ blockNumber: receipt.blockNumber }));
      const fill: RipFill = { kind, qty: Number(formatUnits(purchase.units, holding.unitDecimals)), paid: Number(formatUnits(purchase.usdcPaid, quote.decimals)), at: Number(block.timestamp) * 1000, signature: hash };
      if (owner.current === address) { setSnapshot(next); void refresh(); void refreshBalance(); }
      return { ok: true, position, fill, lot: actualLot };
    } catch (cause) { void refresh(); void refreshBalance(); return { ok: false, reason: purchaseError(cause) }; }
    finally { purchaseLocks.delete(lock); busy.current = false; if (mounted.current) setPhase("idle"); }
  }, [address, config, supported, writeContractAsync, stored, consume, refresh, refreshBalance, snapshot, now]);

  // Pools deployed before packs have no `supportsPacks`; they keep the single-stock Rip.
  const [packs, setPacks] = useState(false);
  useEffect(() => {
    const pool = DEPLOYMENT.contracts.ripPool;
    if (!pool) return;
    let live = true;
    publicClient.readContract({ address: pool, abi: MarketRipPoolAbi, functionName: "supportsPacks" })
      .then((v) => { if (live) setPacks(v); }, () => { if (live) setPacks(false); });
    return () => { live = false; };
  }, []);

  // Packs per transaction (`MAX_PACKS`); pools without `ripPacks` sell one at a time.
  const [maxPacks, setMaxPacks] = useState(1);
  const [house, setHouse] = useState<Address | null>(null);
  useEffect(() => {
    const pool = DEPLOYMENT.contracts.ripPool;
    if (!pool) return;
    let live = true;
    publicClient.readContract({ address: pool, abi: MarketRipPoolAbi, functionName: "MAX_PACKS" })
      .then((v) => { if (live) setMaxPacks(Number(v)); }, () => { if (live) setMaxPacks(1); });
    poolHouse().then((h) => { if (live) setHouse(h); }, () => undefined);
    return () => { live = false; };
  }, []);
  const packsLeft = packsAvailable(snapshot.positions, BigInt(now), address ?? null, house);

  // The operator can pause sales; say so before anyone tries. Older pools have no `paused`.
  const [paused, setPaused] = useState(false);
  useEffect(() => {
    const pool = DEPLOYMENT.contracts.ripPool;
    if (!pool) return;
    let live = true;
    const read = () => publicClient.readContract({ address: pool, abi: MarketRipPoolAbi, functionName: "paused" })
      .then((v) => { if (live) setPaused(v === true); }, () => { if (live) setPaused(false); });
    void read();
    const id = setInterval(() => void read(), 15_000);
    return () => { live = false; clearInterval(id); };
  }, []);

  /** One $1 pack across PACK_SIZE stocks, bound to the inventory read just before signing. */
  /** `count` $1 packs in one transaction (`ripPacks`), or one (`ripPack`) on pools without it. */
  const buyPack = useCallback(async (count = 1): Promise<PackResult> => {
    const lock = `${DEPLOYMENT.chainId}:${address}`;
    if (busy.current || purchaseLocks.has(lock)) return { ok: false, reason: "A purchase is already in progress." };
    busy.current = true; purchaseLocks.add(lock); setTransaction(null);
    try {
      const pool = DEPLOYMENT.contracts.ripPool;
      const quote = DEPLOYMENT.quote;
      const account = getAccount(config);
      if (!address || account.address !== address) throw new Error("Connect a wallet to buy a Rip.");
      if (account.chainId !== DEPLOYMENT.chainId) throw new Error(`Switch your wallet to ${DEPLOYMENT.chainName}.`);
      if (!pool || !quote || !supported || !packs) throw new Error("This network needs the pack-enabled Rips pool before packs can open.");
      const rpcMismatch = await rpcChainMismatch();
      if (rpcMismatch) throw new Error(rpcMismatch);
      if (count < 1 || count > maxPacks) throw new Error(`Choose between 1 and ${maxPacks} Rips.`);
      const paidRaw = 10n ** BigInt(quote.decimals) * BigInt(count);
      const funds = await publicClient.readContract({ address: quote.token, abi: erc20Abi, functionName: "balanceOf", args: [address] });
      if (funds < paidRaw) throw new Error(`Insufficient ${quote.symbol}. You need 1 ${quote.symbol} plus ${IS_TESTNET ? "testnet ETH" : "ETH"} for gas.`);
      const allowance = await publicClient.readContract({ address: quote.token, abi: erc20Abi, functionName: "allowance", args: [address, pool] });
      if (allowance < paidRaw) {
        setPhase("Approve the payment token in your wallet");
        const approval = await writeContractAsync({ account: address, chainId: DEPLOYMENT.chainId as 84532 | 8453, address: quote.token, abi: erc20Abi, functionName: "approve", args: [pool, approvalAmount(paidRaw, funds, quote.decimals)] });
        setTransaction(approval);
        const receipt = await waitForTransactionReceipt(config, { hash: approval, chainId: DEPLOYMENT.chainId as 84532 | 8453 });
        if (receipt.status !== "success") throw new Error("Token approval failed. Nothing was bought.");
        await retryRead(async () => {
          const visible = await publicClient.readContract({ address: quote.token, abi: erc20Abi, functionName: "allowance", args: [address, pool] });
          if (visible < paidRaw) throw new Error("Approval not visible yet.");
        }).catch(() => undefined);
      }
      // A quote refresh between reading the inventory hash and simulating makes the
      // check fail; nothing was signed yet, so re-read and try again (three times).
      let request;
      for (let attempt = 0; ; attempt++) {
        const inventory = await publicClient.readContract({ address: pool, abi: MarketRipPoolAbi, functionName: "upInventoryHash" });
        request = count > 1
          ? { address: pool, abi: MarketRipPoolAbi, functionName: "ripPacks" as const, args: [inventory, BigInt(count)] as const, account: address }
          : { address: pool, abi: MarketRipPoolAbi, functionName: "ripPack" as const, args: [inventory] as const, account: address };
        try { await publicClient.simulateContract(request); break; }
        catch (cause) {
          if (attempt >= 2 || !/QuoteChanged/.test(String((cause as Error)?.message ?? cause))) throw cause;
          await new Promise(resolve => setTimeout(resolve, 1_500));
        }
      }
      setPhase("Confirm your purchase in your wallet");
      const gas = withHeadroom(await publicClient.estimateContractGas(request));
      const hash = await writeContractAsync({ ...request, gas, chainId: DEPLOYMENT.chainId as 84532 | 8453 });
      setTransaction(hash);
      const receipt = await retryRead(() => waitForTransactionReceipt(config, { hash, chainId: DEPLOYMENT.chainId as 84532 | 8453 }));
      if (receipt.status !== "success") throw new Error("The pack transaction reverted on chain. Only gas was spent; no USDC moved.");
      const slices = decodePack(receipt, pool, address, PACK_SLICE_RAW, PACK_SIZE * count);
      const confirmed = <T,>(read: () => Promise<T>) => retryRead(read).catch(() => { throw new Error("Pack confirmed on chain, but loading it failed. Use the receipt link below; reload My Rips to show it."); });
      // Lagging RPC nodes: re-read until every slice's position is visible.
      const wanted = slices.map((s) => s.positionId);
      let next = await confirmed(() => loadSnapshot(address, false));
      for (let attempt = 0; attempt < 8 && !wanted.every((id) => next.holdings.some((h) => h.positionId === id)); attempt++) {
        await new Promise(resolve => setTimeout(resolve, 1_000));
        next = await confirmed(() => loadSnapshot(address, false));
      }
      const block = await confirmed(() => publicClient.getBlock({ blockNumber: receipt.blockNumber }));
      const pulls = await Promise.all(slices.map(async (slice) => {
        const holding = next.holdings.find((h) => h.positionId === slice.positionId);
        if (!holding) throw new Error("Pack confirmed. Refresh My Rips to recover its on-chain positions.");
        const fill: RipFill = { kind: "rip", qty: Number(formatUnits(slice.units, holding.unitDecimals)), paid: Number(formatUnits(slice.usdcPaid, quote.decimals)), at: Number(block.timestamp) * 1000, signature: hash };
        return { position: heldPosition(holding), fill, lot: await confirmed(() => lotFor(slice.positionId, holding.position)) };
      }));
      if (owner.current === address) { setSnapshot(next); void refresh(); void refreshBalance(); }
      return { ok: true, pulls, hash };
    } catch (cause) { void refresh(); void refreshBalance(); return { ok: false, reason: purchaseError(cause) }; }
    finally { purchaseLocks.delete(lock); busy.current = false; if (mounted.current) setPhase("idle"); }
  }, [address, config, supported, packs, maxPacks, writeContractAsync, refresh, refreshBalance]);

  const redeem = async (p: RipPosition): Promise<{ ok: boolean; reason?: string }> => {
    if (!p.live?.settled || p.live.heldRaw === "0" || !address) return { ok: false, reason: "No settled claim units are available to redeem." };
    if (getAccount(config).chainId !== DEPLOYMENT.chainId) return { ok: false, reason: `Switch to ${DEPLOYMENT.chainName}.` };
    const lock = `${DEPLOYMENT.chainId}:${address}`;
    if (purchaseLocks.has(lock)) return { ok: false, reason: "A transaction is already in progress." };
    purchaseLocks.add(lock);
    try {
      const rpcMismatch = await rpcChainMismatch();
      if (rpcMismatch) throw new Error(rpcMismatch);
      const request = { address: p.live.claims as `0x${string}`, abi: ErodoroVaultAbi, functionName: "redeem" as const, args: [BigInt(p.live.claimId) & ~1n, false, BigInt(p.live.heldRaw)] as const, account: address };
      await publicClient.simulateContract(request);
      const current = getAccount(config);
      if (current.address !== address || current.chainId !== DEPLOYMENT.chainId) throw new Error("Wallet changed. Reconnect and retry.");
      setPhase("Confirm redemption in your wallet");
      const hash = await writeContractAsync({ ...request, chainId: DEPLOYMENT.chainId as 84532 | 8453 });
      setTransaction(hash); setPhase("Waiting for redemption confirmation");
      const receipt = await waitForTransactionReceipt(config, { hash, chainId: DEPLOYMENT.chainId as 84532 | 8453 });
      if (receipt.status !== "success") throw new Error("Redemption reverted. Check the receipt before retrying.");
      await refresh(); return { ok: true };
    } catch (cause) { return { ok: false, reason: purchaseError(cause) }; }
    finally { purchaseLocks.delete(lock); setPhase("idle"); }
  };

  return { redeem, mode, modeReady, setMode, canSwitch: IS_TESTNET, lots: mode === "demo" ? demo : eligible,
    catalog: mode === "demo" ? demo : liveCatalog.catalog, liveLots: eligible, liveState, positions, otherModeCount: mode === "live" ? stored.positions.length : snapshot.holdings.length,
    marks, prices, now, balance: balanceOwner === address ? balance : null, error, supported, snapshot, refresh,
    buy: { buy, buyPack, packs: packs && mode === "live", packsLeft, maxPacks, paused: paused && mode === "live", signer: address ?? null, phase, transaction, wrongNetwork: !!address && chainId !== DEPLOYMENT.chainId } };
}
