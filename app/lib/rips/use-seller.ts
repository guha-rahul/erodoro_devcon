"use client";

import { useCallback, useEffect, useState } from "react";
import { b20RevertMessage } from "@/lib/b20-errors";
import { useAccount, useConfig, useWriteContract } from "wagmi";
import { getAccount, waitForTransactionReceipt } from "wagmi/actions";
import { erc20Abi, formatUnits, parseAbi, parseUnits, type Address, type Hash } from "viem";
import { MarketRipPoolAbi, ErodoroVaultAbi, IB20AssetAbi } from "../abis";
import { publicClient, rpcChainMismatch } from "../chain";
import { DEPLOYMENT, IS_TESTNET } from "../deployment";
import { lotFor, poolHouse, type Position } from "./live";
import { retryRead } from "./use-rips";

const CHAIN = DEPLOYMENT.chainId as 84532 | 8453;
// Testnet fixture stocks expose an open mint so anyone can try depositing.
const TEST_MINT_ABI = parseAbi(["function mint(address to, uint256 amount)"]);

/** A house market a seller can lock stock into. */
export type SellMarket = {
  templateId: bigint; symbol: string; name: string; stock: Address; strike: number; expiryTs: number;
  decimals: number; stockBalance: bigint; houseUnitsPerRip: bigint;
  /** The token's own symbol (e.g. NVDAc): amounts here are token units, not shares. */
  tokenSymbol: string;
  /** B20 shares per token (1e18 = 1:1), or null for a token without one. */
  multiplier: bigint | null;
};

/** One of the connected seller's listings, with what it has earned. */
export type SellerListing = {
  id: bigint; symbol: string; name: string; stock: Address; claims: Address; seriesId: bigint; claimId: bigint; decimals: number; strike: number; expiryTs: number;
  unitsPerRip: bigint; remaining: bigint; total: bigint; earnedRaw: bigint; buyers: bigint;
  pHeld: bigint; nHeld: bigint; settled: boolean;
};

type Phase = string | null;

/** Reads and actions for a seller who locks stock into Rips and is paid per sale. */
export function useSeller() {
  const { address } = useAccount();
  const config = useConfig();
  const { writeContractAsync } = useWriteContract();
  const pool = DEPLOYMENT.contracts.ripPool;
  const quote = DEPLOYMENT.quote;
  const [markets, setMarkets] = useState<SellMarket[]>([]);
  const [listings, setListings] = useState<SellerListing[]>([]);
  const [usdcBalance, setUsdcBalance] = useState<bigint | null>(null);
  const [state, setState] = useState<"loading" | "ready" | "error" | "unsupported">("loading");
  const [phase, setPhase] = useState<Phase>(null);
  const [transaction, setTransaction] = useState<Hash | null>(null);

  const refresh = useCallback(async () => {
    if (!pool) { setState("unsupported"); return; }
    try {
      const { nextMarkets, nextListings, balance } = await retryRead(async () => {
        // Older pools have no seller listings; their position rows lack `seller`.
        await publicClient.readContract({ address: pool, abi: MarketRipPoolAbi, functionName: "listingNonce" });
        const house = await poolHouse();
        const batchId = await publicClient.readContract({ address: pool, abi: MarketRipPoolAbi, functionName: "activeBatchId" });
        const ids = batchId === 0n ? [] : await publicClient.readContract({ address: pool, abi: MarketRipPoolAbi, functionName: "batchPositions", args: [batchId] });
        const rows = await Promise.all(ids.map(async id => ({ id, row: await publicClient.readContract({ address: pool, abi: MarketRipPoolAbi, functionName: "position", args: [id] }) as unknown as Position })));
        const houseRows = rows.filter(({ row }) => row.direction === 0 && row.seller.toLowerCase() === house.toLowerCase());
        const nextMarkets = await Promise.all(houseRows.map(async ({ id, row }) => {
          const [lot, decimals, stockBalance, tokenSymbol, multiplier] = await Promise.all([
            lotFor(id, row),
            publicClient.readContract({ address: row.stock, abi: erc20Abi, functionName: "decimals" }),
            address ? publicClient.readContract({ address: row.stock, abi: erc20Abi, functionName: "balanceOf", args: [address] }) : Promise.resolve(0n),
            publicClient.readContract({ address: row.stock, abi: erc20Abi, functionName: "symbol" }),
            // Dividends and splits move a B20's multiplier; a token without one is 1:1.
            publicClient.readContract({ address: row.stock, abi: IB20AssetAbi, functionName: "multiplier" }).then(m => m as bigint).catch(() => null),
          ]);
          return { templateId: id, symbol: lot.symbol, name: lot.name, stock: row.stock, strike: lot.strike, expiryTs: lot.expiryTs, decimals, stockBalance, houseUnitsPerRip: row.unitsPerRip, tokenSymbol, multiplier };
        }));
        const mine = address ? await publicClient.readContract({ address: pool, abi: MarketRipPoolAbi, functionName: "sellerPositions", args: [address] }) : [];
        const nextListings = await Promise.all([...mine].reverse().map(async (id): Promise<SellerListing> => {
          const row = await publicClient.readContract({ address: pool, abi: MarketRipPoolAbi, functionName: "position", args: [id] }) as unknown as Position;
          const seriesId = row.claimId & ~1n;
          const [lot, cfg, settlement, pHeld, nHeld] = await Promise.all([
            lotFor(id, row),
            publicClient.readContract({ address: row.claims, abi: ErodoroVaultAbi, functionName: "seriesConfig", args: [seriesId] }),
            publicClient.readContract({ address: row.claims, abi: ErodoroVaultAbi, functionName: "settlementOf", args: [seriesId] }),
            publicClient.readContract({ address: row.claims, abi: ErodoroVaultAbi, functionName: "balanceOf", args: [address!, seriesId] }),
            publicClient.readContract({ address: row.claims, abi: ErodoroVaultAbi, functionName: "balanceOf", args: [address!, row.claimId] }),
          ]);
          return { id, symbol: lot.symbol, name: lot.name, stock: row.stock, claims: row.claims, seriesId, claimId: row.claimId, decimals: cfg.collateralDecimals, strike: lot.strike, expiryTs: lot.expiryTs,
            unitsPerRip: row.unitsPerRip, remaining: row.remainingUnits, total: row.totalInventoryUnits, earnedRaw: row.amountSold, buyers: row.buyerCount,
            pHeld, nHeld, settled: settlement.settled };
        }));
        const balance = address && quote ? await publicClient.readContract({ address: quote.token, abi: erc20Abi, functionName: "balanceOf", args: [address] }) : null;
        return { nextMarkets, nextListings, balance };
      });
      setMarkets(nextMarkets); setListings(nextListings); setUsdcBalance(balance); setState("ready");
    } catch {
      setState(prev => prev === "ready" ? "error" : "unsupported");
    }
  }, [address, pool, quote]);

  useEffect(() => { const t = setTimeout(() => void refresh(), 0); return () => clearTimeout(t); }, [refresh]);

  /** Sends one wallet transaction and waits for its successful receipt. */
  const send = useCallback(async (label: string, request: Parameters<typeof writeContractAsync>[0]) => {
    if (!address) throw new Error("Connect a wallet first.");
    if (getAccount(config).chainId !== DEPLOYMENT.chainId) throw new Error(`Switch your wallet to ${DEPLOYMENT.chainName}.`);
    setPhase(`${label}: confirm in your wallet`);
    const hash = await writeContractAsync({ ...request, chainId: CHAIN } as Parameters<typeof writeContractAsync>[0]);
    setTransaction(hash); setPhase(`${label}: waiting for confirmation`);
    const receipt = await retryRead(() => waitForTransactionReceipt(config, { hash, chainId: CHAIN }));
    if (receipt.status !== "success") throw new Error(`${label} reverted. Nothing further was submitted.`);
    return hash;
  }, [address, config, writeContractAsync]);

  const run = useCallback(async (work: () => Promise<string>): Promise<{ ok: true; message: string } | { ok: false; message: string }> => {
    try {
      const mismatch = await rpcChainMismatch();
      if (mismatch) throw new Error(mismatch);
      const message = await work();
      await refresh();
      // Load-balanced RPC nodes can trail the confirmed block; read again shortly.
      setTimeout(() => void refresh(), 4000);
      return { ok: true, message };
    } catch (cause) {
      const text = cause instanceof Error ? cause.message : String(cause);
      const message = /reject|denied|4001|cancel/i.test(text) ? "Signing was cancelled. Nothing was submitted." : b20RevertMessage(cause) ?? text.split("\n")[0].slice(0, 240);
      void refresh();
      return { ok: false, message };
    } finally { setPhase(null); }
  }, [refresh]);

  /** Approve exactly `collateral` stock to the pool, then lock it and list N. */
  const list = (market: SellMarket, collateral: bigint, unitsPerRip: bigint) => run(async () => {
    if (!pool) throw new Error("No Rips pool is configured.");
    const balance = await publicClient.readContract({ address: market.stock, abi: erc20Abi, functionName: "balanceOf", args: [address!] });
    if (balance < collateral) throw new Error(`You hold ${formatUnits(balance, market.decimals)} ${market.symbol}.`);
    const allowance = await publicClient.readContract({ address: market.stock, abi: erc20Abi, functionName: "allowance", args: [address!, pool] });
    if (allowance < collateral) {
      await send(`Approve ${market.symbol}`, { address: market.stock, abi: erc20Abi, functionName: "approve", args: [pool, collateral] });
      // A lagging RPC node must not make the listing simulation fail.
      await retryRead(async () => {
        const visible = await publicClient.readContract({ address: market.stock, abi: erc20Abi, functionName: "allowance", args: [address!, pool] });
        if (visible < collateral) throw new Error("Approval not visible yet.");
      }).catch(() => undefined);
    }
    await publicClient.simulateContract({ account: address!, address: pool, abi: MarketRipPoolAbi, functionName: "lockAndList", args: [market.templateId, collateral, unitsPerRip] });
    await send("Lock and list", { address: pool, abi: MarketRipPoolAbi, functionName: "lockAndList", args: [market.templateId, collateral, unitsPerRip] });
    return `Locked ${formatUnits(collateral, market.decimals)} ${market.symbol} and listed it. You keep the P claim; buyers pay you directly.`;
  });

  /** Testnet only: mint `whole` test shares of the market's stock to the connected wallet. */
  const getTestStock = (market: SellMarket, whole: number) => run(async () => {
    if (!IS_TESTNET) throw new Error("Test stock is only available on testnet.");
    await send(`Get test ${market.symbol}`, { address: market.stock, abi: TEST_MINT_ABI, functionName: "mint", args: [address!, parseUnits(String(whole), market.decimals)] });
    return `Added ${whole} test ${market.symbol} to your wallet. It has no value.`;
  });

  const reprice = (l: SellerListing, unitsPerRip: bigint) => run(async () => {
    await send("Change price", { address: pool!, abi: MarketRipPoolAbi, functionName: "setListingPrice", args: [l.id, unitsPerRip] });
    return "Price updated.";
  });

  const withdraw = (l: SellerListing) => run(async () => {
    await send("Withdraw unsold", { address: pool!, abi: MarketRipPoolAbi, functionName: "withdrawListing", args: [l.id, l.remaining] });
    return "Unsold claims returned to your wallet.";
  });

  /** Merge equal P and N back into the locked stock. */
  const unlock = (l: SellerListing, amount: bigint) => run(async () => {
    await send("Unlock stock", { address: l.claims, abi: ErodoroVaultAbi, functionName: "merge", args: [l.seriesId, amount] });
    return `Unlocked ${formatUnits(amount, l.decimals)} ${l.symbol}.`;
  });

  const reclaim = (l: SellerListing) => run(async () => {
    await send("Reclaim unsold", { address: pool!, abi: MarketRipPoolAbi, functionName: "returnExpiredInventory", args: [l.id] });
    return "Unsold claims returned to your wallet.";
  });

  /** After settlement, redeem every P and N this wallet holds in the series for the stock they are owed. */
  const redeem = (l: SellerListing) => run(async () => {
    const before = await publicClient.readContract({ address: l.stock, abi: erc20Abi, functionName: "balanceOf", args: [address!] });
    if (l.pHeld > 0n) await send("Redeem P", { address: l.claims, abi: ErodoroVaultAbi, functionName: "redeem", args: [l.seriesId, true, l.pHeld] });
    if (l.nHeld > 0n) await send("Redeem N", { address: l.claims, abi: ErodoroVaultAbi, functionName: "redeem", args: [l.seriesId, false, l.nHeld] });
    const after = await retryRead(() => publicClient.readContract({ address: l.stock, abi: erc20Abi, functionName: "balanceOf", args: [address!] }));
    return `Redeemed for ${formatUnits(after - before, l.decimals)} ${l.symbol}.`;
  });

  return { address, markets, listings, usdcBalance, state, phase, transaction, refresh, list, getTestStock, reprice, withdraw, unlock, reclaim, redeem };
}
