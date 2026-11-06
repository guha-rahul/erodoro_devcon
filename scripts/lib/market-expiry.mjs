/** Batch expiries that land inside the regular US stock session.
 * Settlement takes the first oracle print after maturity, and Chainlink's
 * Coinbase feeds and Pyth's US equity feeds go quiet outside market hours, so
 * an expiry must fall while the market is open. 18:00 UTC is 2pm New York in
 * summer and 1pm in winter: inside the session either way and clear of the
 * 1pm early closes. Only Tuesday to Thursday, skipping NYSE holidays, so a
 * long weekend or a half day never sits next to maturity. The admin panel
 * uses app/lib/market-expiry.ts; keep the two holiday tables in step.
 */
const NYSE_CLOSED = new Set([
  "2026-01-01", "2026-01-19", "2026-02-16", "2026-04-03", "2026-05-25", "2026-06-19", "2026-07-03", "2026-09-07", "2026-11-26", "2026-12-25",
  "2027-01-01", "2027-01-18", "2027-02-15", "2027-03-26", "2027-05-31", "2027-06-18", "2027-07-05", "2027-09-06", "2027-11-25", "2027-12-24",
]);
const LAST_KNOWN_YEAR = 2027;
const DAY = 86_400;
const MIN_DAYS = 7;
const MAX_DAYS = 45;

/** First Tue-Thu 18:00 UTC trading day at or after `nowSec + days`. */
export function marketExpiry(nowSec, days = 30) {
  if (days < MIN_DAYS || days > MAX_DAYS - 7) throw new Error(`days must be ${MIN_DAYS}..${MAX_DAYS - 7}`);
  const start = new Date((nowSec + days * DAY) * 1000);
  for (let i = 0; i < 7; i++) {
    const d = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth(), start.getUTCDate() + i, 18));
    if (d.getUTCFullYear() > LAST_KNOWN_YEAR) throw new Error(`Add ${d.getUTCFullYear()} NYSE holidays to scripts/lib/market-expiry.mjs`);
    const weekday = d.getUTCDay();
    const iso = d.toISOString().slice(0, 10);
    const expiry = d.getTime() / 1000;
    if (weekday >= 2 && weekday <= 4 && !NYSE_CLOSED.has(iso) && expiry >= nowSec + days * DAY) return BigInt(expiry);
  }
  throw new Error("No trading day found");
}
