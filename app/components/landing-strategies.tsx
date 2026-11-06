"use client";

import Link from "next/link";
import { useSeriesList } from "@/lib/use-series";
import { useNow } from "@/lib/use-now";
import { useRole } from "@/lib/use-role";
import { assetFor } from "@/lib/issuers";
import { DEPLOYMENT } from "@/lib/deployment";
import { formatDate } from "@/lib/format";
import { annualizedPremiumPct, effectiveStrikeUsd, useCollateralMultipliers, useMarketPremiums, useReferencePrices } from "@/lib/use-market-rows";
import { WaitlistButton } from "@/components/waitlist-button";

export function LandingStrategies() {
  const markets = useSeriesList();
  const now = useNow();
  const [, setRole] = useRole();
  const active = markets.data.filter((series) => now > 0n && series.config.maturity > now && !series.settlement?.settled && !series.config.splitsPaused);
  const bids = useMarketPremiums(active);
  const references = useReferencePrices(active);
  const multipliers = useCollateralMultipliers(active);
  const opportunities = active.flatMap((series) => {
    const bid = bids.bidFor(series);
    if (!bid) return [];
    return [{ series, bid, rate: annualizedPremiumPct(series, bid, references.spotFor(series), now, multipliers.multiplierFor(series)) }];
  }).sort((a, b) => (b.rate ?? -1) - (a.rate ?? -1)).slice(0, 3);
  const loading = markets.loading || bids.loading || now === 0n;

  return (
    <section className="border-line border-b" aria-labelledby="landing-strategies">
      <div className="mx-auto max-w-6xl px-6 py-12">
        <h2 id="landing-strategies" className="display-3">Find your stock strategy</h2>
        <p className="text-muted mt-3 max-w-[65ch]">Compare sell prices and expiry dates. Premium appears when a funded maker bid is available.</p>
        {markets.error ? <p role="alert" className="text-muted mt-6">Strategies could not be loaded. Try again from Earn.</p>
          : loading ? <p role="status" className="text-muted mt-6">Checking current strategies…</p>
          : opportunities.length === 0 ? <p className="text-muted mt-6">No active strategies have a funded bid right now. Explore the listed markets and their terms.</p>
          : <div className="mt-6 grid gap-4 md:grid-cols-3">
            {opportunities.map(({ series, bid, rate }) => {
              const asset = assetFor(series.config.collateral);
              const sellPrice = effectiveStrikeUsd(series, multipliers.multiplierFor(series));
              return <article key={series.id.toString()} className="border-line bg-panel rounded-md border p-5">
                <h3 className="text-lg font-medium">{asset?.name ?? "Tokenized stock"}</h3>
                <p className="text-dim text-sm">{asset?.symbol ?? "Stock"} · {DEPLOYMENT.chainName}</p>
                <dl className="mt-4 grid gap-3 text-sm">
                  <div><dt className="text-muted">Adjusted sell price</dt><dd className="font-mono">{sellPrice === null ? "Unavailable" : `$${sellPrice.toFixed(2)}`}</dd></div>
                  <div><dt className="text-muted">Expiry</dt><dd>{formatDate(series.config.maturity)}</dd></div>
                  <div><dt className="text-muted">Premium per token</dt><dd className="font-mono">{bid.premium.toFixed(2)} {DEPLOYMENT.quote?.symbol}</dd></div>
                  <div><dt className="text-muted">Annualized premium*</dt><dd className="font-mono">{rate === null ? "Unavailable" : `${rate.toFixed(1)}%`}</dd></div>
                </dl>
                <Link href={`/app/${series.id.toString(16)}`} onClick={() => setRole("seller")} className="mt-5 inline-block underline underline-offset-4">Review strategy</Link>
              </article>;
            })}
          </div>}
        {opportunities.length > 0 && <p className="text-dim mt-4 text-xs">* Simple annualization of the current one-token bid; excludes fees and does not compound. Request a fresh quote for your amount before selling.</p>}
        <WaitlistButton className="mt-6 inline-flex items-center gap-1 underline underline-offset-4" />
      </div>
    </section>
  );
}
