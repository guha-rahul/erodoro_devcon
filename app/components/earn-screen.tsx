"use client";

import Link from "next/link";
import { useAccount } from "wagmi";
import { useStockBalances, type StockRow } from "@/lib/use-stock-balances";
import { useSeriesList } from "@/lib/use-series";
import { fromRaw } from "@/lib/format";
import { toShareEquivalent } from "@/lib/use-b20";
import { isMatured } from "@/lib/market-status";
import {
  annualizedPremiumPct,
  useCollateralMultipliers,
  useMarketPremiums,
  useReferencePrices,
} from "@/lib/use-market-rows";
import { useNow } from "@/lib/use-now";
import { useRole } from "@/lib/use-role";
import { DEPLOYMENT } from "@/lib/deployment";
import type { Series } from "@/lib/types";
import { Button, Panel } from "./ui";

/**
 * The retail entry point: start from a stock you hold, not from a market.
 *
 * `/app` asks which market you want. That is the right question for someone who
 * already understands the instrument and the wrong first question for everyone
 * else — this page starts from what is in the wallet.
 */
export function EarnScreen() {
  const { isConnected } = useAccount();
  const { rows, loading } = useStockBalances();
  const { data: series, loading: marketsLoading, error: marketsError } = useSeriesList();
  const now = useNow();
  const activeSeries = series.filter((s) => !isMatured(s, now));
  const references = useReferencePrices(activeSeries);
  const bids = useMarketPremiums(activeSeries);
  const multipliers = useCollateralMultipliers(activeSeries);

  const strategiesFor = (token: string) =>
    activeSeries.filter((s) => s.config.collateral.toLowerCase() === token.toLowerCase());

  if (marketsError) {
    return <Panel title="Could not load strategies"><p role="alert" className="text-muted text-sm">{marketsError}</p></Panel>;
  }
  if (marketsLoading) {
    return <Panel title="Strategies"><p role="status" className="text-muted text-sm">Loading stock strategies…</p></Panel>;
  }

  return (
    <div className="grid gap-4 sm:grid-cols-2">
      {rows.map((row) => (
        <StockCard
          key={row.token}
          row={row}
          strategies={strategiesFor(row.token)}
          connected={isConnected}
          loading={loading}
          referenceFor={references.spotFor}
          bidFor={bids.bidFor}
          quoteLoading={references.loading || bids.loading}
          now={now}
          multiplierFor={multipliers.multiplierFor}
        />
      ))}
    </div>
  );
}

function StockCard({
  row,
  strategies,
  connected,
  loading,
  referenceFor,
  bidFor,
  quoteLoading,
  now,
  multiplierFor,
}: {
  row: StockRow;
  strategies: Series[];
  connected: boolean;
  loading: boolean;
  referenceFor: (series: Series) => number | null;
  bidFor: ReturnType<typeof useMarketPremiums>["bidFor"];
  quoteLoading: boolean;
  now: bigint;
  multiplierFor: ReturnType<typeof useCollateralMultipliers>["multiplierFor"];
}) {
  const [, setRole] = useRole();
  const held = row.balance > 0n;
  const shares = row.shares ?? toShareEquivalent(row.balance, row.multiplier);
  const reference = strategies.map(referenceFor).find((value) => value !== null) ?? null;
  const opportunities = strategies.flatMap((series) => {
    const bid = bidFor(series);
    const spot = referenceFor(series);
    const annualized = annualizedPremiumPct(series, bid, spot, now, multiplierFor(series));
    return bid && annualized !== null ? [{ bid, annualized }] : [];
  });
  const best = opportunities.sort((a, b) => b.annualized - a.annualized)[0] ?? null;
  const quoteSymbol = DEPLOYMENT.quote?.symbol ?? "";

  return (
    <Panel title={row.name} subtitle={row.symbol}>
      <dl className="grid gap-2 text-[0.875rem]">
        <Row
          label="Your balance"
          value={!connected ? "Connect a wallet" : loading ? "…" : `${fromRaw(shares, row.decimals, 4)} shares`}
        />
        <Row
          label="Settlement reference"
          value={
            quoteLoading
              ? "…"
              : reference === null
                ? "Unavailable"
                : `$${reference.toFixed(2)}`
          }
        />
        <Row
          label="Best funded bid"
          value={
            quoteLoading
              ? "…"
              : best === null
                ? "No live bid"
                : `${best.bid.premium.toFixed(2)} ${quoteSymbol} / ${row.symbol}`
          }
        />
        <Row
          label="Best annualized premium*"
          value={quoteLoading ? "…" : best === null ? "Unavailable" : `${best.annualized.toFixed(1)}%`}
        />
        <Row
          label="Strategies available"
          value={strategies.length === 0 ? "None yet" : String(strategies.length)}
        />
      </dl>

      {row.isTestAsset && (
        <p className="text-dim mt-3 text-[0.78rem]">
          A test asset, not a security. It exists so the flow can be exercised on a test network.
        </p>
      )}

      <p className="text-dim mt-3 text-[0.72rem]">
        * Simple annualized premium uses a current funded bid. It excludes fees and does not compound.
      </p>

      <div className="mt-4">
        {strategies.length > 0 ? (
          <Link
            href={`/app?stock=${row.token}`}
            onClick={() => setRole("seller")}
            className="bg-text hover:bg-accent text-bg inline-flex rounded-sm px-4 py-2 text-[0.8125rem] font-medium transition-colors"
          >
            View strategies
          </Link>
        ) : (
          <Button disabled disabledReason={`No active ${row.symbol} strategies are listed.`}>
            No strategies available
          </Button>
        )}
        {connected && !held && (
          <>
            <p className="text-muted text-sm">You don&rsquo;t hold {row.symbol} yet.</p>
            <p className="text-dim mt-2 text-[0.78rem]">
              Stock purchases are not available in Erodoro yet. You can browse strategies before acquiring the stock.
            </p>
          </>
        )}
      </div>
    </Panel>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="border-line-soft flex items-start justify-between gap-3 border-t pt-2 first:border-t-0 first:pt-0">
      <dt className="text-dim min-w-0">{label}</dt>
      <dd className="min-w-0 text-right font-mono tabular-nums">{value}</dd>
    </div>
  );
}
