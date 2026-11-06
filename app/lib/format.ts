/** Display helpers. Every wide integer is a `bigint`, so nothing here rounds
 *  through a float on its way to the screen. */

export function fromRaw(raw: bigint, decimals: number, dp = 4): string {
  const negative = raw < 0n;
  const abs = negative ? -raw : raw;
  const base = 10n ** BigInt(decimals);
  const whole = abs / base;
  const frac = abs % base;
  const fracStr = frac.toString().padStart(decimals, "0").slice(0, dp).replace(/0+$/, "");
  const sign = negative ? "-" : "";
  return fracStr ? `${sign}${whole}.${fracStr}` : `${sign}${whole}`;
}

export function priceToUsd(price: bigint, decimals: number): string {
  const value = Number(price) / 10 ** decimals;
  return `$${value.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

/** Addresses are 42 characters. Showing all of them helps nobody. */
export function shortAddress(a: string, n = 4): string {
  return a.length <= 2 + n * 2 ? a : `${a.slice(0, 2 + n)}…${a.slice(-n)}`;
}

export function timeUntil(unixTs: bigint | number): string {
  const ts = Number(unixTs);
  const seconds = ts - Math.floor(Date.now() / 1000);
  if (seconds <= 0) return "expired";
  const days = Math.floor(seconds / 86_400);
  if (days > 0) return `${days}d`;
  const hours = Math.floor(seconds / 3_600);
  if (hours > 0) return `${hours}h`;
  return `${Math.max(1, Math.floor(seconds / 60))}m`;
}

export function formatDate(unixTs: bigint | number): string {
  return new Date(Number(unixTs) * 1000).toLocaleString("en-US", {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    timeZone: "UTC",
    timeZoneName: "short",
  });
}

/** Parse a decimal string into raw contract units without touching a float. */
export function toRaw(value: string, decimals: number): bigint {
  const trimmed = value.trim();
  if (!trimmed) return 0n;
  const [whole, frac = ""] = trimmed.split(".");
  const padded = (frac + "0".repeat(decimals)).slice(0, decimals);
  return BigInt(whole || "0") * 10n ** BigInt(decimals) + BigInt(padded || "0");
}
