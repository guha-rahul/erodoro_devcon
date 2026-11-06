"use client";

import { useOracle } from "@/lib/use-oracle";
import { formatDate } from "@/lib/format";
import type { Series } from "@/lib/types";
import { Panel } from "./ui";

const TONE: Record<string, string> = {
  ready: "border-p/40 text-p",
  settled: "border-line text-dim",
  waiting: "border-n/40 text-n",
  stale: "border-n/40 text-n",
  paused: "border-n/40 text-n",
  wide: "border-danger/40 text-danger",
  unavailable: "border-danger/40 text-danger",
  loading: "border-line text-dim",
};

/**
 * The settlement reference, kept visibly distinct from any market price.
 *
 * The two are different numbers from different places. A market price is what
 * someone will pay on a venue; this is what the contract scores the market
 * against at expiry. Showing either without saying which invites the reader to
 * assume they are the same.
 */
export function OraclePanel({ series }: { series: Series }) {
  const o = useOracle(series);

  return (
    <Panel title="Settlement reference" subtitle="Not a market price">
      <div className="flex items-baseline justify-between gap-4">
        <span className="font-mono text-2xl tabular-nums">
          {o.usd === null ? "—" : `$${o.usd.toFixed(2)}`}
        </span>
        <span
          className={`rounded-sm border px-2 py-1 font-mono text-[0.72rem] tracking-[0.08em] uppercase ${TONE[o.status] ?? "border-line text-dim"}`}
        >
          {o.label}
        </span>
      </div>
      <p className="text-muted mt-3 text-[0.875rem] leading-6">{o.detail}</p>

      <details className="border-line-soft mt-4 border-t pt-3">
        <summary className="text-muted cursor-pointer text-sm">Oracle timing and price details</summary>
      <dl className="mt-3 grid gap-2 text-[0.82rem]">
        <Row label="Last moved" value={o.age === null ? "—" : `${o.age}s ago`} />
        <Row label="Uncertainty band" value={o.confBps === null ? "—" : `${o.confBps} bp`} />
        <Row label="Settlement opens" value={formatDate(o.opensAt)} />
        <Row label="Reference window shuts" value={formatDate(o.closesAt)} />
      </dl>

      <p className="text-dim mt-3 text-[0.78rem] leading-5">
        Settlement uses a signed reference published between this market&rsquo;s expiry and the
        window above. A price from outside that range is rejected by the contract, so a quote
        printed on a closed market cannot be used to settle.
      </p>
      <p className="text-dim mt-2 text-[0.78rem] leading-5">
        This reference is the feed each market names when it is created. It is chosen by
        Erodoro for settlement and is <span className="text-muted">not</span> an official price
        source of the token&rsquo;s issuer or of this network.
      </p>
      </details>
    </Panel>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-baseline justify-between gap-4">
      <dt className="text-dim">{label}</dt>
      <dd className="font-mono tabular-nums">{value}</dd>
    </div>
  );
}
