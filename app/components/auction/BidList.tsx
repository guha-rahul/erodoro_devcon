"use client";

import { fromRaw } from "@/lib/format";
import { DEPLOYMENT } from "@/lib/deployment";
import type { AuctionBid } from "@/lib/use-intent";

/**
 * Compact bid panel — a ranked list, not a book. No depth, no ladders,
 * no maker/taker volume. Best bid is flagged; ties already broke upstream
 * (higher premium → earlier receipt).
 */
export function BidList({ bids, decimals, claimDecimals }: { bids: AuctionBid[]; decimals: number; claimDecimals: number }) {
  const quote = DEPLOYMENT.quote;
  if (bids.length === 0) {
    return <p className="text-dim text-sm">No bids yet. Bidders compete here once the auction is live.</p>;
  }
  const unit = 10n ** BigInt(claimDecimals);
  const ranked = [...bids].sort((a, b) => {
    const left = BigInt(b.premium) * BigInt(a.amount);
    const right = BigInt(a.premium) * BigInt(b.amount);
    return left === right ? 0 : left > right ? 1 : -1;
  });
  return (
    <ul className="divide-line-soft divide-y">
      {ranked.map((b, i) => (
        <li key={`${b.bidder}:${b.receivedAt}:${i}`} className="flex items-center justify-between gap-4 py-2 text-sm">
          <span className="text-muted font-mono tabular-nums">
            {fromRaw((BigInt(b.premium) * unit + BigInt(b.amount) - 1n) / BigInt(b.amount), decimals, 2)} {quote?.symbol ?? ""} / share
          </span>
          <span className="flex items-center gap-2">
            <span className="text-dim font-mono text-[0.78rem]">
              {b.bidder.slice(0, 6)}…{b.bidder.slice(-4)}
            </span>
            {i === 0 && (
              <span className="border-accent text-accent-ink rounded-sm border px-1.5 py-px text-[0.68rem] tracking-[0.08em] uppercase">
                Best
              </span>
            )}
          </span>
        </li>
      ))}
    </ul>
  );
}
