"use client";

import { useQuery } from "@tanstack/react-query";
import { confBps, fetchReference, printToUsd, type PythPrint } from "./hermes";
import { publicClient } from "./chain";
import { DEPLOYMENT } from "./deployment";
import { STOCK_REGISTRY } from "./issuers";
import { useNow } from "./use-now";
import type { Address, Series } from "./types";

/**
 * The issuer's own oracle registry, read directly.
 *
 * A stock feed is paused while the issuer synchronises a corporate action. That
 * is not a broken market and not a closed one — the price is simply not allowed
 * to settle anything until the multiplier and the feed describe the same state.
 * Reading the pause flag lets the interface say that, instead of falling
 * through to a generic "market closed".
 */
const ORACLE_REGISTRY_ABI = [
  {
    type: "function",
    name: "getOracleParams",
    stateMutability: "view",
    inputs: [{ name: "token", type: "address" }],
    outputs: [
      { name: "multiplier", type: "uint256" },
      { name: "paused", type: "bool" },
    ],
  },
] as const;

export function useCoinbaseOracleStatus(token?: Address) {
  const q = useQuery({
    queryKey: ["coinbase-oracle", DEPLOYMENT.chainId, token ?? null],
    enabled: Boolean(token),
    refetchInterval: 60_000,
    retry: 1,
    queryFn: async (): Promise<{ multiplier: bigint; paused: boolean } | null> => {
      if (!token) return null;
      try {
        const [multiplier, paused] = (await publicClient.readContract({
          address: STOCK_REGISTRY,
          abi: ORACLE_REGISTRY_ABI,
          functionName: "getOracleParams",
          args: [token],
        })) as readonly [bigint, boolean];
        return { multiplier, paused };
      } catch {
        // A chain without the issuer registry, or a test asset outside it.
        return null;
      }
    },
  });
  return { status: q.data ?? null, loading: q.isLoading };
}

/**
 * The settlement reference price, and whether it can settle anything right now.
 *
 * **This is not the market price.** A market price is what someone will pay for
 * the token on a venue; the settlement reference is what the series is
 * contractually scored against at expiry. They are different numbers from
 * different places and the UI must never present one as the other.
 *
 * The reference is also **not continuous**. The underlying equity trades in
 * sessions, and a price carried across a closed weekend is a stale close, not a
 * live quote. Every state below exists so the interface can say which one it is
 * holding rather than showing a number and letting the user assume.
 *
 * Swapping the settlement oracle changes `fetchPrint` and the staleness rule.
 * Everything the UI renders is derived from `OracleState`, so it does not move.
 */
export type OracleStatus =
  | "loading"
  | "unavailable" // the reference could not be read at all
  | "stale" // read, but too old to settle against — a closed market looks like this
  | "wide" // read and fresh, but the confidence band is wider than the series allows
  | "paused" // the issuer has paused this oracle while a corporate action synchronises
  | "waiting" // usable price, but the settlement window has not opened
  | "ready" // settlement can be called now
  | "settled";

export type OracleState = {
  status: OracleStatus;
  print: PythPrint | null;
  usd: number | null;
  confBps: number | null;
  /** Seconds since the reference last moved. */
  age: number | null;
  /** When settlement opens, and when the publish window shuts. */
  opensAt: bigint;
  closesAt: bigint;
  label: string;
  detail: string;
};

/** Older than this and the reference is a carried close, not a live quote. */
const STALE_AFTER = 15 * 60;

export function useOracle(series: Series | null): OracleState {
  const now = useNow();
  const q = useQuery({
    queryKey: ["oracle", series?.config.feedId ?? null],
    queryFn: () => (series ? fetchReference(series.config.feedId) : Promise.resolve(null)),
    enabled: Boolean(series),
    refetchInterval: 30_000,
    retry: 1,
  });
  const coinbase = useCoinbaseOracleStatus(series?.config.collateral);

  const opensAt = series ? series.config.maturity + series.config.settlementDelay : 0n;
  const closesAt = series ? series.config.maturity + series.config.maxPriceLag : 0n;
  const print = (q.data as PythPrint | null) ?? null;
  const age = print && now > 0n ? Number(now) - print.publishTime : null;

  const base = { print, opensAt, closesAt, usd: print ? printToUsd(print) : null, confBps: print ? confBps(print) : null, age };

  if (series?.settlement?.settled) {
    return { ...base, status: "settled", label: "Settled", detail: "This market has already been settled." };
  }
  if (coinbase.status?.paused) {
    return {
      ...base,
      status: "paused",
      label: "Oracle paused for corporate action",
      detail:
        "The issuer has paused this stock's settlement oracle while a corporate action synchronises. The market is not closed; settlement resumes once the multiplier and the feed agree.",
    };
  }
  if (q.isLoading) {
    return { ...base, status: "loading", label: "Loading", detail: "Reading the settlement reference." };
  }
  if (!print) {
    return {
      ...base,
      status: "unavailable",
      label: "Reference unavailable",
      detail: "The settlement reference could not be read. Settlement cannot be attempted until it can.",
    };
  }
  if (age !== null && age > STALE_AFTER) {
    return {
      ...base,
      status: "stale",
      label: "Market closed",
      detail: `The settlement reference last moved ${Math.round(age / 60)} minutes ago. That is a carried close, not a live quote, and it will not be used as a fresh price.`,
    };
  }
  if (series && base.confBps !== null && base.confBps > series.config.maxConfBps) {
    return {
      ...base,
      status: "wide",
      label: "Price band too wide",
      detail: `The reference carries a ${base.confBps}bp uncertainty band, wider than this market's ${series.config.maxConfBps}bp limit. Settling through a band that wide is settling against noise.`,
    };
  }
  if (now > 0n && now < opensAt) {
    return {
      ...base,
      status: "waiting",
      label: "Waiting for settlement window",
      detail: "The market has a usable reference price, but its settlement window has not opened yet.",
    };
  }
  return {
    ...base,
    status: "ready",
    label: "Settlement available",
    detail: "Anyone can settle this market now. The caller supplies a signed reference from inside the window and cannot substitute another price.",
  };
}
