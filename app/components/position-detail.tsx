"use client";

import Link from "next/link";
import { ActionsPanel } from "./actions-panel";
import { Panel } from "./ui";
import { assetFor } from "@/lib/issuers";
import { DEPLOYMENT } from "@/lib/deployment";
import { fromRaw, timeUntil } from "@/lib/format";
import { displayStatus, isMatured } from "@/lib/market-status";
import { useAuctionActivity } from "@/lib/use-auction-activity";
import { useSeriesBalances } from "@/lib/use-balances";
import { effectiveStrikeUsd, useCollateralMultipliers, useReferencePrices } from "@/lib/use-market-rows";
import { useNow } from "@/lib/use-now";
import type { Series } from "@/lib/types";

/** A holder-first view of one position. Trading and market configuration live elsewhere. */
export function PositionDetail({ series }: { series: Series }) {
  const asset = assetFor(series.config.collateral);
  const balances = useSeriesBalances(series.id, series.config.collateral);
  const activity = useAuctionActivity().get(series.id.toString());
  const multipliers = useCollateralMultipliers([series]);
  const references = useReferencePrices([series]);
  const now = useNow();

  const hasUpside = balances.n > 0n;
  const hasCapped = balances.p > 0n;
  const claim = hasUpside ? balances.n : balances.p;
  const quantity = Number(claim) / 10 ** series.config.collateralDecimals;
  const cap = effectiveStrikeUsd(series, multipliers.multiplierFor(series));
  const reference = references.referenceFor(series);
  const payoff = hasUpside && cap !== null && reference
    ? Math.max(reference.price - cap, 0) * quantity
    : null;
  const paid = activity?.paid ?? 0n;
  const earned = activity?.earned ?? 0n;
  const premiumText = (amount: bigint) => `${fromRaw(amount, DEPLOYMENT.quote?.decimals ?? 6, 2)} ${DEPLOYMENT.quote?.symbol ?? "USDC"}`;
  const title = hasUpside && hasCapped ? "Split position" : hasUpside ? "Upside position" : hasCapped ? "Capped stock position" : "Position";
  const capStatus = reference && cap !== null
    ? reference.price > cap ? "Above cap" : reference.price === cap ? "At cap" : "Below cap"
    : "Reference unavailable";
  const matured = isMatured(series, now);

  return (
    <div className="mx-auto max-w-3xl">
      <Link href="/portfolio" className="text-muted hover:text-text text-sm underline underline-offset-4">
        ← Portfolio
      </Link>

      <div className="mt-6 flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="font-display text-3xl tracking-[-0.04em]">
            {asset?.symbol ?? "Stock"} {title}
          </h1>
          <p className="text-muted mt-2">
            {hasUpside && hasCapped
              ? "You hold both the capped stock and its upside."
              : hasUpside
              ? `You receive the value above ${cap === null ? "the cap" : `$${cap.toFixed(2)}`} at expiry.`
              : `You retain the stock value up to ${cap === null ? "the cap" : `$${cap.toFixed(2)}`}.`}
          </p>
        </div>
        <span className="border-line text-muted rounded-full border px-3 py-1 text-xs tracking-[0.08em] uppercase">
          {displayStatus(series, now)}
        </span>
      </div>

      <div className="mt-6">
        <Panel title="Your position">
          <dl className="grid grid-cols-2 gap-x-6 gap-y-5 sm:grid-cols-3">
          {hasUpside && hasCapped ? <>
            <PositionStat label="Capped claims" value={fromRaw(balances.p, series.config.collateralDecimals, 4)} />
            <PositionStat label="Upside claims" value={fromRaw(balances.n, series.config.collateralDecimals, 4)} />
          </> : <PositionStat label="Claims" value={fromRaw(claim, series.config.collateralDecimals, 4)} />}
          <PositionStat label="Cap" value={cap === null ? "Unavailable" : `$${cap.toFixed(2)}`} />
          <PositionStat label={reference?.fresh ? "Current reference" : "Last reference"} value={reference ? `$${reference.price.toFixed(2)}` : "Unavailable"} />
          <PositionStat label="Expires" value={matured ? "Expired" : `${timeUntil(series.config.maturity)} remaining`} />
          {hasUpside && (
            <PositionStat label="Paid" value={paid > 0n ? premiumText(paid) : "Unavailable"} />
          )}
          {(hasCapped || earned > 0n) && <PositionStat label="Premium earned" value={earned > 0n ? premiumText(earned) : "—"} />}
          {hasUpside && !matured && <PositionStat label="Estimated upside payoff" value={payoff === null ? "Unavailable" : `$${payoff.toFixed(2)}`} />}
          <PositionStat label="Status" value={matured ? displayStatus(series, now) : capStatus} />
          </dl>
          {hasUpside && !matured && (
            <p className="text-dim border-line-soft mt-6 border-t pt-4 text-xs leading-5">
              Estimated payoff uses the {reference?.fresh ? "current" : "last available"} reference price, before the premium you paid.
              {reference && !reference.fresh && " This reference is stale or simulated."} Final payoff is determined at settlement.
            </p>
          )}
        </Panel>
      </div>

      {hasUpside && cap !== null && (
        <div className="mt-6">
          <Panel title="How your payoff works">
            <p className="text-muted text-sm leading-6">
              At or below <span className="text-text font-mono">${cap.toFixed(2)}</span>, the upside payoff is $0.
              Above it, each claim receives the amount over the cap.
            </p>
          </Panel>
        </div>
      )}

      {matured && (
        <div className="mt-6">
          <ActionsPanel series={series} onDone={() => window.location.reload()} />
        </div>
      )}
    </div>
  );
}

function PositionStat({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt className="text-dim text-xs">{label}</dt>
      <dd className="mt-1 break-words font-mono tabular-nums">{value}</dd>
    </div>
  );
}
