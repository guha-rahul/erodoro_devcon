import { createPublicClient, http, parseAbi, type Address } from "viem";
import { base } from "viem/chains";
import { IS_TESTNET } from "../deployment";
import { SWAP_API } from "../swap-api";
import { RIPS_STOCKS, type BaseStock } from "./base-stocks";

/**
 * Chainlink "Coinbase <TICKER>" feeds on Base mainnet: the price of each
 * Coinbase tokenized stock (underlying 24/5 equity price times Coinbase's
 * on-chain multiplier), 8 decimals. These are the stocks Rips lists; see
 * scripts/base-stocks.mjs.
 */
export const COINBASE_STOCK_FEEDS: Record<string, Address> = Object.fromEntries(
  RIPS_STOCKS.map((s) => [s.ticker, s.chainlink as Address]),
);
const BY_TICKER = new Map<string, BaseStock>(RIPS_STOCKS.map((s) => [s.ticker.toUpperCase(), s]));
const BY_SYMBOL = new Map<string, BaseStock>(RIPS_STOCKS.map((s) => [s.symbol.toUpperCase(), s]));

const AGGREGATOR_ABI = parseAbi([
  "function decimals() view returns (uint8)",
  "function latestRoundData() view returns (uint80 roundId, int256 answer, uint256 startedAt, uint256 updatedAt, uint80 answeredInRound)",
]);

// Reads go to Base mainnet whatever chain the app runs on: these feeds exist
// only there. Display only; settlement uses each market's own oracle.
const mainnet = createPublicClient({
  chain: base,
  batch: { multicall: true },
  // Same endpoint as wagmi's Base transport, so a local mainnet fork prices from the fork.
  transport: http(process.env.NEXT_PUBLIC_BASE_MAINNET_RPC_URL ?? (typeof window === "undefined" ? "https://mainnet.base.org" : `${SWAP_API}/rpc/mainnet`), { batch: { batchSize: 10 } }),
});

/**
 * The real stock a Rips symbol refers to. On mainnet the symbol is the token's
 * own (`NVDAc`) or the bare ticker. On testnet, fixture tokens are named
 * `t<TICKER>` and use that stock's mainnet feed as a reference price.
 */
export function referenceTicker(symbol: string): string | null {
  const s = symbol.toUpperCase();
  if (!IS_TESTNET) return (BY_SYMBOL.get(s) ?? BY_TICKER.get(s))?.ticker ?? null;
  const m = /^T([A-Z.]+)$/.exec(s);
  return m && BY_TICKER.has(m[1]) ? BY_TICKER.get(m[1])!.ticker : null;
}


export type StockPrice = { ticker: string; price: number; updatedAt: number };

const cache = new Map<string, { at: number; value: Promise<StockPrice | null> }>();

/** Latest Chainlink price for a Rips symbol, cached for a minute; null when unknown. */
export function stockPrice(symbol: string): Promise<StockPrice | null> {
  const ticker = referenceTicker(symbol);
  if (!ticker) return Promise.resolve(null);
  const hit = cache.get(ticker);
  if (hit && Date.now() - hit.at < 60_000) return hit.value;
  const feed = COINBASE_STOCK_FEEDS[ticker];
  const value = Promise.all([
    mainnet.readContract({ address: feed, abi: AGGREGATOR_ABI, functionName: "latestRoundData" }),
    mainnet.readContract({ address: feed, abi: AGGREGATOR_ABI, functionName: "decimals" }),
  ]).then(([[, answer, , updatedAt], decimals]) =>
    answer > 0n && updatedAt > 0n ? { ticker, price: Number(answer) / 10 ** decimals, updatedAt: Number(updatedAt) } : null,
  ).catch(() => { cache.delete(ticker); return null; });
  cache.set(ticker, { at: Date.now(), value });
  return value;
}

/** Starts (and caches) every known stock's price read; later `stockPrice` calls reuse it. */
export function prefetchStockPrices() {
  for (const ticker of Object.keys(COINBASE_STOCK_FEEDS)) void stockPrice(IS_TESTNET ? `t${ticker}` : ticker);
}
