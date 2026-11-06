"use client";

import type { Series } from "@/lib/types";
import { effectiveStrikeUsd, useCollateralMultipliers } from "@/lib/use-market-rows";
import { Panel } from "./ui";

/** The public RFQ has maker bids for sellers. It has no retail offer path. */
export function TradeUpsidePanel({ series }: { series: Series }) {
  const multipliers = useCollateralMultipliers([series]);
  const sellPrice = effectiveStrikeUsd(series, multipliers.multiplierFor(series));
  return (
    <Panel title="Trade upside" subtitle="Buyer execution is not live">
      <p className="text-muted text-sm leading-6">
        This market can accept funded bids from configured makers. It cannot sell the upside claim to a retail buyer yet.
      </p>
      <dl className="mt-4 grid gap-2 text-[0.875rem]">
        <Row label="Buyer cost" value="Unavailable" />
        <Row label="Maximum loss" value="Unavailable until an offer exists" />
        <Row label="Break-even" value="Unavailable until an offer exists" />
        <Row label="Claim" value={sellPrice === null ? "Adjusted sell price unavailable" : `Upside above the $${sellPrice.toFixed(2)} adjusted sell price`} />
      </dl>
      <p className="text-dim mt-4 text-[0.78rem] leading-5">
        A separate signed sell-order or maker-offer path must exist before this screen can enable a Buy action.
      </p>
    </Panel>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="border-line-soft flex items-start justify-between gap-4 border-t pt-2 first:border-0 first:pt-0">
      <dt className="text-dim">{label}</dt>
      <dd className="text-right font-mono tabular-nums">{value}</dd>
    </div>
  );
}
