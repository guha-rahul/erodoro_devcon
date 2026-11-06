"use client";

import Link from "next/link";
import { useSeries } from "@/lib/use-series";
import { assetFor } from "@/lib/issuers";
import { formatDate, fromRaw, priceToUsd, timeUntil } from "@/lib/format";
import { nId, pId, type Series } from "@/lib/types";
import { AddressLink, EmptyState, Panel } from "./ui";
import { ActionsPanel } from "./actions-panel";
import { OraclePanel } from "./oracle-panel";
import { SellUpsidePanel } from "./sell-upside-panel";
import { IntentPanel } from "./intent-panel";
import { BidPanel } from "./bid-panel";
import { DisclosuresPanel } from "./disclosures-panel";
import { MarketProfile } from "./market-profile";
import { OpportunityPanel } from "./opportunity-panel";
import { LiveAuctionView } from "./auction/LiveAuctionView";
import { useRole } from "@/lib/use-role";
import { useNow } from "@/lib/use-now";
import { displayStatus, isMatured } from "@/lib/market-status";
import { PositionDetail } from "./position-detail";

export function SeriesDetail({ id, auctionHash, positionView = false }: { id: bigint | null; auctionHash?: `0x${string}` | null; positionView?: boolean }) {
  const { data: series, loading, error } = useSeries(id);
  const [role] = useRole();
  const now = useNow();

  if (loading) return <p className="text-muted py-10 text-sm">Loading market…</p>;
  if (error) return <EmptyState title="Could not load this market" body={error} />;

  if (!series) {
    return (
      <EmptyState
        title="Market not found"
        body="No market with that id. It may never have existed, or it may not be canonical."
        action={
          <Link href="/app" className="underline underline-offset-4">
            Back to markets
          </Link>
        }
      />
    );
  }

  const asset = assetFor(series.config.collateral);
  const dp = series.config.collateralDecimals;

  if (positionView) return <PositionDetail series={series} />;

  if (auctionHash && !series.settlement?.settled) {
    return (
      <div>
        <div className="mb-5 flex flex-wrap items-center justify-between gap-3">
          <Link href="/auctions" className="text-muted hover:text-text text-sm underline underline-offset-4">
            ← Live auctions
          </Link>
          <span className="text-dim font-mono text-[0.72rem] tracking-[0.08em] uppercase">
            {asset?.symbol ?? "Stock"} · ${priceToUsd(series.config.strike, series.config.priceDecimals).replace("$", "")} cap
          </span>
        </div>
        <LiveAuctionView series={series} auctionHash={auctionHash} />
      </div>
    );
  }

  return (
    <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_22rem]">
      <div className="grid gap-6">
        <OpportunityPanel series={series} />

        <Panel title={`${asset?.symbol ?? "Market"} position`} subtitle={asset?.name}>
          <dl className="grid grid-cols-2 gap-4 sm:grid-cols-4">
            <Stat label="Status" value={displayStatus(series, now)} />
            <Stat label="Expiry" value={timeUntil(series.config.maturity)} hint={formatDate(series.config.maturity)} />
            <Stat label="Locked" value={fromRaw(series.locked, dp, 4)} />
            <Stat label="Original strike" value={priceToUsd(series.config.strike, series.config.priceDecimals)} hint="Configured at market creation, before any corporate-action adjustment" />
          </dl>
        </Panel>

        {series.settlement?.settled && <SettlementPanel series={series} />}
        <div data-tour="market-actions" className="grid gap-6">
          {isMatured(series, now) ? (
            <ActionsPanel series={series} onDone={() => window.location.reload()} />
          ) : role === "seller" ? (
            <>
              <ActionsPanel series={series} onDone={() => window.location.reload()} />
              {!series.settlement?.settled && (
                <SellUpsidePanel series={series} onDone={() => window.location.reload()} />
              )}
              {!series.settlement?.settled && (
                <IntentPanel series={series} onDone={() => window.location.reload()} />
              )}
            </>
          ) : (
            <BidPanel series={series} />
          )}
        </div>

        <details className="border-line bg-panel rounded-md border">
          <summary className="text-muted hover:text-text cursor-pointer px-5 py-4 text-sm">Advanced claim details</summary>
          <div className="border-line-soft grid gap-4 border-t p-5 sm:grid-cols-2">
            <ClaimCard tone="p" title="P · Capped equity claim" body="Receives the collateral value up to the strike." id={pId(series.id)} />
            <ClaimCard tone="n" title="N · Upside claim" body="Receives only the value above the strike. Can expire worthless." id={nId(series.id)} />
          </div>
        </details>
      </div>

      <div className="grid content-start gap-6">
        <OraclePanel series={series} />
        <details className="border-line bg-panel rounded-md border">
          <summary className="text-muted hover:text-text cursor-pointer px-5 py-4 text-sm">Contract details and configuration</summary>
          <div className="border-line-soft grid gap-5 border-t p-5">
          <dl className="grid gap-3 text-[0.875rem]">
            <Term label="Settlement delay" value={`${series.config.settlementDelay}s`} />
            <Term label="Max price lag" value={`${series.config.maxPriceLag}s`} />
            <Term label="Confidence policy" value={`${series.config.maxConfBps} bps`} />
            <Term label="Protocol fee" value={`${series.config.feeBps} bps`} />
            <Term label="Price decimals" value={String(series.config.priceDecimals)} />
          </dl>
          <div className="grid gap-3">
            <AddressLink label="Collateral" address={series.config.collateral} />
            <AddressLink label="Oracle" address={series.config.oracle} />
          </div>
          </div>
        </details>
        <DisclosuresPanel token={series.config.collateral} />
        <MarketProfile series={series} />
      </div>
    </div>
  );
}

function SettlementPanel({ series }: { series: Series }) {
  const st = series.settlement!;
  const dp = series.config.collateralDecimals;
  return (
    <Panel title="Settled" subtitle={formatDate(st.settledTs)}>
      <dl className="grid grid-cols-2 gap-4 sm:grid-cols-4">
        <Stat label="Price" value={priceToUsd(st.price, series.config.priceDecimals)} />
        <Stat label="Effective strike" value={priceToUsd(st.effectiveStrike, series.config.priceDecimals)} />
        <Stat label="P pool" value={fromRaw(st.pPool, dp, 4)} tone="p" />
        <Stat label="N pool" value={fromRaw(st.nPool, dp, 4)} tone="n" />
      </dl>
      {(st.shortfallObserved || st.supplyMismatch || st.underCollateralized) && (
        <ul className="border-n/30 bg-n/8 text-n mt-4 grid gap-1 rounded-sm border px-3 py-2.5 text-[0.82rem]">
          {st.shortfallObserved && <li>Shortfall observed — payouts are haircut proportionally.</li>}
          {st.supplyMismatch && <li>Claim supplies disagree — someone burned a claim outside the protocol.</li>}
          {st.underCollateralized && <li>Collateral below the senior claim at settlement.</li>}
        </ul>
      )}
    </Panel>
  );
}

function ClaimCard({ tone, title, body, id }: { tone: "p" | "n"; title: string; body: string; id: bigint }) {
  return (
    <div className="border-line rounded-sm border p-4">
      <div className={`font-mono text-[0.8125rem] tracking-[0.1em] uppercase ${tone === "p" ? "text-p" : "text-n"}`}>
        {title}
      </div>
      <p className="text-muted mt-2 text-sm">{body}</p>
      <p className="text-dim mt-3 font-mono text-[0.75rem] break-all">id 0x{id.toString(16)}</p>
    </div>
  );
}

function Stat({ label, value, hint, tone }: { label: string; value: string; hint?: string; tone?: "p" | "n" }) {
  return (
    <div>
      <dt className="text-dim text-[0.8125rem] tracking-[0.08em] uppercase">{label}</dt>
      <dd
        className={`mt-1 font-mono text-sm tabular-nums ${tone === "p" ? "text-p" : tone === "n" ? "text-n" : ""}`}
        title={hint}
      >
        {value}
      </dd>
    </div>
  );
}

function Term({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-baseline justify-between gap-4">
      <dt className="text-dim">{label}</dt>
      <dd className="font-mono tabular-nums">{value}</dd>
    </div>
  );
}
