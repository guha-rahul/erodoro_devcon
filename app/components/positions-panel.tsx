"use client";

import Link from "next/link";
import { useAccount } from "wagmi";
import { usePortfolioBalances } from "@/lib/use-balances";
import { useSeriesList } from "@/lib/use-series";
import { assetFor } from "@/lib/issuers";
import { displayStatus } from "@/lib/market-status";
import { fromRaw, timeUntil } from "@/lib/format";
import { useNow } from "@/lib/use-now";
import { effectiveStrikeUsd, useCollateralMultipliers, useReferencePrices } from "@/lib/use-market-rows";
import { useAuctionActivity } from "@/lib/use-auction-activity";
import { DEPLOYMENT } from "@/lib/deployment";
import { EmptyState, Panel } from "./ui";

/**
 * What the connected account holds.
 *
 * The contract stores current claim balances. It does not store the premium
 * history or acquisition cost, so this panel does not invent either number.
 */
export function PositionsPanel() {
  const { isConnected } = useAccount();
  const marketQuery = useSeriesList();
  const balances = usePortfolioBalances(marketQuery.data);
  const now = useNow();
  const multipliers = useCollateralMultipliers(marketQuery.data);
  const references = useReferencePrices(marketQuery.data);
  const auctionActivity = useAuctionActivity();

  if (!isConnected) {
    return (
      <Panel title="Positions" subtitle="Your stock-income and upside positions">
        <EmptyState
          title="No wallet connected"
          body="Connect a wallet to read your P and N balances from the Base Sepolia vault."
          action={<Link href="/earn" className="underline underline-offset-4">Explore strategies</Link>}
        />
      </Panel>
    );
  }

  if (marketQuery.loading || balances.loading) {
    return <Panel title="Positions"><p className="text-muted text-sm">Loading your positions…</p></Panel>;
  }

  if (marketQuery.error || balances.error) {
    return (
      <Panel title="Positions">
        <EmptyState title="Could not load positions" body={marketQuery.error ?? balances.error ?? "Unknown error"} />
      </Panel>
    );
  }

  const positions = balances.rows.filter((row) => row.p > 0n || row.n > 0n);
  const groups = [
    { title: "Ready to redeem", statuses: ["Redeemable"], description: "Settlement is complete. Review and redeem your remaining claims." },
    { title: "Awaiting settlement", statuses: ["Awaiting settlement"], description: "These positions have expired. Review settlement availability before redeeming." },
    { title: "Active positions", statuses: ["Open", "Paused"], description: "" },
  ].map((group) => ({
    ...group,
    rows: positions.filter(({ series }) => group.statuses.includes(displayStatus(series, now))),
  })).filter((group) => group.rows.length > 0);

  return (
    <Panel title="Positions">
      {positions.length === 0 ? (
        <EmptyState
          title="No positions in this wallet"
          body="This wallet does not hold a P or N claim in a listed Base Sepolia market."
          action={<Link href="/earn" className="underline underline-offset-4">Explore strategies</Link>}
        />
      ) : (
        <div className="grid gap-7">
          {groups.map((group) => (
            <section key={group.title} aria-label={group.title}>
              <h2 className="font-medium">{group.title} <span className="text-dim">({group.rows.length})</span></h2>
              {group.description && <p className="text-dim mt-1 text-sm">{group.description}</p>}
              <div className="mt-3 grid gap-3">
          {group.rows.map(({ series, p, n }) => {
            const asset = assetFor(series.config.collateral);
            const status = displayStatus(series, now);
            const sellPrice = effectiveStrikeUsd(series, multipliers.multiplierFor(series));
            const expired = status === "Awaiting settlement" || status === "Redeemable";
            const activity = auctionActivity.get(series.id.toString());
            const paid = activity?.paid ?? 0n;
            const earned = activity?.earned ?? 0n;
            const quoteDecimals = DEPLOYMENT.quote?.decimals ?? 6;
            const reference = references.referenceFor(series);
            const nQuantity = Number(n) / 10 ** series.config.collateralDecimals;
            const intrinsic = reference && sellPrice !== null ? Math.max(reference.price - sellPrice, 0) * nQuantity : null;
            const positionName = p > 0n && n > 0n ? "Split position" : n > 0n ? "Upside" : "Capped stock";
            const claimAmount = n > 0n ? n : p;
            const quantity = p > 0n && n > 0n
              ? `${fromRaw(p, series.config.collateralDecimals, 4)} capped · ${fromRaw(n, series.config.collateralDecimals, 4)} upside claims`
              : `${fromRaw(claimAmount, series.config.collateralDecimals, 4)} ${claimAmount === 10n ** BigInt(series.config.collateralDecimals) ? "claim" : "claims"}`;
            const capStatus = reference && sellPrice !== null
              ? reference.price > sellPrice ? "Above cap" : reference.price === sellPrice ? "At cap" : "Below cap"
              : "Reference unavailable";
            const nextAction = status === "Redeemable"
              ? "Redeem position"
              : status === "Awaiting settlement"
                ? "Review settlement"
                : "View position";
            return (
              <Link
                key={series.id.toString()}
                href={`/app?market=${series.id.toString(16).padStart(64, "0")}&position=1`}
                className="border-line-soft bg-panel hover:border-accent focus-visible:outline-accent group rounded-md border p-5 transition-colors focus-visible:outline-2 focus-visible:outline-offset-4"
              >
                <div className="flex items-start justify-between gap-4">
                  <div>
                    <p className="text-lg font-medium">{asset?.symbol ?? "Tokenized stock"} {positionName}</p>
                    <p className="text-muted mt-1 text-sm">{quantity} · {expired ? "Expired" : `${timeUntil(series.config.maturity)} left`}</p>
                  </div>
                </div>
                <dl className="mt-5 grid grid-cols-2 gap-x-6 gap-y-4 text-sm">
                  <PositionValue label="Cap" value={sellPrice === null ? "Unavailable" : `$${sellPrice.toFixed(2)}`} />
                  <PositionValue label={reference?.fresh ? "Current reference" : "Last reference"} value={reference ? `$${reference.price.toFixed(2)}` : "Unavailable"} />
                  {n > 0n && <PositionValue label="Paid" value={paid > 0n ? `${fromRaw(paid, quoteDecimals, 2)} ${DEPLOYMENT.quote?.symbol ?? "USDC"}` : "Unavailable"} />}
                  {(p > 0n || earned > 0n) && <PositionValue label="Premium earned" value={earned > 0n ? `${fromRaw(earned, quoteDecimals, 2)} ${DEPLOYMENT.quote?.symbol ?? "USDC"}` : "—"} />}
                  {n > 0n && !expired && (
                    <PositionValue
                      label="Estimated payoff"
                      value={intrinsic === null ? "Unavailable" : `$${intrinsic.toFixed(2)}`}
                    />
                  )}
                </dl>
                <div className="border-line-soft mt-5 flex flex-wrap items-center justify-between gap-3 border-t pt-3">
                  <span className="text-dim text-xs">{expired || status === "Paused" ? status : `${capStatus}${reference && !reference.fresh ? " · last reference" : ""}`}</span>
                  <span className="text-text text-sm font-medium group-hover:text-accent-ink">{nextAction} →</span>
                </div>
              </Link>
            );
          })}
              </div>
            </section>
          ))}
        </div>
      )}
    </Panel>
  );
}

function PositionValue({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt className="text-dim text-xs">{label}</dt>
      <dd className="mt-1 break-words font-mono tabular-nums">{value}</dd>
    </div>
  );
}
