"use client";

import { useState, useSyncExternalStore } from "react";
import { useQuery } from "@tanstack/react-query";
import { useAccount } from "wagmi";
import { waitForTransactionReceipt, writeContract } from "wagmi/actions";
import { encodeFunctionData, type Abi, type PublicClient } from "viem";
import { encodeAbiParameters, erc20Abi, formatUnits, isAddress, keccak256, parseAbi, toHex, zeroAddress, type Address, type Hash } from "viem";
import { MarketRipPoolAbi, ErodoroVaultAbi, FactoryAbi } from "@/lib/abis";
import { publicClient } from "@/lib/chain";
import { DEPLOYMENT } from "@/lib/deployment";
import { wagmiConfig } from "@/lib/wagmi";
import { marketExpiry } from "@/lib/market-expiry";
import { RIPS_STOCKS } from "@/lib/rips/base-stocks";
import { b20RevertMessage } from "@/lib/b20-errors";
import { PAUSE_TRANSFER } from "@/lib/use-b20";
import { STOCK_REGISTRY } from "@/lib/issuers";
import { downloadSafeBatch, readSafe, safeBatch } from "@/lib/safe-batch";
import { ConnectButton } from "@/components/connect-button";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

/**
 * The operator console for Rips: what the house wallet (`erodoro`, a multisig on
 * mainnet) and the quoter key do between deploys. Deliberately unlinked and
 * not indexed; the pool enforces every permission, so a visitor without a role
 * sees state and every write reverts. Each action is one transaction (or a
 * short, labelled sequence) the wallet confirms. When the house wallet is a
 * Safe, its actions are saved as one Safe batch for the signers instead.
 */
const CHAIN = DEPLOYMENT.chainId as 84532 | 8453;
const AGG_ABI = parseAbi([
  "function latestRoundData() view returns (uint80, int256, uint256, uint256, uint80)",
  "function getRoundData(uint80) view returns (uint80, int256, uint256, uint256, uint80)",
  "function decimals() view returns (uint8)",
]);
const ADAPTER_ABI = parseAbi(["function feed() view returns (address)"]);
const B20_STATUS_ABI = parseAbi(["function isPaused(uint8 feature) view returns (bool)", "function multiplier() view returns (uint256)"]);
const REGISTRY_ABI = parseAbi(["function getOracleParams(address token) view returns (uint256 multiplier, bool paused)"]);
const VAULT_BOOKS_ABI = parseAbi(["function tokenLocked(address collateral) view returns (uint256)"]);
const FALLBACK_ABI = parseAbi(["function requestIdFor(uint64 maturity, uint64 notBefore) view returns (bytes32)"]);
/** Testnet markets settle on a stand-in oracle anyone can post a price to. */
const TEST_ORACLE_ABI = parseAbi(["function setPrice(uint256 price, uint8 decimals, uint64 publishTime)"]);
const QUOTE_LIFETIME = 300n;
const subscribeNever = () => () => {};

/** A stock token's own refusal in plain words, else the first line of the error. */
const why = (e: unknown) => b20RevertMessage(e)
  ?? (/insufficient funds|gas required exceeds allowance/i.test(String(e)) ? "This wallet does not have enough ETH to pay for gas. Send it some ETH, then retry." : null)
  ?? (e instanceof Error ? e.message.split("\n")[0] : String(e));

/** One write: sent by the connected wallet, or encoded into a Safe batch. */
type Step = { label: string; to: Address; abi: Abi | readonly unknown[]; functionName: string; args: readonly unknown[] };

type Row = {
  id: bigint; symbol: string; stock: Address; house: boolean; seller: Address; claimId: bigint; strike: bigint; priceDecimals: number; expiry: number;
  unitsPerRip: bigint; quoteValidUntil: number; remaining: bigint; total: bigint; sold: bigint; buyers: bigint; settled: boolean;
};
type Snapshot = {
  pool: Address; vault: Address; factory: Address; operator: Address; quoter: Address; paused: boolean;
  activeBatch: bigint; nextBatch: bigint; batch: bigint; batchExpiry: number; rows: Row[]; now: number;
};

const short = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`;
const usd = (n: number) => `$${n.toLocaleString("en-US", { maximumFractionDigits: 2 })}`;
const when = (ts: number) => ts ? new Date(ts * 1000).toUTCString().replace(" GMT", " UTC") : "—";

async function load(pool: Address, view: bigint | null): Promise<Snapshot> {
  const read = <T,>(functionName: string, args: unknown[] = []) => publicClient.readContract({ address: pool, abi: MarketRipPoolAbi, functionName, args } as never) as Promise<T>;
  const [vault, factory, operator, quoter, paused, activeBatch, nextBatch, block] = await Promise.all([
    read<Address>("vault"), read<Address>("factory"), read<Address>("erodoro"), read<Address>("quoter"), read<boolean>("paused"),
    read<bigint>("activeBatchId"), read<bigint>("nextBatchId"), publicClient.getBlock(),
  ]);
  // The batch shown: the one picked, else the active one, else the newest.
  const latest = nextBatch > 1n ? nextBatch - 1n : 0n;
  const batch = view && view <= latest ? view : activeBatch || latest;
  const [batchExpiry, ids] = batch ? await Promise.all([read<bigint>("batchExpiry", [batch]), read<readonly bigint[]>("batchPositions", [batch])]) : [0n, [] as readonly bigint[]];
  const rows = await Promise.all(ids.map(async (id): Promise<Row> => {
    const p = await read<{ stock: Address; seller: Address; claimId: bigint; strike: bigint; priceDecimals: number; expiry: bigint; unitsPerRip: bigint; quoteValidUntil: bigint; remainingUnits: bigint; totalInventoryUnits: bigint; amountSold: bigint; buyerCount: bigint }>("position", [id]);
    const [symbol, settlement] = await Promise.all([
      publicClient.readContract({ address: p.stock, abi: erc20Abi, functionName: "symbol" }).catch(() => short(p.stock)),
      publicClient.readContract({ address: vault, abi: ErodoroVaultAbi, functionName: "settlementOf", args: [p.claimId & ~1n] }).catch(() => null),
    ]);
    return { id, symbol, stock: p.stock, house: p.seller.toLowerCase() === operator.toLowerCase(), seller: p.seller, claimId: p.claimId, strike: p.strike, priceDecimals: p.priceDecimals,
      expiry: Number(p.expiry), unitsPerRip: p.unitsPerRip, quoteValidUntil: Number(p.quoteValidUntil), remaining: p.remainingUnits, total: p.totalInventoryUnits, sold: p.amountSold, buyers: p.buyerCount,
      settled: !!(settlement as { settled?: boolean } | null)?.settled };
  }));
  return { pool, vault, factory, operator, quoter, paused, activeBatch, nextBatch, batch, batchExpiry: Number(batchExpiry), rows, now: Number(block.timestamp) };
}

type Health = { stock: Address; symbol: string; decimals: number; transfersPaused: boolean | null; pricePaused: boolean | null; multiplier: bigint | null; locked: bigint; held: bigint };

/**
 * What the stock issuers have done to the stocks this batch uses. Base's B20
 * docs warn that pauses, seizures, burns and multiplier changes arrive without
 * any user action. A seizure or burn from the vault shows as the vault holding
 * less than its books say is locked, whatever event the issuer emitted.
 */
async function stockHealth(vault: Address, stocks: { stock: Address; symbol: string }[]): Promise<Health[]> {
  return Promise.all(stocks.map(async ({ stock, symbol }) => {
    const [decimals, transfersPaused, oracle, multiplier, locked, held] = await Promise.all([
      publicClient.readContract({ address: stock, abi: erc20Abi, functionName: "decimals" }),
      publicClient.readContract({ address: stock, abi: B20_STATUS_ABI, functionName: "isPaused", args: [PAUSE_TRANSFER] }).catch(() => null),
      publicClient.readContract({ address: STOCK_REGISTRY, abi: REGISTRY_ABI, functionName: "getOracleParams", args: [stock] }).catch(() => null),
      publicClient.readContract({ address: stock, abi: B20_STATUS_ABI, functionName: "multiplier" }).catch(() => null),
      publicClient.readContract({ address: vault, abi: VAULT_BOOKS_ABI, functionName: "tokenLocked", args: [stock] }),
      publicClient.readContract({ address: stock, abi: erc20Abi, functionName: "balanceOf", args: [vault] }),
    ]);
    return { stock, symbol, decimals, transfersPaused, pricePaused: oracle ? oracle[1] : null, multiplier, locked, held };
  }));
}

/** The adapter's first Chainlink round at or after maturity whose previous round is before it. */
async function settlementRound(adapter: Address, maturity: number): Promise<bigint> {
  const feed = await publicClient.readContract({ address: adapter, abi: ADAPTER_ABI, functionName: "feed" });
  let [roundId, , , updatedAt] = await publicClient.readContract({ address: feed, abi: AGG_ABI, functionName: "latestRoundData" });
  if (updatedAt < BigInt(maturity)) throw new Error("No Chainlink round after maturity yet. Wait for the market to print, or use the fallback.");
  for (let steps = 0; steps < 500; steps++) {
    const [, , , prevUpdated] = await publicClient.readContract({ address: feed, abi: AGG_ABI, functionName: "getRoundData", args: [roundId - 1n] });
    if (prevUpdated < BigInt(maturity)) return roundId;
    roundId -= 1n; updatedAt = prevUpdated;
  }
  throw new Error("Maturity is too far back to find its round.");
}

/** Units of N sold per $1 from a Black-Scholes call premium (vol 50%), matching the seeding scripts. */
function unitsFromPremium(spot: number, strike: number, years: number, decimals: number, vol = 0.5) {
  const cdf = (x: number) => { const t = 1 / (1 + 0.2316419 * Math.abs(x)); const d = 0.3989423 * Math.exp(-x * x / 2); const p = d * t * (0.3193815 + t * (-0.3565638 + t * (1.781478 + t * (-1.821256 + t * 1.330274)))); return x > 0 ? 1 - p : p; };
  const d1 = (Math.log(spot / strike) + vol * vol * years / 2) / (vol * Math.sqrt(years)); const d2 = d1 - vol * Math.sqrt(years);
  const premium = Math.max(0.01, spot * cdf(d1) - strike * cdf(d2));
  return BigInt(Math.floor(10 ** decimals / premium));
}

export function OpsPanel() {
  const hydrated = useSyncExternalStore(subscribeNever, () => true, () => false);
  const { address, chainId } = useAccount();
  const pool = DEPLOYMENT.contracts.ripPool as Address | null;
  const [viewBatch, setViewBatch] = useState<bigint | null>(null);
  const status = useQuery({ queryKey: ["ops", pool, viewBatch?.toString()], queryFn: () => load(pool!, viewBatch), enabled: !!pool, refetchInterval: 15_000 });
  const snap = status.data ?? null;
  const batchStocks = snap ? [...new Map(snap.rows.map(r => [r.stock.toLowerCase(), { stock: r.stock, symbol: r.symbol }])).values()] : [];
  const health = useQuery({ queryKey: ["ops-health", snap?.vault, batchStocks.map(s => s.stock).join()], queryFn: () => stockHealth(snap!.vault, batchStocks), enabled: !!snap && batchStocks.length > 0, refetchInterval: 60_000 });
  const issues = (health.data ?? []).filter(h => h.transfersPaused || h.pricePaused || h.held < h.locked);
  const loadError = status.error ? (status.error instanceof Error ? status.error.message.split("\n")[0] : "Could not read the pool.") : "";
  const refresh = () => status.refetch();
  const [busy, setBusy] = useState(false);
  const [log, setLog] = useState<{ text: string; hash?: Hash; error?: boolean }[]>([]);
  const [prices, setPrices] = useState<Record<string, string>>({});
  const [testPrices, setTestPrices] = useState<Record<string, string>>({});
  const [newQuoter, setNewQuoter] = useState("");
  const [expiryDays, setExpiryDays] = useState("30");
  const [market, setMarket] = useState<{ stock: string; units: string }>({ stock: RIPS_STOCKS[0]?.address ?? "", units: "" });

  // A Safe operator: its signers act through Safe batches, never directly.
  const safe = useQuery({ queryKey: ["ops-safe", snap?.operator], queryFn: () => readSafe(publicClient as unknown as PublicClient, snap!.operator), enabled: !!snap, staleTime: 60_000 }).data ?? null;
  const signer = !!safe && !!address && safe.owners.some(o => o.toLowerCase() === address.toLowerCase());
  const isQuoter = !!snap && !!address && address.toLowerCase() === snap.quoter.toLowerCase();
  // A Safe signer acts as operator even when it is also the quoter key.
  const role = !snap || !address ? "viewer" : address.toLowerCase() === snap.operator.toLowerCase() || signer ? "operator" : isQuoter ? "quoter" : "viewer";
  /** Who holds the house's stock and claims: the Safe when there is one, else the connected operator key. */
  const houseWallet = (safe?.address ?? address) as Address | undefined;
  const say = (text: string, extra: { hash?: Hash; error?: boolean } = {}) => setLog(l => [{ text, ...extra }, ...l].slice(0, 30));

  /**
   * Runs labelled writes in order; stops and reports at the first failure. An
   * operator action with a Safe operator is saved as one atomic Safe batch for
   * the signers instead; the quoter key and permissionless calls still send.
   */
  const run = async (label: string, steps: Step[], who: "operator" | "quoter" | "anyone" = "anyone") => {
    if (busy) return;
    if (safe && (who === "operator" || (who === "quoter" && !isQuoter && signer))) {
      const file = downloadSafeBatch(safeBatch({ chainId: CHAIN, safe: safe.address, name: label, calls: steps.map(s => ({ label: s.label, to: s.to, data: encodeFunctionData({ abi: s.abi, functionName: s.functionName, args: s.args } as never) })) }));
      say(`${label}: saved ${file}. In Safe{Wallet}, open Apps → Transaction Builder, drop the file in, then collect ${safe.threshold} of ${safe.owners.length} signatures and execute.`);
      return;
    }
    setBusy(true);
    try {
      for (const step of steps) {
        say(`${label}: ${step.label}…`);
        const hash = await writeContract(wagmiConfig, { chainId: CHAIN, address: step.to, abi: step.abi, functionName: step.functionName, args: step.args } as never);
        const receipt = await waitForTransactionReceipt(wagmiConfig, { hash, chainId: CHAIN });
        if (receipt.status !== "success") throw new Error(`${step.label} reverted.`);
        say(`${label}: ${step.label} confirmed.`, { hash });
      }
    } catch (e) {
      say(`${label} failed: ${why(e)}`, { error: true });
    } finally { setBusy(false); void refresh(); }
  };
  const poolStep = (label: string, functionName: string, args: unknown[]): Step => ({ label, to: pool!, abi: MarketRipPoolAbi, functionName, args });

  if (!hydrated) return <p className="p-8">Loading…</p>;
  if (!pool) return <p className="p-8">No Rips pool is configured for {DEPLOYMENT.chainName}.</p>;

  const house = snap?.rows.filter(r => r.house) ?? [];
  const listings = snap?.rows.filter(r => !r.house) ?? [];
  const expired = !!snap && snap.batchExpiry > 0 && snap.now >= snap.batchExpiry;
  const pendingBatch = !!snap && snap.nextBatch - 1n > snap.activeBatch;

  const refreshAll = () => {
    const live = house.filter(r => r.expiry > (snap?.now ?? 0));
    if (!live.length || !snap) return;
    const validUntil = BigInt(snap.now) + QUOTE_LIFETIME;
    void run("Refresh quotes", live.map(r => {
      const price = Number(prices[r.id.toString()]);
      const units = price > 0 ? BigInt(Math.floor(10 ** 8 / price)) : r.unitsPerRip;
      return poolStep(`${r.symbol} at ${usd(10 ** 8 / Number(units))}/claim`, "setQuote", [r.id, units, validUntil, keccak256(toHex(`ops:${r.id}:${validUntil}`))]);
    }), "quoter");
  };

  const addMarket = async () => {
    const address = houseWallet;
    if (!snap || !address) return;
    const stock = market.stock as Address;
    const info = RIPS_STOCKS.find(s => s.address.toLowerCase() === stock.toLowerCase());
    const batch = snap.nextBatch - 1n;
    try {
      const [, cfg] = await publicClient.readContract({ address: snap.factory, abi: FactoryAbi, functionName: "activeSettlementConfiguration", args: [stock] }) as readonly [string, { oracle: Address; fallbackOracle: Address; feedId: `0x${string}`; settlementModel: number; fallbackDelay: bigint; priceDecimals: number; enabled: boolean }];
      if (!cfg.enabled || cfg.oracle === zeroAddress) throw new Error("This stock has no enabled settlement configuration in the factory.");
      if (CHAIN === 8453 && cfg.fallbackOracle === zeroAddress) throw new Error("Mainnet markets need a fallback oracle in the factory configuration.");
      const maturity = BigInt(await publicClient.readContract({ address: pool, abi: MarketRipPoolAbi, functionName: "batchExpiry", args: [batch] }) as bigint);
      if (!info?.chainlink) throw new Error("Pick one of the Chainlink-priced stocks.");
      const [, answer] = await publicClient.readContract({ address: info.chainlink, abi: AGG_ABI, functionName: "latestRoundData" });
      const spot = answer as bigint;
      const strike = (spot * 105n + 99n) / 100n;
      const decimals = Number(await publicClient.readContract({ address: stock, abi: erc20Abi, functionName: "decimals" }));
      const units = market.units ? BigInt(Math.floor(Number(market.units) * 10 ** decimals)) : unitsFromPremium(Number(spot) / 1e8, Number(strike) / 1e8, Number(maturity - BigInt(snap.now)) / (365 * 86400), decimals);
      const inventory = units * 5n;
      const settlementDelay = 60n, maxPriceLag = 4n * 3600n;
      const notBefore = maturity + (settlementDelay > maxPriceLag ? settlementDelay : maxPriceLag) + cfg.fallbackDelay;
      const fallbackRequestId = cfg.fallbackOracle === zeroAddress ? `0x${"00".repeat(32)}` as `0x${string}` : await publicClient.readContract({ address: cfg.fallbackOracle, abi: FALLBACK_ABI, functionName: "requestIdFor", args: [maturity, notBefore] });
      const params = { collateral: stock, oracle: cfg.oracle, fallbackOracle: cfg.fallbackOracle, feeRecipient: address, feedId: cfg.feedId, fallbackRequestId, settlementModel: cfg.settlementModel,
        strike, minSplitAmount: 0n, maturity, settlementDelay, maxPriceLag, fallbackDelay: cfg.fallbackDelay, maxConfBps: 0, feeBps: 0, priceDecimals: cfg.priceDecimals, admin: address };
      const seriesId = await publicClient.readContract({ address: snap.vault, abi: ErodoroVaultAbi, functionName: "seriesIdFor", args: [snap.factory, params] } as never) as bigint;
      const exists = (await publicClient.readContract({ address: snap.vault, abi: ErodoroVaultAbi, functionName: "seriesConfig", args: [seriesId] }) as { exists: boolean }).exists;
      const operatorSet = await publicClient.readContract({ address: snap.vault, abi: ErodoroVaultAbi, functionName: "isOperator", args: [address, pool] });
      const held = await publicClient.readContract({ address: stock, abi: erc20Abi, functionName: "balanceOf", args: [address] });
      if (held < inventory) throw new Error(`The house wallet holds ${formatUnits(held, decimals)} ${info.symbol}; this market needs ${formatUnits(inventory, decimals)}.`);
      const validUntil = BigInt(snap.now) + QUOTE_LIFETIME;
      await run(`Add ${info.ticker}`, [
        ...(exists ? [] : [{ label: "create series", to: snap.factory, abi: FactoryAbi, functionName: "createSeries", args: [params, address] }]),
        { label: `approve ${formatUnits(inventory, decimals)} ${info.symbol}`, to: stock, abi: erc20Abi, functionName: "approve", args: [snap.vault, inventory] },
        { label: "lock in the vault (split)", to: snap.vault, abi: ErodoroVaultAbi, functionName: "split", args: [seriesId, inventory] },
        ...(operatorSet ? [] : [{ label: "let the pool move claims", to: snap.vault, abi: ErodoroVaultAbi, functionName: "setOperator", args: [pool, true] }]),
        poolStep("add the house market", "addPosition", [{ batchId: batch, stock, direction: 0, claimId: seriesId | 1n, spotAtCreation: spot, unitsPerRip: units, quoteValidUntil: validUntil, quoteRef: keccak256(toHex(`ops:add:${info.ticker}:${validUntil}`)) }]),
      ], "operator");
    } catch (e) { say(`Add market failed: ${why(e)}`, { error: true }); }
  };

  /** Testnet: post the typed price to the stand-in oracle, stamped at maturity, then settle on it. */
  const settleAtTestPrice = async (r: Row) => {
    if (!snap) return;
    const seriesId = r.claimId & ~1n;
    const typed = Number(testPrices[r.id.toString()]);
    if (!(typed > 0)) { say(`Settle ${r.symbol}: enter the test price at expiry first.`, { error: true }); return; }
    try {
      const cfg = await publicClient.readContract({ address: snap.vault, abi: ErodoroVaultAbi, functionName: "seriesConfig", args: [seriesId] }) as { oracle: Address; maturity: bigint };
      const price = BigInt(Math.round(typed * 10 ** r.priceDecimals));
      await run(`Settle ${r.symbol} at test price ${usd(typed)}`, [
        { label: "post test price", to: cfg.oracle, abi: TEST_ORACLE_ABI, functionName: "setPrice", args: [price, r.priceDecimals, cfg.maturity] },
        { label: "settle", to: snap.vault, abi: ErodoroVaultAbi, functionName: "settle", args: [seriesId, []] },
      ]);
    } catch (e) { say(`Settle ${r.symbol} failed: ${why(e)}`, { error: true }); }
  };

  const settle = async (r: Row, fallback: boolean) => {
    if (!snap) return;
    const seriesId = r.claimId & ~1n;
    try {
      if (fallback) {
        await run(`Settle ${r.symbol} (fallback)`, [{ label: "settleFallback", to: snap.vault, abi: ErodoroVaultAbi, functionName: "settleFallback", args: [seriesId, "0x"] }]);
        return;
      }
      const cfg = await publicClient.readContract({ address: snap.vault, abi: ErodoroVaultAbi, functionName: "seriesConfig", args: [seriesId] }) as { oracle: Address; maturity: bigint };
      const round = await settlementRound(cfg.oracle, Number(cfg.maturity));
      await run(`Settle ${r.symbol} (Chainlink round ${round})`, [{ label: "settle", to: snap.vault, abi: ErodoroVaultAbi, functionName: "settle", args: [seriesId, [encodeAbiParameters([{ type: "uint80" }], [round])]] }]);
    } catch (e) { say(`Settle ${r.symbol} failed: ${why(e)}`, { error: true }); }
  };

  /** After settlement, the house wallet redeems the P it kept and any N it got back for the stock owed. */
  const redeemHouse = async (r: Row) => {
    if (!snap) return;
    const seriesId = r.claimId & ~1n;
    const balanceOf = (id: bigint) => publicClient.readContract({ address: snap.vault, abi: ErodoroVaultAbi, functionName: "balanceOf", args: [r.seller, id] }) as Promise<bigint>;
    const [p, n] = await Promise.all([balanceOf(seriesId), balanceOf(r.claimId)]);
    const redeem = (isP: boolean, amount: bigint): Step => ({ label: `redeem ${isP ? "P" : "N"}`, to: snap.vault, abi: ErodoroVaultAbi, functionName: "redeem", args: [seriesId, isP, amount] });
    const steps = [...(p > 0n ? [redeem(true, p)] : []), ...(n > 0n ? [redeem(false, n)] : [])];
    if (!steps.length) { say(`Redeem ${r.symbol}: the house holds no claims in the series.`); return; }
    await run(`Redeem ${r.symbol}`, steps, "operator");
  };

  const card = "border-line/70 bg-panel rounded-2xl border p-5";
  const pill = (ok: boolean, text: string) => <span className={`rounded-full px-2 py-0.5 text-xs ${ok ? "bg-emerald-500/15 text-emerald-700 dark:text-emerald-300" : "bg-danger/10 text-danger"}`}>{text}</span>;
  const can = (who: "operator" | "quoter") => role === "operator" || (who === "quoter" && role === "quoter");

  return (
    <main className="mx-auto w-full max-w-5xl px-4 py-8">
      <header className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <p className="text-muted text-xs tracking-wide uppercase">Operator console · {DEPLOYMENT.chainName}</p>
          <h1 className="font-display text-3xl font-semibold tracking-[-0.04em]">Rips operations</h1>
          <p className="text-muted mt-1 text-sm">Not linked anywhere. The pool checks every permission; without a role you can only read.</p>
        </div>
        <div className="flex items-center gap-3"><span className="text-muted text-sm">Role: <b className="text-text">{role}</b></span><ConnectButton /></div>
      </header>
      {chainId && chainId !== CHAIN && <p role="alert" className="text-danger mt-4 text-sm">Switch the wallet to {DEPLOYMENT.chainName}.</p>}
      {loadError && <p role="alert" className="text-danger mt-4 text-sm">{loadError}</p>}
      {!snap && !loadError && <p className="text-muted mt-6 text-sm">Reading the pool…</p>}

      {snap && <>
        <section className={`${card} mt-6 grid gap-x-8 gap-y-2 text-sm sm:grid-cols-2`} aria-label="Pool status">
          <p>Pool <code>{short(snap.pool)}</code></p>
          <p>Sales {pill(!snap.paused, snap.paused ? "paused" : "open")}</p>
          <p>Operator <code>{short(snap.operator)}</code> {safe ? pill(safe.threshold >= 2, `Safe · ${safe.threshold} of ${safe.owners.length}`) : pill(CHAIN !== 8453, "single key")}</p>
          {CHAIN === 8453 && (!safe || safe.threshold < 2) && <p role="alert" className="text-danger sm:col-span-2">Mainnet needs the operator to be a Safe that takes at least 2 signatures. This pool&apos;s operator cannot be changed; redeploy it with a Safe.</p>}
          {safe && <p className="text-muted text-xs sm:col-span-2">{signer ? "You are a signer. " : ""}Operator actions save a Safe batch file; quote refreshes and settlement still send directly.</p>}
          <p>Quoter <code>{snap.quoter === zeroAddress ? "none" : short(snap.quoter)}</code></p>
          <p>Active batch #{snap.activeBatch.toString()}{pendingBatch && ` · batch #${(snap.nextBatch - 1n).toString()} not yet active`}</p>
          <p className="flex items-center gap-2">Showing batch
            <select aria-label="Batch to show" className="border-line bg-bg h-8 rounded-sm border px-2" value={snap.batch.toString()} onChange={e => setViewBatch(BigInt(e.target.value))}>
              {Array.from({ length: Math.max(0, Number(snap.nextBatch) - 1) }, (_, i) => BigInt(i + 1)).map(b => <option key={b.toString()} value={b.toString()}>#{b.toString()}{b === snap.activeBatch ? " (active)" : ""}</option>)}
            </select>
            · expires {when(snap.batchExpiry)} {expired && pill(false, "expired")}</p>
        </section>

        <section className={`${card} mt-4`} aria-label="Sales controls">
          <h2 className="font-display text-lg font-semibold">Sales</h2>
          <div className="mt-3 flex flex-wrap items-center gap-2">
            <Button variant="outline" disabled={busy || !can("quoter") || snap.paused} onClick={() => void run("Pause", [poolStep("pause sales", "setPaused", [true])], "quoter")}>Pause sales</Button>
            <Button variant="outline" disabled={busy || role !== "operator" || !snap.paused} onClick={() => void run("Resume", [poolStep("resume sales", "setPaused", [false])], "operator")}>Resume sales</Button>
            <Input aria-label="New quoter address" placeholder="Quoter address (0x…, or 0x0 to remove)" className="h-9 max-w-sm" value={newQuoter} onChange={e => setNewQuoter(e.target.value.trim())} />
            <Button variant="outline" disabled={busy || role !== "operator" || !isAddress(newQuoter)} onClick={() => void run("Set quoter", [poolStep(`quoter → ${short(newQuoter)}`, "setQuoter", [newQuoter])], "operator")}>Set quoter</Button>
          </div>
          <p className="text-muted mt-2 text-xs">The quoter can pause; only the operator resumes or changes the quoter.</p>
        </section>

        <section className={`${card} mt-4`} aria-label="House quotes">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h2 className="font-display text-lg font-semibold">House markets · batch #{snap.batch.toString()}</h2>
            <Button disabled={busy || !can("quoter") || !house.length} onClick={refreshAll}>Refresh all quotes (5 min)</Button>
          </div>
          <div className="mt-3 overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="text-muted text-left text-xs"><tr><th className="py-2">#</th><th>Stock</th><th>Strike</th><th>Price / claim</th><th>Quote</th><th>Left</th><th>Sold</th><th>New price</th><th>Settlement</th></tr></thead>
              <tbody>{house.map(r => {
                const fresh = r.quoteValidUntil >= snap.now;
                const price = 10 ** 8 / Number(r.unitsPerRip);
                return (
                  <tr key={r.id.toString()} className="border-line/60 border-t">
                    <td className="py-2">{r.id.toString()}</td>
                    <td>{r.symbol}</td>
                    <td>{usd(Number(r.strike) / 10 ** r.priceDecimals)}</td>
                    <td>{usd(price)}</td>
                    <td>{pill(fresh, fresh ? `${Math.max(0, r.quoteValidUntil - snap.now)}s left` : "stale")}</td>
                    <td>{usd(Number(r.remaining) / Number(r.unitsPerRip))}</td>
                    <td>{usd(Number(r.sold) / 1e6)} · {r.buyers.toString()}</td>
                    <td><Input aria-label={`New price per claim for ${r.symbol}`} placeholder={price.toFixed(2)} className="h-8 w-24" value={prices[r.id.toString()] ?? ""} onChange={e => setPrices(p => ({ ...p, [r.id.toString()]: e.target.value }))} /></td>
                    <td className="space-x-1 whitespace-nowrap">
                      {r.settled ? pill(true, "settled") : !expired ? <span className="text-muted text-xs">at expiry</span> : CHAIN !== 8453 ? <>
                        <Input aria-label={`Test price at expiry for ${r.symbol}`} placeholder="Test price" className="inline-flex h-7 w-24" value={testPrices[r.id.toString()] ?? ""} onChange={e => setTestPrices(p => ({ ...p, [r.id.toString()]: e.target.value }))} />
                        <Button size="xs" variant="outline" disabled={busy} onClick={() => void settleAtTestPrice(r)}>Settle</Button>
                      </> : <>
                        <Button size="xs" variant="outline" disabled={busy} onClick={() => void settle(r, false)}>Chainlink</Button>
                        <Button size="xs" variant="outline" disabled={busy} onClick={() => void settle(r, true)}>Fallback</Button>
                      </>}
                      {expired && r.remaining > 0n && <Button size="xs" variant="outline" disabled={busy || role !== "operator"} onClick={() => void run(`Return ${r.symbol}`, [poolStep("return unsold inventory", "returnExpiredInventory", [r.id])], "operator")}>Return unsold</Button>}
                      {r.settled && (() => { const holder = address?.toLowerCase() === r.seller.toLowerCase() || (signer && safe?.address.toLowerCase() === r.seller.toLowerCase()); return <Button size="xs" variant="outline" disabled={busy || !holder} title={holder ? undefined : "Only the house wallet that holds these claims can redeem them."} onClick={() => void redeemHouse(r)}>Redeem</Button>; })()}
                    </td>
                  </tr>
                );
              })}</tbody>
            </table>
            {!house.length && <p className="text-muted py-4 text-sm">No house markets in the latest batch.</p>}
          </div>
          {listings.length > 0 && <p className="text-muted mt-3 text-xs">Seller listings in this batch: {listings.map(l => `${l.symbol} by ${short(l.seller)} (${usd(Number(l.sold) / 1e6)} sold)`).join(" · ")}</p>}
        </section>

        <section className={`${card} mt-4`} aria-label="Stock health">
          <h2 className="font-display text-lg font-semibold">Stock health</h2>
          <p className="text-muted mt-1 text-xs">Issuer actions on this batch&apos;s stocks. A vault holding less than it has locked means units were seized or burned from it.</p>
          {issues.length > 0 && <p role="alert" className="text-danger mt-3 text-sm">Needs attention: {issues.map(h => h.symbol).join(", ")}.</p>}
          {health.error && <p role="alert" className="text-danger mt-3 text-sm">Could not read stock status: {why(health.error)}</p>}
          <table className="mt-3 w-full text-left text-sm tabular-nums">
            <thead className="text-muted text-xs"><tr><th className="py-1">Stock</th><th>Transfers</th><th>Coinbase price</th><th>Shares per token</th><th>Vault holds / locked</th></tr></thead>
            <tbody>{(health.data ?? []).map(h => <tr key={h.stock} className="border-line/60 border-t">
              <td className="py-2">{h.symbol}</td>
              <td>{h.transfersPaused === null ? <span className="text-muted text-xs">n/a</span> : pill(!h.transfersPaused, h.transfersPaused ? "paused" : "open")}</td>
              <td>{h.pricePaused === null ? <span className="text-muted text-xs">n/a</span> : pill(!h.pricePaused, h.pricePaused ? "paused (corporate action)" : "live")}</td>
              <td>{h.multiplier === null ? "—" : (Number(h.multiplier) / 1e18).toFixed(6)}</td>
              <td>{formatUnits(h.held, h.decimals)} / {formatUnits(h.locked, h.decimals)} {h.held < h.locked && pill(false, `short ${formatUnits(h.locked - h.held, h.decimals)}`)}</td>
            </tr>)}</tbody>
          </table>
          {health.isLoading && <p className="text-muted py-2 text-sm">Reading stock status…</p>}
        </section>

        <section className={`${card} mt-4`} aria-label="New batch">
          <h2 className="font-display text-lg font-semibold">New batch</h2>
          {CHAIN !== 8453 ? (
            // House markets read Base mainnet stocks and Chainlink feeds; Testnet batches are test tokens made by script.
            <p className="text-muted mt-1 text-sm">Testnet batches use test stocks and are created with <code className="text-xs">node scripts/rips-sepolia.mjs batch</code>.</p>
          ) : <>
          <p className="text-muted mt-1 text-sm">1. Create the batch. 2. Add ten house markets (the house wallet must hold the stock). 3. Activate.</p>
          <div className="mt-3 flex flex-wrap items-center gap-2">
            <Input aria-label="Days until expiry" className="h-9 w-20" value={expiryDays} onChange={e => setExpiryDays(e.target.value)} />
            <span className="text-muted text-sm">days → {(() => { try { return when(marketExpiry(snap.now, Number(expiryDays))); } catch (e) { return e instanceof Error ? e.message : ""; } })()}</span>
            <Button variant="outline" disabled={busy || role !== "operator"} onClick={() => { try { const expiry = marketExpiry(snap.now, Number(expiryDays)); void run("Create batch", [poolStep(`expiry ${when(expiry)}`, "createBatch", [BigInt(expiry)])], "operator"); } catch (e) { say(e instanceof Error ? e.message : String(e), { error: true }); } }}>Create batch</Button>
          </div>
          <div className="mt-3 flex flex-wrap items-center gap-2">
            <select aria-label="Stock for the house market" className="border-line bg-bg h-9 rounded-sm border px-2 text-sm" value={market.stock} onChange={e => setMarket(m => ({ ...m, stock: e.target.value }))}>
              {RIPS_STOCKS.map(s => <option key={s.address} value={s.address}>{s.symbol}</option>)}
            </select>
            <Input aria-label="Claims per $1 (optional)" placeholder="Claims per $1 (auto)" className="h-9 w-44" value={market.units} onChange={e => setMarket(m => ({ ...m, units: e.target.value }))} />
            <Button variant="outline" disabled={busy || role !== "operator" || !pendingBatch} onClick={() => void addMarket()}>Add house market</Button>
            <Button disabled={busy || role !== "operator" || !pendingBatch} onClick={() => void run("Activate", [poolStep(`activate batch #${(snap.nextBatch - 1n).toString()}`, "activateBatch", [snap.nextBatch - 1n])], "operator")}>Activate batch</Button>
          </div>
          <p className="text-muted mt-2 text-xs">Strike is spot + 5% from the stock&apos;s Chainlink feed; the default price is a Black-Scholes premium at 50% vol. Oracle, fallback and feed come from the factory&apos;s settlement configuration for the stock.</p>
          </>}
        </section>
      </>}

      <section className={`${card} mt-4`} aria-label="Activity">
        <h2 className="font-display text-lg font-semibold">Activity</h2>
        {!log.length && <p className="text-muted mt-2 text-sm">Nothing yet.</p>}
        <ul className="mt-2 space-y-1 text-sm">{log.map((l, i) => <li key={i} className={l.error ? "text-danger" : ""}>{l.text}{l.hash && <code className="text-muted ml-2 text-xs">{short(l.hash)}</code>}</li>)}</ul>
      </section>
    </main>
  );
}
