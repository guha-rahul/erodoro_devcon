"use client";

import Link from "next/link";
import { useState } from "react";
import { pctChange, shortDate, signedPct, timeLeft, totalPaid, totalQty, usd, type RipPosition } from "@/lib/rips/model";
import { DemoBadge, TickerMark } from "./bits";
import { useRips } from "./rips-shell";
import { RIPS_SHOW_DEMO, RIPS_SHOW_EXTRAS } from "@/lib/rips/ui";
import { Button } from "@/components/ui/button";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";

type Sort = "recent" | "value" | "expiry";

type Priced = { p: RipPosition; spot: number | null; qty: number; payToday: number; settled: boolean };

/** What each holding would pay if it ended at today's reference price; once settled, what it redeems for. */
function priced(list: RipPosition[], prices: Map<string, { price: number }>, marks: Map<string, { value: number | null }>): Priced[] {
  return list.map((p) => {
    const spot = prices.get(p.symbol)?.price ?? null;
    const qty = totalQty(p);
    if (p.live?.settled) return { p, spot, qty, payToday: marks.get(p.id)?.value ?? 0, settled: true };
    return { p, spot, qty, payToday: spot === null ? 0 : Math.max(0, spot - p.strike) * qty, settled: false };
  }).sort((a, b) => (b.spot === null ? -1 : b.spot / b.p.strike) - (a.spot === null ? -1 : a.spot / a.p.strike));
}

/** How far a stock is from its strike, as a bar that fills to the strike. */
function Distance({ spot, strike }: { spot: number | null; strike: number }) {
  if (spot === null) return <span className="text-dim text-xs">No price</span>;
  const gap = (strike - spot) / spot;
  if (gap <= 0) return <span className="text-p text-xs font-semibold">Above · paying</span>;
  // The bar spans the last 20% below the strike; further away reads as empty.
  const fill = Math.max(0.04, 1 - gap / 0.2);
  return (
    <span className="flex items-center gap-2">
      <span className="bg-line/70 relative h-1.5 w-16 overflow-hidden rounded-full"><span className="bg-p/70 absolute inset-y-0 left-0 rounded-full" style={{ width: `${fill * 100}%` }} /></span>
      <span className="text-muted text-xs tabular-nums">needs +{(gap * 100).toFixed(1)}%</span>
    </span>
  );
}

/** One row per stock: price now against what it pays above, closest to paying first. */
function RipRows({ rows }: { rows: Priced[] }) {
  return (
    <ul className="border-line/70 divide-line/50 mt-3 divide-y overflow-hidden rounded-xl border">
      {rows.map(({ p, spot, payToday, settled }) => (
        <li key={p.id}>
          <Link href={`/rips/position?id=${encodeURIComponent(p.id)}`} className="hover:bg-panel-2/60 grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-4 gap-y-0.5 px-3 py-2 transition-colors sm:grid-cols-[minmax(0,1.1fr)_minmax(0,1.2fr)_auto]">
            <span className="flex min-w-0 items-center gap-2.5">
              <TickerMark symbol={p.symbol} size={22} />
              <span className="min-w-0">
                <span className="block truncate text-sm font-semibold">{p.symbol} <span className="text-p">↑</span></span>
                <span className="text-dim block text-[0.6875rem] tabular-nums">{spot === null ? "—" : usd(spot)} now · pays above {usd(p.strike)}</span>
              </span>
            </span>
            <span className="hidden sm:block">{settled ? <span className={`text-xs ${payToday > 0 ? "text-p font-semibold" : "text-muted"}`}>{p.live?.heldRaw === "0" ? "Redeemed" : payToday > 0 ? "Settled · redeem" : "Settled · ended below"}</span> : <Distance spot={spot} strike={p.strike} />}</span>
            <span className="text-right">
              <span className="block text-sm font-medium tabular-nums">{usd(totalPaid(p))}</span>
              <span className={`block text-[0.6875rem] tabular-nums ${payToday > 0 ? "text-p" : "text-dim"}`}>{settled ? p.live?.heldRaw === "0" ? "redeemed" : payToday > 0 ? `redeems ${usd(payToday)}` : "pays nothing" : payToday > 0 ? `paying ${usd(payToday)}` : "spent"}</span>
            </span>
          </Link>
        </li>
      ))}
    </ul>
  );
}

/** The four numbers that matter, in one strip. */
function Summary({ rows, now }: { rows: Priced[]; now: number }) {
  const above = rows.filter((r) => r.spot !== null && r.spot > r.p.strike).length;
  const payToday = rows.reduce((s, r) => s + r.payToday, 0);
  const next = Math.min(...rows.map((r) => r.p.expiryTs));
  const stat = "flex flex-col gap-0.5 px-4 py-3";
  return (
    <div className="border-line/70 bg-panel divide-line/50 mt-5 grid grid-cols-2 divide-x divide-y overflow-hidden rounded-xl border sm:grid-cols-4 sm:divide-y-0">
      <div className={stat}><span className="text-dim text-[0.625rem] font-semibold tracking-[0.12em] uppercase">Holding</span><span className="font-display text-xl font-semibold tabular-nums">{rows.length} {rows.length === 1 ? "stock" : "stocks"}</span></div>
      <div className={stat}><span className="text-dim text-[0.625rem] font-semibold tracking-[0.12em] uppercase">Above their price</span><span className={`font-display text-xl font-semibold tabular-nums ${above ? "text-p" : ""}`}>{above} of {rows.length}</span></div>
      <div className={stat}><span className="text-dim text-[0.625rem] font-semibold tracking-[0.12em] uppercase">If it ended today</span><span className={`font-display text-xl font-semibold tabular-nums ${payToday > 0 ? "text-p" : ""}`}>{usd(payToday)}</span></div>
      <div className={stat}><span className="text-dim text-[0.625rem] font-semibold tracking-[0.12em] uppercase">Pays out</span><span className="font-display text-xl font-semibold tabular-nums">{next > now ? `${shortDate(next)} · ${timeLeft(next, now).replace(" left", "")}` : "Expired"}</span></div>
    </div>
  );
}

/**
 * Everything ripped, as cards. The reason to come back is on every card:
 * what it is worth now and how long it has left.
 */
export function MyRips() {
  const { positions, marks, now, mode, setMode, canSwitch, otherModeCount, liveState, buy, prices } = useRips();
  const otherLabel = mode === "live" ? "demo" : "live";
  const [sort, setSort] = useState<Sort>("recent");

  const total = positions.reduce(
    (acc, p) => {
      const mark = marks.get(p.id);
      acc.paid += totalPaid(p);
      acc.value += mark?.value ?? 0;
      return acc;
    },
    { paid: 0, value: 0 },
  );
  // Settlement is read from the chain, so a settled Rip moves here whatever this device's clock says.
  const settledList = positions.filter((p) => p.live?.settled);
  const active = positions.filter((p) => !p.live?.settled && p.expiryTs > now);
  const expired = positions.filter((p) => !p.live?.settled && p.expiryTs <= now);
  const order = (list: typeof positions) =>
    [...list].sort((a, b) =>
      sort === "value"
        ? (marks.get(b.id)?.value ?? 0) - (marks.get(a.id)?.value ?? 0)
        : sort === "expiry"
          ? a.expiryTs - b.expiryTs
          : Math.max(...b.fills.map((f) => f.at)) - Math.max(...a.fills.map((f) => f.at)),
    );
  const change = pctChange(total.value, total.paid);

  return (
    <div className="pt-8">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="font-display text-4xl font-semibold tracking-[-0.05em]">My Rips</h1>
          {mode === "demo" && <DemoBadge className="mt-2" />}
        </div>
        {positions.length > 0 && (
          <div className="text-right">
            <p className="font-display text-3xl font-semibold tracking-[-0.04em] tabular-nums">{mode === "demo" ? usd(total.value) : `${usd(total.paid)} spent`}</p>
            {mode === "demo" && total.paid > 0 && (
              <p className="text-sm tabular-nums">
                <span className={change >= 0 ? "text-p" : "text-danger"}>{signedPct(change)}</span>
                <span className="text-dim"> on {usd(total.paid)}</span>
              </p>
            )}
          </div>
        )}
      </div>

      {RIPS_SHOW_DEMO && canSwitch && otherModeCount > 0 && (
        // Live and demo Rips are kept apart on purpose: a simulated position
        // must never sit in the same total as a real one.
        <p className="text-muted mt-4 text-sm">
          {/* No count: this browser only knows its own records for the other
              mode, not what the chain holds, so any number could be wrong. */}
          You also have {otherLabel} Rips, kept separately.{" "}
          <Button
            variant="link"
            onClick={() => setMode(otherLabel)}
            className="text-text inline h-auto p-0 align-baseline font-medium underline underline-offset-2"
          >
            Show {otherLabel} Rips
          </Button>
        </p>
      )}

      {mode === "live" && liveState === "loading" ? <p role="status" className="mt-8">Reading on-chain positions…</p> : mode === "live" && !buy.signer ? <p className="mt-8 text-muted">Connect your wallet to read your on-chain Rips.</p> : mode === "live" && liveState === "error" && positions.length === 0 ? <p className="mt-8 text-muted">Your holdings are unavailable until the on-chain read succeeds.</p> : positions.length === 0 ? (
        <div className="border-line mt-10 rounded-3xl border border-dashed p-10 text-center">
          <p className="font-display text-2xl font-semibold tracking-[-0.03em]">No Rips yet</p>
          <p className="text-muted mt-2 text-sm">Spend $1, pull a move, and watch what it does.</p>
          <Button variant="rip" nativeButton={false} render={<Link href="/market-rip" />} className="mt-6 h-14 px-10 text-xl">
            RIP $1
          </Button>
        </div>
      ) : (
        <>
          {RIPS_SHOW_EXTRAS && <ToggleGroup
            aria-label="Sort"
            value={[sort]}
            onValueChange={(value) => { if (value[0]) setSort(value[0] as Sort); }}
            className="mt-6 gap-2"
          >
            {(
              [
                ["recent", "Recent"],
                ["value", "Value"],
                ["expiry", "Expiring soon"],
              ] as const
            ).map(([k, label]) => (
              <ToggleGroupItem
                key={k}
                value={k}
                variant="outline"
                size="sm"
                className="border-line text-muted hover:text-text data-pressed:border-text data-pressed:bg-text data-pressed:text-bg h-7 rounded-full px-3 text-[0.8125rem] font-normal shadow-none hover:bg-transparent data-pressed:hover:bg-text"
              >
                {label}
              </ToggleGroupItem>
            ))}
          </ToggleGroup>}
          {settledList.length > 0 && (() => { const rows = priced(order(settledList), prices, marks); const owed = rows.reduce((s, r) => s + r.payToday, 0); return <>
            <h2 className="text-dim mt-6 text-xs font-semibold tracking-[0.2em] uppercase">Settled · {usd(owed)} to redeem</h2>
            <RipRows rows={rows} />
          </>; })()}
          {active.length > 0 && (() => { const rows = priced(active, prices, marks); return <><Summary rows={rows} now={now} /><RipRows rows={rows} /></>; })()}
          {expired.length > 0 && (
            <>
              <h2 className="text-dim mt-10 text-xs font-semibold tracking-[0.2em] uppercase">Expired</h2>
              <div className="opacity-80"><RipRows rows={priced(order(expired), prices, marks)} /></div>
            </>
          )}
          {RIPS_SHOW_EXTRAS && <div className="mt-10 text-center">
            <Button variant="rip" nativeButton={false} render={<Link href="/market-rip" />} className="h-14 px-10 text-xl">
              RIP $1
            </Button>
          </div>}
        </>
      )}
    </div>
  );
}
