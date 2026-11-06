"use client";

import Link from "next/link";
import { fromElsewhere, pctChange, ripCount, signedPct, timeLeft, totalPaid, usd, type RipPosition } from "@/lib/rips/model";
import type { Mark } from "@/lib/rips/use-rips";
import { TickerMark, hueStyle, positionMove } from "./bits";
import { RIPS_SHOW_EXTRAS } from "@/lib/rips/ui";

/**
 * A position as a card. Level 1 only: what it is, what it is worth, how it is
 * doing, how long it has. Everything else is one tap away.
 */
export function RipCard({
  position,
  mark,
  now,
  compact = false,
}: {
  position: RipPosition;
  mark: Mark | undefined;
  now: number;
  compact?: boolean;
}) {
  const paid = totalPaid(position);
  const value = mark?.value ?? null;
  const change = pctChange(value ?? paid, paid);
  const rips = ripCount(position);
  const elsewhere = fromElsewhere(position);
  const up = change > 0.5;
  const down = change < -0.5;
  const left = timeLeft(position.expiryTs, now);
  const move = positionMove(position);
  return (
    <Link
      href={`/rips/position?id=${encodeURIComponent(position.id)}`}
      className={`rip-card block ${compact ? "w-[10.5rem] shrink-0 p-4" : "p-5"}`}
      style={hueStyle(position.symbol)}
      aria-label={`${position.symbol} up ${move}, ${value === null ? "value unavailable" : `worth ${value === null ? "—" : usd(value)}`}, ${position.source === "live" ? (position.live?.heldRaw === "0" ? "No claims held" : value === null ? "No resale quote" : "Settlement estimate") : signedPct(change)}, ${left}`}
    >
      <div className="flex items-center justify-between gap-2">
        <TickerMark symbol={position.symbol} size={compact ? 30 : 36} />
        <span className="text-dim text-right text-[0.75rem] leading-4 tabular-nums">
          {position.termDays > 0 ? `${position.termDays}D` : ""}
          {rips > 1 && <span className="block">{rips} Rips</span>}
        </span>
      </div>
      <p className={`font-display mt-3 break-words leading-none font-semibold tracking-[-0.04em] ${position.symbol.length > 5 ? "text-base" : compact ? "text-xl" : "text-2xl"}`}>
        {position.symbol} <span className="text-p">↑</span>
        <span className="text-muted ml-1 text-[0.7em] font-medium">{move}</span>
      </p>
      <p className={`font-display mt-4 leading-none font-semibold tracking-[-0.04em] tabular-nums ${compact ? "text-[1.6rem]" : "text-[2rem]"}`}>
        {value === null ? (RIPS_SHOW_EXTRAS ? "—" : usd(paid)) : usd(value)}
      </p>
      <div className="mt-2 flex items-center justify-between gap-2 text-[0.8125rem] tabular-nums">
        <span className={up ? "text-p font-medium" : down ? "text-danger font-medium" : "text-muted"}>
          {position.source === "live" ? (position.live?.heldRaw === "0" ? "No claims held" : value === null ? (RIPS_SHOW_EXTRAS ? "No resale quote" : "Spent") : "Settlement estimate") : signedPct(change)}
        </span>
        <span className={left === "Expired" || left.endsWith("h left") || left.endsWith("m left") ? "text-accent-ink" : "text-dim"}>
          {left}
        </span>
      </div>
      {RIPS_SHOW_EXTRAS && mark?.marked === "unavailable" && (
        <p className="text-dim mt-2 text-[0.6875rem] leading-4">Value unavailable · spent {usd(paid)}</p>
      )}
      {RIPS_SHOW_EXTRAS && elsewhere && (
        <p className="text-dim mt-2 text-[0.6875rem] leading-4">Includes Rips from another device</p>
      )}
    </Link>
  );
}
