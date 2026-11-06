"use client";

import { useNow } from "@/lib/use-now";

/** mm:ss (or hh:mm:ss) tabular countdown to a unix timestamp. */
export function AuctionCountdown({ endsAt, prefix = "Closes in" }: { endsAt: number; prefix?: string }) {
  const now = useNow();
  const left = Math.max(0, endsAt - Number(now));
  const h = Math.floor(left / 3600);
  const m = Math.floor((left % 3600) / 60);
  const s = left % 60;
  const text =
    h > 0
      ? `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`
      : `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
  return (
    <div>
      <div className="text-dim text-[0.72rem] tracking-[0.08em] uppercase">{prefix}</div>
      <div className="font-mono text-2xl font-medium tabular-nums" role="timer">
        {text}
      </div>
    </div>
  );
}
