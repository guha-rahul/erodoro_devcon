"use client";

import { DEPLOYMENT } from "@/lib/deployment";
import { fromRaw } from "@/lib/format";

/** YOU KEEP / YOU SELL / MINIMUM — the economic summary under the builder. */
export function EconomicSummary({
  symbol,
  capUsd,
  expiryLabel,
  floor,
  floorDecimals,
}: {
  symbol: string;
  capUsd: string | null;
  expiryLabel: string;
  floor: bigint;
  floorDecimals: number;
}) {
  const quote = DEPLOYMENT.quote;
  return (
    <dl className="border-line bg-panel-2 grid gap-3 rounded-md border p-4 text-sm sm:grid-cols-3">
      <div>
        <dt className="text-dim text-[0.72rem] tracking-[0.08em] uppercase">You keep</dt>
        <dd className="mt-1 leading-6">
          {capUsd ? (
            <>All value up to ${capUsd}/{symbol.split("c")[0] || "share"}</>
          ) : (
            <span className="text-dim">Set a cap</span>
          )}
        </dd>
      </div>
      <div>
        <dt className="text-dim text-[0.72rem] tracking-[0.08em] uppercase">You sell</dt>
        <dd className="mt-1 leading-6">
          {capUsd ? (
            <>All upside above ${capUsd} until {expiryLabel}</>
          ) : (
            <span className="text-dim">Set a cap</span>
          )}
        </dd>
      </div>
      <div>
        <dt className="text-dim text-[0.72rem] tracking-[0.08em] uppercase">Minimum you receive</dt>
        <dd className="mt-1 font-mono text-base tabular-nums">
          {fromRaw(floor, floorDecimals, 2)} {quote?.symbol ?? ""}
        </dd>
      </div>
    </dl>
  );
}

/** Buyer-side payoff examples at three expiry prices. */
export function PayoffPreview({
  cap,
  quantity,
  symbol,
  spot,
}: {
  cap: number;
  quantity: number;
  symbol: string;
  spot: number | null;
}) {
  const rows = [0.95, 1.0, 1.1].map((m) => {
    const price = cap * m;
    const payoff = Math.max(0, price - cap) * quantity;
    return { price, payoff };
  });
  return (
    <div className="border-line rounded-md border">
      <div className="border-line-soft text-dim border-b px-4 py-2 text-[0.72rem] tracking-[0.08em] uppercase">
        If {symbol} finishes at…
      </div>
      <ul className="divide-line-soft divide-y">
        {rows.map((r) => (
          <li key={r.price} className="flex items-center justify-between gap-4 px-4 py-2.5 text-sm">
            <span className="font-mono tabular-nums">${r.price.toFixed(2)}</span>
            <span className="text-muted">
              payoff <span className="font-mono tabular-nums">${r.payoff.toFixed(2)}</span>
            </span>
          </li>
        ))}
      </ul>
      {spot !== null && (
        <p className="text-dim px-4 py-2 font-mono text-[0.78rem] tabular-nums">
          Current ${spot.toFixed(2)} · max loss is the premium you pay
        </p>
      )}
    </div>
  );
}
