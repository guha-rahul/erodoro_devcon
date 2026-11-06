/**
 * Batch expiries inside the regular US session: Tuesday to Thursday at 18:00
 * UTC (2pm New York in summer, 1pm in winter), skipping NYSE holidays, so the
 * settlement feeds are printing at maturity. Mirrors scripts/lib/market-expiry.mjs;
 * keep the two holiday tables in step.
 */
const NYSE_CLOSED = new Set([
  "2026-01-01", "2026-01-19", "2026-02-16", "2026-04-03", "2026-05-25", "2026-06-19", "2026-07-03", "2026-09-07", "2026-11-26", "2026-12-25",
  "2027-01-01", "2027-01-18", "2027-02-15", "2027-03-26", "2027-05-31", "2027-06-18", "2027-07-05", "2027-09-06", "2027-11-25", "2027-12-24",
]);
const LAST_KNOWN_YEAR = 2027;
const DAY = 86_400;

/** First Tue-Thu 18:00 UTC trading day at or after `nowSec + days` (7 to 38 days). */
export function marketExpiry(nowSec: number, days = 30): number {
  if (days < 7 || days > 38) throw new Error("Expiry must be 7 to 38 days out.");
  const start = new Date((nowSec + days * DAY) * 1000);
  for (let i = 0; i < 7; i++) {
    const d = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth(), start.getUTCDate() + i, 18));
    if (d.getUTCFullYear() > LAST_KNOWN_YEAR) throw new Error(`Add ${d.getUTCFullYear()} NYSE holidays to lib/market-expiry.ts.`);
    const weekday = d.getUTCDay();
    const expiry = d.getTime() / 1000;
    if (weekday >= 2 && weekday <= 4 && !NYSE_CLOSED.has(d.toISOString().slice(0, 10)) && expiry >= nowSec + days * DAY) return expiry;
  }
  throw new Error("No trading day found.");
}
