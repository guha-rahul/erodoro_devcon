"use client";

import { DEPLOYMENT } from "@/lib/deployment";
import { assetFor } from "@/lib/issuers";
import {
  annualizedPremiumPct,
  distanceToStrike,
  strikeUsd,
  effectiveStrikeUsd,
  useCollateralMultipliers,
  useMarketPremiums,
  useReferencePrices,
} from "@/lib/use-market-rows";
import { useNow } from "@/lib/use-now";
import { useRole } from "@/lib/use-role";
import type { Series } from "@/lib/types";
import { Panel } from "./ui";
import { RoleToggle } from "./role-toggle";
import { StrategyPayoff } from "./strategy-payoff";

/** Product terms for one market. Protocol identifiers stay in advanced details. */
export function OpportunityPanel({ series }: { series: Series }) {
  const [role] = useRole();
  const now = useNow();
  const references = useReferencePrices([series]);
  const bids = useMarketPremiums([series]);
  const multipliers = useCollateralMultipliers([series]);
  const asset = assetFor(series.config.collateral);
  const spot = references.spotFor(series);
  const bid = bids.bidFor(series);
  const distance = distanceToStrike(series, spot, multipliers.multiplierFor(series));
  const sellPrice = effectiveStrikeUsd(series, multipliers.multiplierFor(series));
  const annualized = annualizedPremiumPct(series, bid, spot, now, multipliers.multiplierFor(series));
  const quoteSymbol = DEPLOYMENT.quote?.symbol ?? "USDC";
  const multiplier = multipliers.multiplierFor(series);
  const tokenSpot = spot !== null && multiplier !== null ? spot * Number(multiplier) / 1e18 : null;
  const tokenCap = strikeUsd(series) * Number(series.config.multiplierAtCreation) / 1e18;

  return (
    <Panel
      tour="market-summary"
      title={role === "seller" ? `Earn on ${asset?.symbol ?? "this stock"}` : `Trade ${asset?.symbol ?? "stock"} upside`}
      subtitle={role === "seller" ? "Pick a sell price and get paid for the upside" : "Buy gains above the sell price without a liquidation"}
    >
      <RoleToggle />
      <dl className="mt-5 grid grid-cols-2 gap-4 sm:grid-cols-4">
        <OpportunityValue label="Reference" value={references.loading ? "…" : spot === null ? "Unavailable" : `$${spot.toFixed(2)}`} />
        <OpportunityValue label="Adjusted sell price" value={sellPrice === null ? "Unavailable" : `$${sellPrice.toFixed(2)}`} />
        <OpportunityValue label="Upside to sell price" value={distance === null ? "Unavailable" : `${distance >= 0 ? "+" : ""}${distance.toFixed(1)}%`} />
        <OpportunityValue
          label={role === "seller" ? "Funded premium" : "Maker bid to sellers"}
          value={bids.loading ? "…" : bid === null ? "No live bid" : `${bid.premium.toFixed(2)} ${quoteSymbol} / ${asset?.symbol ?? "token"}`}
          tone={bid ? "positive" : undefined}
        />
      </dl>
      {role === "seller" && (
        <div className="border-line-soft mt-5 flex items-baseline justify-between gap-4 border-t pt-4">
          <span className="text-muted text-sm">Simple annualized premium*</span>
          <span className="font-mono text-lg tabular-nums">{annualized === null ? "Unavailable" : `${annualized.toFixed(1)}%`}</span>
        </div>
      )}
      <p className="text-dim mt-3 text-[0.75rem] leading-5">
        {role === "seller"
          ? "* This value uses the current funded bid, reference price, and remaining term. It excludes fees and does not compound."
          : "The maker bid is not a retail sell offer. Erodoro does not support buyer execution yet, so buyer cost and break-even are unavailable."}
      </p>
      {role === "seller" && series.config.settlementModel === 0 &&
        tokenSpot !== null && Number.isFinite(tokenSpot) && tokenSpot > 0 &&
        Number.isFinite(tokenCap) && tokenCap > 0 && !series.settlement?.settled && (
          <StrategyPayoff key={series.id.toString()} tokenSpot={tokenSpot} tokenCap={tokenCap} premium={bid?.premium ?? null} />
        )}
    </Panel>
  );
}

function OpportunityValue({ label, value, tone }: { label: string; value: string; tone?: "positive" }) {
  return (
    <div>
      <dt className="text-dim text-[0.75rem] tracking-[0.08em] uppercase">{label}</dt>
      <dd className={`mt-1 font-mono text-sm tabular-nums ${tone === "positive" ? "text-p" : ""}`}>{value}</dd>
    </div>
  );
}
