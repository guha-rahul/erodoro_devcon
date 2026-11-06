import { erc20Abi, formatUnits, parseAbi, type Address } from "viem";
import { MarketRipPoolAbi, MarketRipPutAbi, ErodoroVaultAbi } from "../abis";
import { publicClient } from "../chain";
import { DEPLOYMENT } from "../deployment";
import { assetFor } from "../issuers";
import { loadHistory, fillsFor } from "./history";
import type { PoolLot, RipPosition, RipFill } from "./model";

export type Position = {
  batchId: bigint; stock: Address; claims: Address; claimId: bigint; direction: number;
  spotAtCreation: bigint; strike: bigint; priceDecimals: number; expiry: bigint; totalInventoryUnits: bigint;
  remainingUnits: bigint; collateralSupplied: bigint; unitsPerRip: bigint;
  quoteValidUntil: bigint; quoteRef: `0x${string}`; amountSold: bigint; buyerCount: bigint;
  /** Who locked this inventory and is paid for it; the house for Erodoro's markets. */
  seller: Address;
};
export type Holding = { positionId: bigint; bought: bigint; purchased: bigint; units: bigint; unitDecimals: number; settlementModel: number; position: Position; settled: boolean; settlementValue: bigint | null; fills?: RipFill[]; asset?: { symbol: string; name: string } };
export type Snapshot = { batchId: bigint; positions: { id: bigint; row: Position }[]; holdings: Holding[] };


/** Expired sale quotes disable execution without deleting position detail links. */
export function selectLiveLots(catalog: PoolLot[], positions: Snapshot["positions"], now: bigint) {
  const rows = new Map(positions.map(p => [p.id.toString(), p.row]));
  const executable = catalog.filter(lot => {
    const row = rows.get(lot.id);
    return !!row && row.direction === 0 && row.unitsPerRip > 0n
      && now <= row.quoteValidUntil && now < row.expiry && row.remainingUnits >= row.unitsPerRip;
  });
  return { catalog, executable };
}


const CLAIM_BALANCE = parseAbi(["function balanceOf(address owner, uint256 id) view returns (uint256)"]);
const CHAINLINK = parseAbi([
  "function decimals() view returns (uint8)",
  "function latestRoundData() view returns (uint80, int256, uint256, uint256, uint80)",
]);
const FEED_ADAPTER = parseAbi(["function feed() view returns (address)"]);

// Address identity comes from Base's published Coinbase stock list. Pool
// membership still comes only from the funded on-chain active batch.
const STOCKS: Record<string, { ticker: string; name: string }> = {
  "0xb20000000000000000000078ee7ce2fe4908108c": { ticker: "NVDA", name: "NVIDIA" },
  "0xb200000000000000000000c2e324d24d7eecd1fb": { ticker: "AAPL", name: "Apple" },
  "0xb200000000000000000000ab99cfa739e253872b": { ticker: "MSFT", name: "Microsoft" },
  "0xb200000000000000000000d9192b6b456483c2e8": { ticker: "AMZN", name: "Amazon" },
  "0xb2000000000000000000002d0ba3164cc74f58b7": { ticker: "GOOGL", name: "Alphabet" },
  "0xb2000000000000000000008bc8786b856e61707c": { ticker: "META", name: "Meta" },
  "0xb2000000000000000000001e800a7f5189430cd0": { ticker: "TSLA", name: "Tesla" },
  "0xb200000000000000000000397293cb8cda9a10c5": { ticker: "SNDK", name: "SanDisk" },
  "0xb2000000000000000000004884b426556b92883d": { ticker: "MSTR", name: "Strategy" },
  "0xb2000000000000000000007b9fcbd005511acbd5": { ticker: "SPCX", name: "SpaceX" },
};

export function symbolFor(stock: string) {
  return STOCKS[stock.toLowerCase()]?.ticker ?? assetFor(stock)?.symbol?.replace(/c$/, "") ?? `${stock.slice(0, 6)}…${stock.slice(-4)}`;
}

export function nameFor(stock: string) {
  return STOCKS[stock.toLowerCase()]?.name ?? assetFor(stock)?.name ?? symbolFor(stock);
}

const metadata = new Map<string, Promise<{ symbol: string; name: string }>>();
async function assetMetadata(stock: Address) {
  if (STOCKS[stock.toLowerCase()] || assetFor(stock)) return { symbol: symbolFor(stock), name: nameFor(stock) };
  const key = stock.toLowerCase();
  if (!metadata.has(key)) metadata.set(key, (async () => {
    const read = () => Promise.all([
      publicClient.readContract({ address: stock, abi: erc20Abi, functionName: "symbol" }),
      publicClient.readContract({ address: stock, abi: erc20Abi, functionName: "name" }),
    ]);
    // Public RPCs drop some of the pool's parallel reads; retry before showing an address.
    const [symbol, name] = await read().catch(() => new Promise(r => setTimeout(r, 400)).then(read)).catch(() => new Promise(r => setTimeout(r, 1200)).then(read));
    // Keep shared tickers bounded and textual, including unfamiliar test assets.
    // Testnet fixtures are `t<TICKER>` test versions of real stocks; keep that readable.
    const ticker = /^t[A-Z]{1,8}$/.test(symbol) ? symbol : symbol.toUpperCase().replace(/[^A-Z0-9.-]/g, "").slice(0, 12);
    return { symbol: /^[A-Za-z0-9]/.test(ticker) ? ticker : stock.slice(0, 10).toUpperCase(), name: name.slice(0, 100) };
  })().catch(() => { metadata.delete(key); return { symbol: stock.slice(0, 10).toUpperCase(), name: nameFor(stock) }; }));
  return metadata.get(key)!;
}

export async function referencePrice(position: Position): Promise<number | null> {
  try {
    const series = position.direction === 0
      ? await publicClient.readContract({ address: position.claims, abi: ErodoroVaultAbi, functionName: "seriesConfig", args: [position.claimId & ~1n] })
      : await publicClient.readContract({ address: position.claims, abi: MarketRipPutAbi, functionName: "series", args: [position.claimId] });
    const feed = await publicClient.readContract({ address: series.oracle, abi: FEED_ADAPTER, functionName: "feed" });
    const [decimals, round] = await Promise.all([
      publicClient.readContract({ address: feed, abi: CHAINLINK, functionName: "decimals" }),
      publicClient.readContract({ address: feed, abi: CHAINLINK, functionName: "latestRoundData" }),
    ]);
    const price = Number(round[1]) / 10 ** Number(decimals);
    const now = BigInt(Math.floor(Date.now() / 1000));
    const fresh = round[3] > 0n && round[3] <= now && now - round[3] <= 3600n && round[4] >= round[0];
    return fresh && round[1] > 0n && Number.isFinite(price) ? price : null;
  } catch { return null; }
}

/** `withHistory: false` skips the event scan (timestamps only); holdings and costs come from getters either way. */
export async function loadSnapshot(owner?: Address, withHistory = true): Promise<Snapshot> {
  const pool = DEPLOYMENT.contracts.ripPool;
  if (!pool) return { batchId: 0n, positions: [], holdings: [] };
  const batchId = await publicClient.readContract({ address: pool, abi: MarketRipPoolAbi, functionName: "activeBatchId" });
  const ids = batchId === 0n ? [] : await publicClient.readContract({ address: pool, abi: MarketRipPoolAbi, functionName: "batchPositions", args: [batchId] });
  const positions = await Promise.all(ids.map(async (id) => ({
    id, row: await publicClient.readContract({ address: pool, abi: MarketRipPoolAbi, functionName: "position", args: [id] }) as unknown as Position,
  })));
  if (!owner) return { batchId, positions, holdings: [] };

  const history = withHistory ? await loadHistory(pool, owner).catch(() => []) : [];
  const purchased = await publicClient.readContract({ address: pool, abi: MarketRipPoolAbi, functionName: "buyerPositions", args: [owner] });
  const current = new Map(positions.map((p) => [p.id.toString(), p.row]));
  const holdings = await Promise.all(purchased.map(async (positionId): Promise<Holding> => {
    const position = current.get(positionId.toString()) ?? await publicClient.readContract({ address: pool, abi: MarketRipPoolAbi, functionName: "position", args: [positionId] }) as unknown as Position;
    const [units, bought, purchased] = await Promise.all([
      publicClient.readContract({ address: position.claims, abi: CLAIM_BALANCE, functionName: "balanceOf", args: [owner, position.claimId] }),
      publicClient.readContract({ address: pool, abi: MarketRipPoolAbi, functionName: "purchasedValue", args: [owner, positionId] }),
      publicClient.readContract({ address: pool, abi: MarketRipPoolAbi, functionName: "purchasedUnits", args: [owner, positionId] }),
    ]);
    let unitDecimals = 8;
    let settlementModel = 1;
    let settled = false;
    let settlementValue: bigint | null = null;
    if (position.direction === 1) {
      const s = await publicClient.readContract({ address: position.claims, abi: MarketRipPutAbi, functionName: "series", args: [position.claimId] });
      settled = s.settled;
      unitDecimals = s.unitDecimals;
      if (settled) settlementValue = s.payoutPerShare * units * 1_000_000n / (10n ** BigInt(s.priceDecimals + s.unitDecimals));
    } else {
      const s = await publicClient.readContract({ address: position.claims, abi: ErodoroVaultAbi, functionName: "settlementOf", args: [position.claimId & ~1n] });
      const cfg = await publicClient.readContract({ address: position.claims, abi: ErodoroVaultAbi, functionName: "seriesConfig", args: [position.claimId & ~1n] });
      unitDecimals = cfg.collateralDecimals;
      settlementModel = cfg.settlementModel;
      settled = s.settled;
      if (settled && s.nSupplyAtSettlement > 0n) {
        const collateralUnits = units * s.nPool / s.nSupplyAtSettlement;
        settlementValue = collateralUnits * s.price * 1_000_000n / (10n ** BigInt(cfg.collateralDecimals + cfg.priceDecimals));
      }
    }
    return { positionId, bought, purchased, units, unitDecimals, settlementModel, position, settled, settlementValue, fills: fillsFor(history, positionId, unitDecimals), asset: await assetMetadata(position.stock) };
  }));
  return { batchId, positions, holdings };
}


let house: Promise<Address> | null = null;
/** The pool's house seller; positions it supplied are Erodoro's markets. */
export function poolHouse(): Promise<Address> {
  const pool = DEPLOYMENT.contracts.ripPool;
  if (!pool) return Promise.reject(new Error("No Rips pool is configured."));
  house ??= publicClient.readContract({ address: pool, abi: MarketRipPoolAbi, functionName: "erodoro" }).catch((error) => { house = null; throw error; });
  return house;
}

export async function lotFor(id: bigint, p: Position): Promise<PoolLot> {
  const [cfg, asset, houseSeller] = await Promise.all([
    publicClient.readContract({ address: p.claims, abi: ErodoroVaultAbi, functionName: "seriesConfig", args: [p.claimId & ~1n] }),
    assetMetadata(p.stock),
    poolHouse(),
  ]);
  const qty = Number(formatUnits(p.unitsPerRip, cfg.collateralDecimals));
  return { id: id.toString(), source: "live", ...asset,
    strike: Number(formatUnits(p.strike, p.priceDecimals)), spot: Number(formatUnits(p.spotAtCreation, p.priceDecimals)),
    expiryTs: Number(p.expiry), askPrice: qty > 0 ? 1 / qty : 0,
    availableUsd: p.unitsPerRip > 0n ? Number(p.remainingUnits / p.unitsPerRip) : 0,
    series: p.claims,
    listedBy: p.seller && p.seller.toLowerCase() !== houseSeller.toLowerCase() ? p.seller : undefined };
}
/** House and seller listings of one market sell the same claim id, and each
 *  holding reads the wallet's whole balance of it: one holding per claim, spend summed. */
export function byClaim(holdings: Holding[]): Holding[] {
  const merged = new Map<string, Holding>();
  for (const h of holdings) {
    const key = `${h.position.claims.toLowerCase()}:${h.position.claimId}`;
    const g = merged.get(key);
    merged.set(key, g ? { ...g, bought: g.bought + h.bought, purchased: g.purchased + h.purchased,
      fills: g.fills || h.fills ? [...(g.fills ?? []), ...(h.fills ?? [])].sort((a, b) => a.at - b.at) : undefined } : h);
  }
  return [...merged.values()];
}
export function heldPosition(h: Holding): RipPosition {
  const qty = Number(formatUnits(h.units, h.unitDecimals));
  // Lifetime spend and current holdings are separate; transfers never invent P/L.
  const paid = Number(formatUnits(h.bought, 6));
  return { id: `live:${h.positionId}`, lotId: h.positionId.toString(), source: "live",
    symbol: h.asset?.symbol ?? symbolFor(h.position.stock), name: h.asset?.name ?? nameFor(h.position.stock),
    strike: Number(formatUnits(h.position.strike, h.position.priceDecimals)),
    spotAtRip: Number(formatUnits(h.position.spotAtCreation, h.position.priceDecimals)),
    expiryTs: Number(h.position.expiry), termDays: 30, series: h.position.claims,
    fills: h.fills?.length ? h.fills : [{ kind: "buy", qty, paid, at: 0 }],
    live: { positionId: h.positionId.toString(), claims: h.position.claims, claimId: h.position.claimId.toString(),
      unitDecimals: h.unitDecimals, heldRaw: h.units.toString(), purchasedRaw: h.purchased.toString(), purchasedCostRaw: h.bought.toString(),
      settled: h.settled, settlementModel: h.settlementModel, quoteValidUntil: Number(h.position.quoteValidUntil) } };
}
export async function validatePool() {
  const pool = DEPLOYMENT.contracts.ripPool;
  if (!pool) return false;
  if (await publicClient.getChainId() !== DEPLOYMENT.chainId) throw new Error("The data endpoint serves another chain. Fix the RPC configuration before buying.");
  const [token, supported] = await Promise.all([
    publicClient.readContract({ address: pool, abi: MarketRipPoolAbi, functionName: "usdc" }),
    publicClient.readContract({ address: pool, abi: MarketRipPoolAbi, functionName: "supportsDirectedBuys" }).catch(() => false),
  ]);
  if (token.toLowerCase() !== DEPLOYMENT.quote?.token.toLowerCase()) throw new Error("The pool payment token does not match this network. Purchases are disabled.");
  const decimals = await publicClient.readContract({ address: token, abi: erc20Abi, functionName: "decimals" });
  if (decimals !== 6) throw new Error("This pool requires a six-decimal payment token.");
  return supported;
}
