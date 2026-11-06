"use client";

import { fromRaw } from "@/lib/format";
import { DEPLOYMENT } from "@/lib/deployment";

/** The hero number: current best premium, with floor context. */
export function BestPremiumCard({
  best,
  floor,
  bidders,
  decimals,
}: {
  best: bigint | null;
  floor: bigint;
  bidders: number;
  decimals: number;
}) {
  const quote = DEPLOYMENT.quote;
  const above = best !== null && best > 0n ? Number((best - floor) * 10_000n / (floor === 0n ? 1n : floor)) / 100 : null;
  return (
    <div className="text-center">
      <div className="text-dim text-[0.75rem] tracking-[0.12em] uppercase">Best premium per share</div>
      <div className="font-display mt-1 text-5xl tracking-[-0.03em] tabular-nums">
        {best === null ? (
          <span className="text-dim">—</span>
        ) : (
          <>${fromRaw(best, decimals, 2)}</>
        )}
      </div>
      <div className="text-muted mt-2 text-[0.8125rem]">
        {bidders === 0 ? (
          "No bidders yet"
        ) : (
          <>
            {bidders} {bidders === 1 ? "bidder" : "bidders"}
            {above !== null && above >= 0 && (
              <span className="text-p"> · +{above.toFixed(1)}% above floor</span>
            )}
          </>
        )}
      </div>
      <div className="text-dim mt-1 font-mono text-[0.78rem] tabular-nums">
        Floor {fromRaw(floor, decimals, 2)} {quote?.symbol ?? ""}
      </div>
    </div>
  );
}
