/** Catalog every Coinbase tokenized stock Base lists, checked on Base mainnet.
 * Reads Base's stock list and Chainlink's Base feed directory, then verifies
 * each token's code, symbol and decimals, its Coinbase oracle-registry
 * multiplier and pause flag, any "Coinbase <TICKER>" Chainlink feed (TOTAL_RETURN
 * settlement), and any Pyth "Equity.US.<TICKER>/USD" feed (RAW_SHARE settlement).
 * Read-only. node scripts/base-stocks.mjs [out.json]
 */
import { createPublicClient, http, parseAbi, getAddress } from "viem";
import { base } from "viem/chains";
import fs from "node:fs";
const OUT = process.argv[2] ?? "contracts/deployments/base-stocks.json";
const STOCKS_URL = "https://brand.base.org/api/stocks";
const FEEDS_URL = "https://reference-data-directory.vercel.app/feeds-ethereum-mainnet-base-1.json";
const PYTH_URL = "https://hermes.pyth.network/v2/price_feeds?asset_type=equity";
const getJson = async (url) => { const r = await fetch(url); if (!r.ok) throw new Error(`${url}: ${r.status}`); return r.json(); };
const stocks = (await getJson(STOCKS_URL)).stocks;
const feeds = (await getJson(FEEDS_URL)).filter((f) => /^Coinbase /.test(f.name) && f.docs?.assetClass === "Equity");
const pythFeeds = new Map((await getJson(PYTH_URL)).filter((f) => f.attributes?.symbol?.startsWith("Equity.US.")).map((f) => [f.attributes.symbol, f]));
const c = createPublicClient({ chain: base, transport: http(process.env.BASE_RPC_URL ?? "https://mainnet.base.org"), batch: { multicall: true } });
const erc = parseAbi(["function symbol() view returns (string)", "function name() view returns (string)", "function decimals() view returns (uint8)", "function totalSupply() view returns (uint256)"]);
const reg = parseAbi(["function getOracleParams(address) view returns (uint256 multiplier, bool paused)"]);
const agg = parseAbi(["function latestRoundData() view returns (uint80,int256,uint256,uint256,uint80)", "function description() view returns (string)"]);
const REGISTRY = "0x3f3E8cf41cdd3b1D118c16471aB0113DfDDd5CaD";
const out = [];
for (const s of stocks) {
  const address = getAddress(s.address);
  const ticker = s.ticker.replace(/c$/, "");
  const r = (fn, abi = erc, a = address, args) => c.readContract({ address: a, abi, functionName: fn, args }).catch((e) => ({ error: e.shortMessage ?? String(e) }));
  const [symbol, decimals, totalSupply, params, code] = await Promise.all([r("symbol"), r("decimals"), r("totalSupply"), r("getOracleParams", reg, REGISTRY, [address]), c.getCode({ address })]);
  const feed = feeds.find((f) => f.docs?.baseAsset === ticker || f.name === `Coinbase ${ticker}`);
  let feedInfo = null;
  if (feed) {
    const [round, description] = await Promise.all([r("latestRoundData", agg, getAddress(feed.proxyAddress)), r("description", agg, getAddress(feed.proxyAddress))]);
    feedInfo = { proxy: getAddress(feed.proxyAddress), decimals: feed.decimals, marketHours: feed.docs?.marketHours, description, answer: round.error ? null : round[1].toString(), updatedAt: round.error ? null : Number(round[3]) };
  }
  const pythFeed = pythFeeds.get(`Equity.US.${ticker.replace(".", "-")}/USD`);
  const pyth = pythFeed ? { id: `0x${pythFeed.id}`, symbol: pythFeed.attributes.symbol, schedule: pythFeed.attributes.schedule ?? null } : null;
  const settlement = feedInfo ? "chainlink" : pyth ? "pyth" : null;
  out.push({ ticker: s.ticker, underlying: ticker, name: s.name, address, hasCode: !!code && code !== "0x", symbol, decimals, totalSupply: totalSupply?.toString?.() ?? totalSupply, multiplier: params.error ? null : params[0].toString(), paused: params.error ? null : params[1], registryError: params.error ?? null, settlement, chainlink: feedInfo, pyth, prospectus: s.prospectus });
}
const unmatched = feeds.filter((f) => !out.some((o) => o.chainlink?.proxy?.toLowerCase() === f.proxyAddress.toLowerCase())).map((f) => f.name);
fs.writeFileSync(OUT, JSON.stringify({ checkedAt: new Date().toISOString(), source: STOCKS_URL, chainlinkSource: FEEDS_URL, pythSource: PYTH_URL, registry: REGISTRY, stocks: out, unmatchedFeeds: unmatched }, null, 2));
const bad = out.filter((o) => !o.hasCode || o.symbol?.error || o.symbol !== o.ticker);
console.log({ total: out.length, withCode: out.filter((o) => o.hasCode).length, symbolMismatch: bad.map((o) => [o.ticker, o.symbol]), decimals: [...new Set(out.map((o) => o.decimals))], registryOk: out.filter((o) => o.multiplier && o.multiplier !== "0").length, paused: out.filter((o) => o.paused).map((o) => o.ticker), nonUnitMultiplier: out.filter((o) => o.multiplier && o.multiplier !== "1000000000000000000").map((o) => [o.ticker, o.multiplier]), chainlink: out.filter((o) => o.settlement === "chainlink").length, pyth: out.filter((o) => o.settlement === "pyth").length, noOracle: out.filter((o) => !o.settlement).map((o) => o.underlying), unmatched });

// The app's copy: just what it needs to name and price each stock.
const rows = out.map((o) => `  { ticker: ${JSON.stringify(o.underlying)}, symbol: ${JSON.stringify(o.ticker)}, name: ${JSON.stringify(o.name)}, address: "${o.address}", chainlink: ${o.chainlink ? `"${o.chainlink.proxy}"` : "null"}, pyth: ${o.pyth ? `"${o.pyth.id}"` : "null"} },`);
fs.writeFileSync("app/lib/rips/base-stocks.ts", `// Generated by scripts/base-stocks.mjs from ${OUT}. Do not edit by hand.
import type { Address, Hex } from "viem";

/** A Coinbase tokenized stock on Base mainnet, with its display price feeds. */
export type BaseStock = { ticker: string; symbol: string; name: string; address: Address; chainlink: Address | null; pyth: Hex | null };

/** Every stock Base lists (${out.length}), checked on-chain ${new Date().toISOString().slice(0, 10)}. */
export const BASE_STOCKS: readonly BaseStock[] = [
${rows.join("\n")}
];

/** The stocks Rips lists on mainnet: those with a Coinbase Chainlink feed, which settle TOTAL_RETURN on chain with no API key. */
export const RIPS_STOCKS: readonly BaseStock[] = BASE_STOCKS.filter((s) => s.chainlink);
`);
