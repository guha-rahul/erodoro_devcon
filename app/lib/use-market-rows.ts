"use client";

import { useQueries } from "@tanstack/react-query";
import { fetchReference, printToUsd, type PythPrint } from "./hermes";
import { useNow } from "./use-now";
import { DEPLOYMENT } from "./deployment";
import { SWAP_API } from "./swap-api";
import { nId, type Series } from "./types";
import { publicClient } from "./chain";
import { IB20AssetAbi } from "./abis";

const PUBLIC_TAKER = "0x0000000000000000000000000000000000000000";

export type MarketBid = {
  /** Quote token paid for the standard one-token preview size. */
  premium: number;
  /** Exact raw N amount covered by the signed, funding-checked quote. */
  quoteSize: bigint;
  /** Unix timestamp at which the signed quote stops being fillable. */
  expiry: bigint;
  spreadBps: number;
};

/**
 * The per-market numbers the table needs beyond the contract state.
 *
 * Two of them come from outside the chain: the reference price, and what a
 * market maker will actually pay for the upside. Both are fetched per market
 * and both are allowed to be absent — a column that shows a stale number is
 * worse than one that shows a dash.
 */

/** Reference prices, one request per distinct feed rather than per market. */
export function useReferencePrices(series: Series[]) {
  const now = useNow();
  const feeds = Array.from(new Set(series.map((s) => s.config.feedId)));

  const results = useQueries({
    queries: feeds.map((feedId) => ({
      queryKey: ["reference", feedId],
      queryFn: () => fetchReference(feedId),
      refetchInterval: 30_000,
      retry: 1,
    })),
  });

  const byFeed = new Map<string, PythPrint>();
  feeds.forEach((feedId, i) => {
    const p = results[i]?.data;
    if (p && !results[i]?.isError) byFeed.set(feedId, p);
  });

  return {
    referenceFor: (s: Series) => {
      const p = byFeed.get(s.config.feedId);
      if (!p || now <= 0n || !Number.isSafeInteger(p.publishTime) || p.price <= 0n || p.conf < 0n) return null;
      const value = printToUsd(p);
      if (!Number.isFinite(value) || value <= 0) return null;
      const age = now - BigInt(p.publishTime);
      const fresh = age >= 0n && age <= s.config.maxPriceLag
        && (s.config.maxConfBps === 0 || p.conf * 10_000n <= p.price * BigInt(s.config.maxConfBps));
      return { price: value, publishTime: p.publishTime, fresh };
    },
    spotFor: (s: Series) => {
      const p = byFeed.get(s.config.feedId);
      // This reader supplies a Pyth share price, not a total-return feed.
      if (s.config.settlementModel !== 0 || !p || now <= 0n || !Number.isSafeInteger(p.publishTime)) return null;
      const age = now - BigInt(p.publishTime);
      if (age < 0n || age > s.config.maxPriceLag || p.price <= 0n || p.conf < 0n) return null;
      if (s.config.maxConfBps > 0 && p.conf * 10_000n > p.price * BigInt(s.config.maxConfBps)) return null;
      const value = printToUsd(p);
      return Number.isFinite(value) && value > 0 ? value : null;
    },
    loading: results.some((r) => r.isLoading),
  };
}

/** Current B20 multiplier for each distinct collateral token. */
export function useCollateralMultipliers(series: Series[]) {
  const tokens = Array.from(new Set(series.map((s) => s.config.collateral)));
  const results = useQueries({
    queries: tokens.map((token) => ({
      queryKey: ["b20-multiplier", DEPLOYMENT.chainId, token],
      queryFn: () =>
        publicClient.readContract({ address: token, abi: IB20AssetAbi, functionName: "multiplier" }),
      refetchInterval: 30_000,
      retry: 1,
    })),
  });
  const byToken = new Map<string, bigint>();
  tokens.forEach((token, index) => {
    const value = results[index]?.data;
    if (typeof value === "bigint" && value > 0n && !results[index]?.isError) byToken.set(token.toLowerCase(), value);
  });
  return {
    multiplierFor: (s: Series) => byToken.get(s.config.collateral.toLowerCase()) ?? null,
    loading: results.some((result) => result.isLoading),
  };
}

/**
 * What a maker will pay for one share of upside, per market.
 *
 * This is the number the whole product turns on, so it belongs in the list
 * rather than three clicks in. It costs one quote request per market, which is
 * fine for a handful and will need batching before it is not.
 */
export function useMarketPremiums(series: Series[]) {
  const now = useNow();
  const vault = DEPLOYMENT.contracts.vault;
  const quote = DEPLOYMENT.quote;

  const results = useQueries({
    queries: series.map((s) => ({
      queryKey: ["premium", s.id.toString()],
      enabled: Boolean(vault && quote) && !s.settlement?.settled,
      refetchInterval: 60_000,
      retry: 0,
      queryFn: async (): Promise<MarketBid | null> => {
        const res = await fetch(`${SWAP_API}/rfq`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            claims: vault,
            claimId: nId(s.id).toString(),
            // One whole share, so every market is quoted on the same size.
            claimAmount: (10n ** BigInt(s.config.collateralDecimals)).toString(),
            quoteToken: quote!.token,
            // Market-list previews are public. A zero taker lets the maker
            // return a quote that is not bound to a connected wallet while
            // still satisfying the worker's address-shaped request contract.
            taker: PUBLIC_TAKER,
          }),
        });
        const body = await res.json().catch(() => null);
        if (!res.ok) return null;
        const best = body?.quotes?.[0];
        if (!best?.quote || !best?.metrics) return null;
        return {
          premium: Number(best.quote.quoteAmount) / 10 ** quote!.decimals,
          // The worker checks funding for the signed quote itself. The
          // maker-reported availableSize is useful capacity metadata, but it is
          // not independently funding-checked and must not be presented as
          // funded size.
          quoteSize: BigInt(best.quote.claimAmount),
          expiry: BigInt(best.quote.expiry),
          spreadBps: Number(best.metrics.spreadBps),
        };
      },
    })),
  });

  const byId = new Map<string, MarketBid | null>();
  series.forEach((s, i) => {
    const bid = results[i]?.data;
    byId.set(s.id.toString(), bid && !results[i]?.isError && now > 0n &&
      bid.expiry > now && s.config.maturity > now && !s.settlement?.settled &&
      Number.isFinite(bid.premium) && bid.premium > 0 ? bid : null);
  });

  return {
    bidFor: (s: Series) => byId.get(s.id.toString()) ?? null,
    premiumFor: (s: Series) => byId.get(s.id.toString())?.premium ?? null,
    loading: results.some((r) => r.isLoading),
  };
}

/** How far the reference sits from the strike, as a percentage. */
export function distanceToStrike(s: Series, spot: number | null, multiplier: bigint | null = null): number | null {
  if (spot === null || spot === 0) return null;
  const strike = effectiveStrikeUsd(s, multiplier);
  if (strike === null) return null;
  return ((strike - spot) / spot) * 100;
}

/** Preview the contract's rounded-up adjustment; settlement freezes its own value. */
export function effectiveStrikeUsd(s: Series, multiplier: bigint | null): number | null {
  let strike = s.config.strike;
  if (s.settlement?.settled) strike = s.settlement.effectiveStrike;
  else if (s.config.settlementModel === 0) {
    if (multiplier === null || multiplier <= 0n || s.config.multiplierAtCreation <= 0n) return null;
    strike = (strike * s.config.multiplierAtCreation + multiplier - 1n) / multiplier;
  }
  const value = Number(strike) / 10 ** s.config.priceDecimals;
  return Number.isFinite(value) && value > 0 ? value : null;
}

export function strikeUsd(s: Series): number {
  return Number(s.config.strike) / 10 ** s.config.priceDecimals;
}

/**
 * Simple annualized premium for the remaining market term.
 *
 * This is not APY. It does not compound, include fees, value points, or predict
 * a future quote. The inputs must be a current funded bid and reference price.
 */
export function annualizedPremiumPct(
  s: Series,
  bid: MarketBid | null,
  spot: number | null,
  now: bigint,
  multiplier: bigint | null,
): number | null {
  if (!bid || bid.expiry <= now || spot === null || !Number.isFinite(spot) || spot <= 0 || now <= 0n) return null;
  const seconds = Number(s.config.maturity - now);
  if (seconds <= 0) return null;
  // A raw-share reference prices one share. A quote prices one B20 token.
  // Convert the reference to token value with the current multiplier. A
  // total-return reference already includes that multiplier.
  if (s.config.settlementModel === 0 && multiplier === null) return null;
  const tokenValue = s.config.settlementModel === 0
    ? spot * (Number(multiplier) / 1e18)
    : spot;
  if (!Number.isFinite(tokenValue) || tokenValue <= 0) return null;
  const rate = (bid.premium / tokenValue) * (365 * 86_400 / seconds) * 100;
  return Number.isFinite(rate) && rate >= 0 ? rate : null;
}
