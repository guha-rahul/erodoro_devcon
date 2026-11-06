export type ShareSubject = { symbol: string; move: string; termDays: number; demo?: boolean; testnet?: boolean; paid?: number };

const SYMBOL = /^[A-Z0-9][A-Z0-9.-]{0,11}$/;
const MOVE = /^(AT|[+−]\d{1,3}(\.5)?%)$/;

/**
 * The link a share carries: the pull itself, so whoever opens it lands on
 * "your friend ripped X -- your turn" instead of a cold page. Only display
 * text travels; nothing in it is trusted beyond being shown.
 */
export function shareLink(s: ShareSubject, origin: string) {
  const q = new URLSearchParams({ r: s.symbol, m: s.move, d: String(s.termDays) });
  if (s.demo) q.set("demo", "1");
  if (s.testnet) q.set("testnet", "1");
  return `${origin}/market-rip?${q}`;
}

/** The pull a shared link describes, or null if the link carries none or was tampered into nonsense. */
export function readShared(search: string): ShareSubject | null {
  const q = new URLSearchParams(search);
  const symbol = q.get("r")?.toUpperCase() ?? "";
  const move = q.get("m") ?? "";
  const termDays = Number(q.get("d"));
  if (!SYMBOL.test(symbol) || (move && !MOVE.test(move)) || !Number.isInteger(termDays) || termDays < 1 || termDays > 400) {
    return null;
  }
  return { symbol, move, termDays, demo: q.get("demo") === "1", testnet: q.get("testnet") === "1" };
}

export const shareText = (s: ShareSubject) =>
  `${s.demo ? "I simulated" : "I bought"} ${s.symbol} ↑${s.move ? ` ${s.move}` : ""} · ${s.termDays}D${s.paid ? ` for $${s.paid.toFixed(2)}` : ""}${s.demo ? " (demo, no funds moved)" : s.testnet ? " (Base Sepolia test assets)" : " on Base"}. Can expire worthless. Your turn:`;
