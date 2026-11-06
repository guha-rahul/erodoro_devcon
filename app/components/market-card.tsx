"use client";

import { displayStatus } from "@/lib/market-status";
import { assetFor } from "@/lib/issuers";
import { DEPLOYMENT } from "@/lib/deployment";
import { fromRaw, timeUntil } from "@/lib/format";
import {
  annualizedPremiumPct,
  distanceToStrike,
  effectiveStrikeUsd,
  type MarketBid,
} from "@/lib/use-market-rows";
import { useNow } from "@/lib/use-now";
import type { Series } from "@/lib/types";
import { StatusPill } from "./status-pill";

/**
 * One market, for a narrow screen.
 *
 * A table with eight columns does not survive a phone — it becomes a sideways
 * scroll where the column that matters is always off-screen. Three figures and
 * a status is what fits and what someone actually scans for.
 */
export function MarketCard({
  series,
  spot,
  bid,
  bidLoading,
  multiplier,
  starred,
  onStar,
  onOpen,
}: {
  series: Series;
  spot: number | null;
  bid: MarketBid | null;
  bidLoading: boolean;
  multiplier: bigint | null;
  starred: boolean;
  onStar: () => void;
  onOpen: () => void;
}) {
  const now = useNow();
  const asset = assetFor(series.config.collateral);
  const status = displayStatus(series, now);
  const symbol = DEPLOYMENT.quote?.symbol ?? "";
  const distance = distanceToStrike(series, spot, multiplier);
  const sellPrice = effectiveStrikeUsd(series, multiplier);
  const annualized = annualizedPremiumPct(series, bid, spot, now, multiplier);

  return (
    <button
      type="button"
      data-tour="series-card"
      onClick={onOpen}
      className="border-line bg-panel hover:border-text w-full rounded-md border p-3 text-left transition-colors"
    >
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="font-medium">
            {asset?.symbol ?? "Unknown"} / {symbol}
          </div>
          <div className="text-dim mt-0.5 text-[0.75rem]">{asset?.name ?? "Tokenized stock"}</div>
        </div>
        <div className="flex items-center gap-2">
          <StatusPill status={status} />
          {/* A span, not a button: a button inside a button is invalid markup
              and browsers resolve it by dropping one of them. */}
          <span
            role="button"
            data-tour-no-advance
            tabIndex={0}
            aria-label={starred ? "Unstar this market" : "Star this market"}
            onClick={(e) => {
              e.stopPropagation();
              onStar();
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter" || e.key === " ") {
                e.preventDefault();
                e.stopPropagation();
                onStar();
              }
            }}
            className={`leading-none ${starred ? "text-accent" : "text-dim"}`}
          >
            {starred ? "★" : "☆"}
          </span>
        </div>
      </div>
      <dl className="mt-3 grid grid-cols-2 gap-x-3 gap-y-3 text-[0.8125rem]">
        <Cell label="Adjusted sell price" value={sellPrice === null ? "Unavailable" : `$${sellPrice.toFixed(2)}`} />
        <Cell label="Settlement reference" value={spot === null ? "Unavailable" : `$${spot.toFixed(2)}`} />
        <Cell
          label="Upside retained"
          value={distance === null ? "Unavailable" : `${distance >= 0 ? "+" : ""}${distance.toFixed(1)}%`}
        />
        <Cell
          label="Expiry"
          value={status === "Redeemable" || status === "Awaiting settlement" ? "Expired" : timeUntil(series.config.maturity)}
        />
      </dl>
      <div className="border-line-soft mt-3 border-t pt-3">
        {status !== "Open" && status !== "Paused" ? (
          <p className="text-dim text-sm">Trading has ended for this market.</p>
        ) : bid === null ? (
          <div>
            <p className="font-medium">{bidLoading ? "Checking funded bids…" : "No live bid"}</p>
            {!bidLoading && <p className="text-dim mt-0.5 text-[0.75rem]">There is no funded buyer for this strike.</p>}
          </div>
        ) : (
          <div className="flex items-end justify-between gap-3">
            <div>
              <p className="text-dim text-[0.7rem] tracking-[0.08em] uppercase">Best funded bid</p>
              <p className="text-p mt-0.5 font-mono">{bid.premium.toFixed(2)} {symbol} / {asset?.symbol ?? "token"}</p>
              <p className="text-dim mt-0.5 text-[0.72rem]">Expires {timeUntil(bid.expiry)}</p>
            </div>
            <div className="text-right">
              <p className="text-dim text-[0.7rem] tracking-[0.08em] uppercase">Annualized premium*</p>
              <p className="mt-0.5 font-mono">{annualized === null ? "—" : `${annualized.toFixed(1)}%`}</p>
              <p className="text-dim mt-0.5 text-[0.72rem]">
                Funded size {fromRaw(bid.quoteSize, series.config.collateralDecimals, 4)} {asset?.symbol ?? "stock"} upside
              </p>
            </div>
          </div>
        )}
      </div>
    </button>
  );
}

function Cell({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt className="text-dim text-[0.7rem] tracking-[0.08em] uppercase">{label}</dt>
      <dd className="font-mono">{value}</dd>
    </div>
  );
}
