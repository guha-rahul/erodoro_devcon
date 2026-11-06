import { statusOf, type Series } from "./types";

/**
 * What a market is doing, as someone looking at it would say it.
 *
 * The contract has three states, and two of them are the same word to a user.
 * A settled market is not "settled", it is **redeemable** — there is something
 * to collect. A matured market nobody has settled yet is not "open", because
 * trading has stopped; it is **awaiting settlement**. Those two distinctions
 * are the difference between a list you can act on and a list you have to
 * decode.
 */
export type DisplayStatus = "Open" | "Paused" | "Awaiting settlement" | "Redeemable";

export function displayStatus(series: Series, now: bigint): DisplayStatus {
  const raw = statusOf(series);
  if (raw === "Settled") return "Redeemable";
  if (now > 0n && series.config.maturity <= now) return "Awaiting settlement";
  return raw;
}

/** Trading has stopped, whether or not anyone has settled it. */
export function isMatured(series: Series, now: bigint): boolean {
  return statusOf(series) === "Settled" || (now > 0n && series.config.maturity <= now);
}
