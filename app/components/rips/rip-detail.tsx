"use client";

import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { useState, useSyncExternalStore } from "react";

import { AddressLink } from "@/components/ui";
import { ConnectButton } from "@/components/connect-button";
import { DEPLOYMENT, txExplorer } from "@/lib/deployment";
import {
  explainPosition,
  pctChange,
  shortDate,
  signedPct,
  timeLeft,
  totalPaid,
  totalQty,
  upsideAtExpiry,
  usd,
  type RipPosition,
} from "@/lib/rips/model";
import { DemoBadge, TickerMark, hueStyle, positionMove } from "./bits";
import { useRips } from "./rips-shell";
import { ShareSheet } from "./share-card";
import { RIPS_SHOW_EXTRAS } from "@/lib/rips/ui";
import { Button } from "@/components/ui/button";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";

// This Suspense child can hydrate after the parent restores the saved mode.
// Its own server snapshot keeps direct-link reloads consistent with exported HTML.
const hydrationSubscribe = () => () => {};
const AMOUNTS = [1, 5, 20];

/**
 * What the claim pays at expiry across underlying prices, with today's price
 * and the break-even marked. One line, three markers: enough to see why the
 * value moved without reading a word.
 */
function PayoffChart({ position, spot }: { position: RipPosition; spot: number | null }) {
  const qty = totalQty(position);
  const paid = totalPaid(position);
  const k = position.strike;
  const breakeven = qty > 0 && paid > 0 ? k + paid / qty : null;
  const lo = Math.min(k * 0.88, (spot ?? k) * 0.97);
  const hi = Math.max((breakeven ?? k) * 1.08, k * 1.15, (spot ?? k) * 1.03);
  const W = 320;
  const H = 150;
  const pad = { l: 8, r: 8, t: 14, b: 26 };
  const maxV = upsideAtExpiry(hi, k) * qty;
  const x = (p: number) => pad.l + ((p - lo) / (hi - lo)) * (W - pad.l - pad.r);
  const y = (v: number) => H - pad.b - (v / Math.max(maxV, 1e-12)) * (H - pad.t - pad.b);
  const path = `M ${x(lo)} ${y(0)} L ${x(k)} ${y(0)} L ${x(hi)} ${y(maxV)}`;
  return (
    <figure className="mt-4">
      <svg viewBox={`0 0 ${W} ${H}`} className="w-full" role="img" aria-label={`Value at expiry: zero below ${usd(k)}, rising above it.${breakeven ? ` Break-even at ${usd(breakeven)}.` : ""}`}>
        <line x1={pad.l} x2={W - pad.r} y1={y(0)} y2={y(0)} stroke="var(--color-line)" />
        {paid > 0 && (
          <>
            <line x1={pad.l} x2={W - pad.r} y1={y(paid)} y2={y(paid)} stroke="var(--color-line)" strokeDasharray="2 4" />
            <text x={W - pad.r} y={y(paid) - 4} textAnchor="end" fontSize="9" fill="var(--color-dim)">paid {usd(paid)}</text>
          </>
        )}
        <path d={path} fill="none" stroke="var(--rip-hue)" strokeWidth="3" strokeLinejoin="round" />
        <line x1={x(k)} x2={x(k)} y1={pad.t} y2={y(0)} stroke="var(--color-dim)" strokeDasharray="3 3" />
        <text x={x(k)} y={H - 8} textAnchor="middle" fontSize="10" fill="var(--color-muted)">{usd(k)}</text>
        {spot !== null && spot >= lo && spot <= hi && (
          <g>
            <circle cx={x(spot)} cy={y(upsideAtExpiry(spot, k) * qty)} r="5" fill="var(--color-text)" />
            <text x={x(spot)} y={pad.t - 2} textAnchor="middle" fontSize="10" fontWeight="600" fill="var(--color-text)">now</text>
            <line x1={x(spot)} x2={x(spot)} y1={pad.t + 2} y2={y(0)} stroke="var(--color-text)" strokeOpacity="0.35" />
          </g>
        )}
      </svg>
      <figcaption className="text-dim mt-1 flex justify-between text-[0.75rem]">
        <span>Value at expiry by {position.symbol} price</span>
        {breakeven && <span>Break-even {usd(breakeven)}</span>}
      </figcaption>
    </figure>
  );
}

export function RipDetail() {
  const hydrated = useSyncExternalStore(hydrationSubscribe, () => true, () => false);
  const params = useSearchParams();
  const id = params.get("id");
  const { positions, marks, prices, now, lots, catalog, buy, mode, modeReady, liveState, redeem, refresh } = useRips();
  const owned = positions.find((p) => p.id === id);
  const listed = catalog.find(l => `${l.source}:${l.id}` === id);
  const position: RipPosition | undefined = owned ?? (listed ? {
    id: `${listed.source}:${listed.id}`, lotId: listed.id, source: listed.source, symbol: listed.symbol,
    name: listed.name, strike: listed.strike, spotAtRip: listed.spot, expiryTs: listed.expiryTs,
    termDays: Math.max(1, Math.ceil((listed.expiryTs - now) / 86400)), series: listed.series, fills: [],
  } : undefined);
  const [picked, setAmount] = useState<number | null>(null);
  const [state, setState] = useState<{ kind: "idle" | "busy" } | { kind: "done"; added: number } | { kind: "failed"; message: string }>({ kind: "idle" });
  const [share, setShare] = useState(false);

  if (!hydrated || !modeReady || (mode === "live" && liveState === "loading")) return <p role="status" className="py-12">Reading this position…</p>;

  if (!position) {
    return (
      <div className="pt-16 text-center">
        <h1 className="font-display text-2xl font-semibold">This Rip isn’t here</h1>
        <p className="text-muted mt-2 text-sm">
          It may belong to another wallet, or to the {id?.startsWith("demo:") ? "demo" : "live"} pool you aren’t viewing.
        </p>
        <Link href="/rips" className="text-accent-ink mt-6 inline-block text-sm font-medium underline underline-offset-4">
          Back to My Rips
        </Link>
      </div>
    );
  }

  const mark = marks.get(position.id);
  const paid = totalPaid(position);
  const qty = totalQty(position);
  const value = mark?.value ?? null;
  const change = pctChange(value ?? paid, paid);
  const reference = position.source === "live" ? prices.get(position.symbol) ?? null : null;
  const spot = mark?.spot ?? reference?.price ?? null;
  const move = positionMove(position);
  // Settlement is read from the chain: a settled Rip is over, whatever this device's clock says.
  const settled = !!position.live?.settled;
  const redeemed = settled && position.live?.heldRaw === "0";
  const expired = settled || position.expiryTs <= now;
  const lot = lots.find((l) => l.id === position.lotId);
  // Until the buyer picks, offer $5, or the largest amount the pool still has.
  const amount = picked ?? AMOUNTS.filter(a => a <= 5 && (!lot || a <= lot.availableUsd)).at(-1) ?? AMOUNTS[0];
  const own = !!lot?.listedBy && !!buy.signer && lot.listedBy.toLowerCase() === buy.signer.toLowerCase();
  const canBuy = (mode === "demo" || (!!buy.signer && !buy.wrongNetwork)) && !expired && !!lot && !own && lot.availableUsd >= amount;
  const buyWhy = expired
    ? "This position has expired."
    : own
      ? "This is your listing. Manage it on the Sell page."
    : !lot
      ? "This position has no current funded quote. Refresh the pool or choose another position."
      : lot.availableUsd < amount
        ? `Only ${usd(lot.availableUsd)} of it is left in the pool.`
        : null;

  const topUp = async () => {
    if (!lot) return;
    setState({ kind: "busy" });
    const r = await buy.buy(lot, amount, "buy");
    setState(r.ok ? { kind: "done", added: r.fill.paid } : { kind: "failed", message: r.reason });
  };

  const distance = spot ? ((position.strike - spot) / spot) * 100 : null;

  return (
    <div className="pt-6" style={hueStyle(position.symbol)}>
      <Link href="/rips" className="text-muted hover:text-text text-sm">
        ← My Rips
      </Link>

      {/* Level 1 */}
      <section className="rip-card mt-4 p-6">
        <div className="flex items-start justify-between gap-3">
          <div className="flex min-w-0 items-center gap-3">
            <TickerMark symbol={position.symbol} size={52} />
            <div className="min-w-0">
              <h1 className={`font-display break-words leading-none font-bold tracking-[-0.05em] ${position.symbol.length > 7 ? "text-xl sm:text-3xl" : "text-[2rem] sm:text-[2.4rem]"}`}>
                {position.symbol} <span className="text-p">UP</span> {move}
              </h1>
              <p className="text-muted mt-1 text-sm">
                {position.name} · {position.termDays}D
              </p>
            </div>
          </div>
          {RIPS_SHOW_EXTRAS && owned && <Button variant="outline" onClick={() => setShare(true)} className="border-line hover:border-text shrink-0 rounded-full bg-transparent px-3 shadow-none hover:bg-transparent">
            Share
          </Button>}
        </div>
        <div className="mt-6 flex items-end justify-between gap-4">
          <div>
            {redeemed ? <p className="font-display text-5xl font-semibold tracking-[-0.05em]">Redeemed</p> : (RIPS_SHOW_EXTRAS || value !== null) && <p className={`font-display font-semibold tracking-[-0.05em] tabular-nums ${value === null ? "text-3xl" : "text-5xl"}`}>{value === null ? "Unavailable" : usd(value)}</p>}
            <p className="mt-1 text-sm tabular-nums">
              <span className={change > 0.5 ? "text-p font-medium" : change < -0.5 ? "text-danger font-medium" : "text-muted"}>
                {mode === "demo" && value !== null ? signedPct(change) : "Lifetime purchase cost"}
              </span>
              <span className="text-dim"> · paid {usd(paid)}</span>
            </p>
          </div>
          <p className={`text-right text-sm font-medium ${expired ? "text-accent-ink" : "text-muted"}`}>{settled ? "Settled" : timeLeft(position.expiryTs, now)}</p>
        </div>
        {position.source === "demo" && <DemoBadge className="mt-4" />}
      </section>

      {/* Level 2 */}
      <section className="mt-6">
        <p className="font-display text-xl leading-snug font-medium tracking-[-0.02em]">
          {redeemed ? "You held a claim on" : owned ? "You hold a claim on" : "Buy a claim on"} {position.name} value above {usd(position.strike)} at expiry on {shortDate(position.expiryTs)}.
        </p>
        <dl className="mt-5 grid grid-cols-2 gap-3 text-sm">
          {(settled ? [
            ["Exposure starts", usd(position.strike)],
            ["Expired", shortDate(position.expiryTs)],
            ["Redeems for", redeemed ? "Paid out" : value === null || value <= 0 ? "Nothing: it ended below" : `about ${usd(value)} of ${position.symbol}`],
          ] : [
            ["Price now", spot ? usd(spot) : "—"],
            ["Exposure starts", usd(position.strike)],
            [
              "Needs to rise",
              distance === null ? "—" : distance <= 0 ? "Already above" : `${distance.toFixed(1)}%`,
            ],
            ["Expires", `${shortDate(position.expiryTs)} · ${timeLeft(position.expiryTs, now)}`],
            ["Paid", usd(paid)],
            ["Worth now", value === null ? "Unavailable (no resale quote)" : usd(value)],
          ]).filter(([k]) => RIPS_SHOW_EXTRAS || mode === "demo" || ["Exposure starts", "Expires", "Expired", "Redeems for"].includes(k) || (spot !== null && ["Price now", "Needs to rise"].includes(k))).map(([k, v]) => (
            <div key={k} className="border-line/70 bg-panel rounded-2xl border px-4 py-3">
              <dt className="text-dim text-xs">{k}</dt>
              <dd className="mt-0.5 font-medium tabular-nums">{v}</dd>
            </div>
          ))}
        </dl>
        {reference && <p className="text-dim mt-2 text-xs">Price now: Chainlink {reference.ticker} feed on Base{position.symbol.toUpperCase() !== reference.ticker ? ` (reference for test token ${position.symbol})` : ""}, updated {new Date(reference.updatedAt * 1000).toLocaleString()}. Display only; settlement uses the market&rsquo;s oracle.</p>}
        {mode === "demo" && qty > 0 && <PayoffChart position={position} spot={spot} />}
        {mode === "live" && <p className="text-muted mt-4 text-sm">The strike uses the approved oracle’s total-return units, which can differ from a raw stock price. N redemption pays underlying collateral tokens after settlement, with contract rounding and any series fees. It does not pay cash USDC.</p>}
      </section>

      {/* The one action */}
      <section className="border-line/70 bg-panel mt-8 rounded-3xl border p-5">
        {redeemed ? <><p className="text-muted text-sm">Redeemed. The claims were paid out in {position.symbol} to your wallet.</p>{state.kind === "done" && <p role="status" className="mt-3 text-sm">Redemption confirmed. Your on-chain balance was refreshed.</p>}</> : position.live?.settled ? <><p className="text-muted text-sm">Settled. Redeem the remaining claim units for underlying collateral tokens. The transaction receipt records the actual redemption.</p><Button variant="rip" disabled={position.live.heldRaw === "0" || buy.phase !== "idle" || buy.wrongNetwork} onClick={async () => { setState({ kind: "busy" }); const result = await redeem(position); setState(result.ok ? { kind: "done", added: 0 } : { kind: "failed", message: result.reason ?? "Redemption failed." }); }} className="mt-3 h-14 w-full text-base">{buy.phase !== "idle" ? "Redeeming…" : "Redeem held claims"}</Button>{state.kind === "done" && <p role="status" className="mt-3 text-sm">Redemption confirmed. Your on-chain balance was refreshed.</p>}{state.kind === "failed" && <p role="alert" className="text-danger mt-3 text-sm">{state.message}</p>}</> : expired ? (
          <p className="text-muted text-sm leading-6">
            This position has expired.{" "}
            {position.source === "live" ? (
              <>
                Once the series settles, return here to redeem your claim units.
              </>
            ) : (
              "Demo positions settle on paper only."
            )}
          </p>
        ) : (
          <>
            <ToggleGroup
              aria-label="Amount"
              value={[String(amount)]}
              onValueChange={(value) => {
                if (!value[0]) return;
                setAmount(Number(value[0]));
                setState({ kind: "idle" });
              }}
              disabled={state.kind === "busy" || buy.phase !== "idle"}
              className="flex w-full gap-2"
            >
              {AMOUNTS.map((a) => (
                <ToggleGroupItem
                  key={a}
                  value={String(a)}
                  variant="outline"
                  className="border-line text-muted hover:text-text data-pressed:border-text data-pressed:bg-text data-pressed:text-bg flex-1 rounded-full py-2 font-semibold shadow-none hover:bg-transparent data-pressed:hover:bg-text"
                >
                  ${a}
                </ToggleGroupItem>
              ))}
            </ToggleGroup>
            <Button
              variant="rip"
              disabled={!canBuy || state.kind === "busy" || buy.phase !== "idle"}
              onClick={() => void topUp()}
              aria-describedby={buyWhy ? "buy-why" : undefined}
              title={buyWhy ?? undefined}
              className="mt-3 h-16 w-full text-xl"
            >
              {state.kind === "busy" ? "Buying…" : `BUY $${amount} ${position.symbol} UP`}
            </Button>
            {mode === "live" && lot && <p className="text-muted mt-3 text-center text-sm">Current quote: {(amount / lot.askPrice).toLocaleString("en-US", { maximumSignificantDigits: 9 })} N claim units for {amount} {DEPLOYMENT.quote?.symbol}. {lot.listedBy ? `Seller's price, set by ${lot.listedBy.slice(0, 6)}…${lot.listedBy.slice(-4)}; it stands until they change it.` : "Quotes expire within five minutes."}</p>}
            {mode === "live" && !buy.signer && <div className="mt-3"><ConnectButton /></div>}
            {mode === "live" && buy.wrongNetwork && <p className="text-danger mt-3 text-sm">Switch to {DEPLOYMENT.chainName} using the wallet control above.</p>}
            {buyWhy && (
              <p id="buy-why" className="text-dim mt-2 text-center text-xs">
                {buyWhy}
                {mode === "live" && <Button variant="link" className="text-dim ml-1 inline h-auto p-0 align-baseline text-xs font-normal underline underline-offset-auto" onClick={() => void refresh()}>Refresh pool</Button>}
              </p>
            )}
            {state.kind === "done" && (
              <p className="text-p mt-3 text-center text-sm font-medium" role="status">
                Added {usd(state.added)} to this position.
              </p>
            )}
            {state.kind === "failed" && (
              <p className="text-danger mt-3 text-center text-sm" role="alert">
                {state.message}
              </p>
            )}
          </>
        )}
      </section>

      {buy.transaction && <a className="mt-4 block text-sm underline" href={txExplorer(buy.transaction)} target="_blank" rel="noreferrer">View transaction receipt</a>}
      {/* Level 3, closed by default */}
      {RIPS_SHOW_EXTRAS && <details className="border-line/70 mt-8 border-t pt-5 text-sm">
        <summary className="cursor-pointer font-medium">How it works</summary>
        <div className="text-muted mt-3 space-y-2 leading-6">
          <p>{explainPosition(position)}</p>
          {mode === "demo" && <p>
            In this simulation, at expiry, every {position.symbol} point above {usd(position.strike)} is worth $1 per claim you hold. You hold{" "}
            {qty.toLocaleString("en-US", { maximumFractionDigits: 6 })} claims, so if {position.symbol} ends at{" "}
            {usd(position.strike * 1.1)}, this pays {usd(upsideAtExpiry(position.strike * 1.1, position.strike) * qty)}.
          </p>}
          <p>
            If {position.symbol} ends at or below {usd(position.strike)}, it pays nothing. There is no floor. Before expiry
            the value moves with the price and the time left.
          </p>
        </div>
      </details>}

      <details className="border-line/70 mt-4 border-t pt-5 text-sm">
        <summary className="cursor-pointer font-medium">Full details</summary>
        <dl className="mt-4 grid grid-cols-[auto_1fr] gap-x-6 gap-y-2">
          <dt className="text-dim">Instrument</dt>
          <dd>N (upside) claim — the above-strike portion of locked collateral at settlement</dd>
          <dt className="text-dim">Underlying</dt>
          <dd>{position.name} ({position.symbol})</dd>
          <dt className="text-dim">Strike</dt>
          <dd className="tabular-nums">{usd(position.strike, 4)}</dd>
          <dt className="text-dim">Expiry</dt>
          <dd>{new Date(position.expiryTs * 1000).toUTCString()}</dd>
          <dt className="text-dim">Quantity</dt>
          <dd className="tabular-nums">{qty.toLocaleString("en-US", { maximumFractionDigits: 9 })}</dd>
          <dt className="text-dim">Average price</dt>
          <dd className="tabular-nums">{mode === "demo" && qty > 0 ? `${usd(paid / qty, 6)} per claim` : "See recorded cost and original quantity; transfers may change current holdings"}</dd>
          <dt className="text-dim">Valuation source</dt>
          <dd>
            {mark?.marked === "settlement" ? "On-chain redemption pool, estimated at settlement price" : mode === "demo" ? "Simulation model (demo)" : "Unavailable: the pool sells inventory but does not buy it back"}
          </dd>
          <dt className="text-dim">Settlement</dt>
          <dd>
            {position.source === "live"
              ? "Settled by the series against its approved oracle after expiry; redeem held claim units here."
              : "Demo only — nothing settles on chain."}
          </dd>
          <dt className="text-dim">Network</dt>
          <dd>{position.source === "live" ? DEPLOYMENT.chainName : "None (simulated)"}</dd>
        </dl>
        {position.series && (
          <div className="mt-4">
            <AddressLink label="Series" address={position.series} />
          </div>
        )}
        {position.live && <dl className="mt-4 break-all text-xs"><dt>ERC-6909 claim ID</dt><dd>{position.live.claimId}</dd><dt>Claim decimals</dt><dd>{position.live.unitDecimals}</dd><dt>Held / originally purchased (raw units)</dt><dd>{position.live.heldRaw} / {position.live.purchasedRaw}</dd></dl>}
        <h3 className="text-dim mt-5 text-xs font-semibold tracking-[0.16em] uppercase">Purchases</h3>
        <ul className="mt-2 divide-y divide-[var(--color-line)]">
          {position.fills.map((f, i) => (
            <li key={`${f.at}-${i}`} className="flex items-center justify-between gap-3 py-2 tabular-nums">
              <span>
                {f.at === 0 ? "On-chain purchase total (all devices)" : `${f.kind === "rip" ? "Rip" : "Buy"} · ${new Date(f.at).toLocaleString()}`}
                {f.elsewhere && <span className="text-dim"> · another device</span>}
              </span>
              <span className="flex items-center gap-3">
                {usd(f.paid)}
                {f.signature && (
                  <a className="text-dim font-mono text-xs underline" title="Base transaction receipt" href={txExplorer(f.signature)} target="_blank" rel="noreferrer">
                    Receipt ↗
                  </a>
                )}
              </span>
            </li>
          ))}
        </ul>
      </details>

      {share && (
        <ShareSheet subject={{ symbol: position.symbol, move, termDays: position.termDays, paid: totalPaid(position), demo: position.source === "demo" }} onClose={() => setShare(false)} />
      )}
    </div>
  );
}
