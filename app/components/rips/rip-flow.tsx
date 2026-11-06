"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";

import type { Hash } from "viem";
import { DEPLOYMENT, txExplorer } from "@/lib/deployment";
import { humanGateRefusal } from "@/lib/rips/human-gate";
import type { PackPull, PackResult } from "@/lib/rips/use-rips";
import {
  BUY_MORE_PRICE,
  RIP_PRICE,
  pickLot,
  shortDate,
  totalPaid,
  usd,
  type PoolLot,
  type RipFill,
  type RipPosition,
} from "@/lib/rips/model";
import { DemoBadge, TickerMark, hueStyle, positionMove } from "./bits";
import { useRips } from "./rips-shell";
import { ShareSheet } from "./share-card";
import { RIPS_SHOW_EXTRAS } from "@/lib/rips/ui";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent } from "@/components/ui/dialog";

type Pull = { position: RipPosition; fill: RipFill; lot: PoolLot };
/** House and seller listings of one market sell the same claim, so they are one stock to the buyer. */
const stockKey = (p: Pull) => p.position.live ? `${p.position.live.claims.toLowerCase()}:${p.position.live.claimId}` : p.position.id;

type Stage =
  | { kind: "idle" }
  | { kind: "charging"; source: PoolLot["source"] }
  | { kind: "torn"; pulls: Pull[] }
  | { kind: "revealed"; pulls: Pull[]; hash?: string }
  | { kind: "failed"; message: string | null };

type TopUp = { kind: "idle" } | { kind: "busy" } | { kind: "done"; added: number } | { kind: "failed"; message: string };

/** Uniform in [0, 1) from the platform's CSPRNG. */
function fairRandom() {
  const a = new Uint32Array(1);
  crypto.getRandomValues(a);
  return a[0] / 2 ** 32;
}

const wait = (ms: number) => new Promise((r) => window.setTimeout(r, ms));

/**
 * The pull: tap → anticipation → tear → reveal.
 *
 * Under a second end to end when nothing needs signing. A live Rip holds in
 * the anticipation state while the wallet asks for approval -- the shake is
 * the waiting indicator -- and tears the instant the purchase is confirmed.
 * Which lot was pulled is decided before signing but never shown until the
 * fill is real.
 */
export function useRipFlow() {
  const { lots, buy, mode } = useRips();
  const [stage, setStage] = useState<Stage>({ kind: "idle" });
  const busy = useRef(false);

  /**
   * `count` packs, in as many transactions as the pool's per-call limit needs. The World ID allowance is checked
   * for the whole order first; if a later transaction fails, the packs already bought are still shown.
   */
  const buyPacks = useCallback(async (count: number): Promise<PackResult> => {
    const pool = DEPLOYMENT.contracts.ripPool;
    if (pool && buy.signer) {
      const refusal = await humanGateRefusal(pool, buy.signer, BigInt(count) * 1_000_000n).catch(() => null);
      if (refusal) return { ok: false, reason: refusal };
    }
    const pulls: PackPull[] = [];
    let hash: Hash | undefined;
    for (let left = count; left > 0; left -= buy.maxPacks) {
      const r = await buy.buyPack(Math.min(left, buy.maxPacks));
      if (!r.ok) return pulls.length ? { ok: true, pulls, hash: hash! } : r;
      pulls.push(...r.pulls);
      hash = r.hash;
    }
    return { ok: true, pulls, hash: hash! };
  }, [buy]);

  /** `count` packs on pools that sell packs; older pools pull one Rip. */
  const rip = useCallback(async (count = 1) => {
    if (busy.current) return;
    // Pack pools sell $1 across ten stocks; older pools pull one.
    const lot = buy.packs ? null : pickLot(lots, fairRandom());
    if (!buy.packs && !lot) return;
    busy.current = true;
    setStage({ kind: "charging", source: lot?.source ?? "live" });
    const started = performance.now();
    const result = buy.packs
      ? await buyPacks(count)
      : await buy.buy(lot!, RIP_PRICE, "rip").then((r) => r.ok ? { ok: true as const, pulls: [{ position: r.position, fill: r.fill, lot: r.lot }], hash: r.fill.signature } : r);
    // Enough anticipation to register, never so much that it drags.
    const held = performance.now() - started;
    if (held < 900) await wait(900 - held);
    if (!result.ok) {
      busy.current = false;
      setStage({ kind: "failed", message: result.reason });
      return;
    }
    setStage({ kind: "torn", pulls: result.pulls });
    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    await wait(reduced ? 0 : result.pulls.length > 1 ? 1100 : 320);
    setStage({ kind: "revealed", pulls: result.pulls, hash: result.hash ?? undefined });
    busy.current = false;
  }, [lots, buy, buyPacks]);

  const close = useCallback(() => {
    if (!busy.current) setStage({ kind: "idle" });
  }, []);

  return { stage, rip, close, mode };
}

export function RipOverlay({
  stage,
  amount = 1,
  onRipAgain,
  onClose,
}: {
  stage: Stage;
  /** Dollars in this purchase: one per pack. */
  amount?: number;
  onRipAgain: () => void;
  onClose: () => void;
}) {
  const { buy, lots, positions, marks, refresh } = useRips();
  const [share, setShare] = useState(false);
  const [topUp, setTopUp] = useState<TopUp>({ kind: "idle" });
  const pullId = stage.kind === "revealed" ? `${stage.pulls[0].position.id}:${stage.pulls[0].fill.at}` : null;

  useEffect(() => { const t = setTimeout(() => setTopUp({ kind: "idle" }), 0); return () => clearTimeout(t); }, [pullId]);

  // Base UI keeps focus and scrolling inside the dialog and turns Escape into
  // onOpenChange(false); onClose ignores it while a pull is still in flight.
  return (
    <Dialog open={stage.kind !== "idle"} onOpenChange={(open) => { if (!open) onClose(); }} disablePointerDismissal>
    <DialogContent
      showCloseButton={false}
      aria-label={stage.kind === "revealed" ? "Your Rip" : "Ripping"}
      className="fixed inset-0 top-0 left-0 z-[100] block h-full w-full max-w-none translate-x-0 translate-y-0 gap-0 overflow-hidden rounded-none bg-[color-mix(in_oklab,var(--color-bg)_88%,transparent)] p-0 text-base ring-0 backdrop-blur-md sm:max-w-none data-open:zoom-in-100 data-closed:zoom-out-100"
    >
      {/* Outside the scroller: the glow overflows the card by design, and
          inside it would stretch the scroll area into empty space. */}
      {stage.kind === "revealed" && stage.pulls.length === 1 && (
        <div aria-hidden className="pointer-events-none absolute inset-0 flex items-center justify-center">
          <div className="relative h-[48rem] w-[24rem] max-w-full" style={hueStyle(stage.pulls[0].position.symbol)}>
            <div className="rip-burst" />
          </div>
        </div>
      )}
      <div className="relative flex h-full flex-col items-center justify-center-safe overflow-y-auto px-4 py-8">
      {(stage.kind === "charging" || stage.kind === "torn") && (
        <div className="relative flex flex-col items-center" aria-live="polite" aria-busy={stage.kind === "charging"}>
          <div className={`rip-pack ${stage.kind === "charging" ? "rip-pack--charging" : "rip-pack--torn"}`}>
            <div className="rip-pack__strip" />
            <div className="flex h-full flex-col items-center justify-center gap-2 pt-8">
              <span className="font-display text-[3.4rem] leading-none font-bold tracking-[-0.05em]">RIP</span>
              <span className="font-display text-xl font-semibold opacity-85">${amount}</span>
              {buy.packs && <span className="mt-1 text-[0.6875rem] font-semibold tracking-[0.22em] uppercase opacity-80">{amount > 1 ? `${amount} packs · 10 stocks each` : "10 stocks inside"}</span>}
            </div>
          </div>
          {/* The torn pack throws its cards: one per stock, fanned out. */}
          {stage.kind === "torn" && stage.pulls.length > 1 && (
            <div aria-hidden className="pointer-events-none absolute inset-0 flex items-center justify-center">
              {/* One card per stock, however many packs pulled it. */}
              {[...new Map(stage.pulls.map((p) => [stockKey(p), p])).values()].slice(0, 10).map((p, i) => (
                <span key={p.position.id} className="rip-fan-card" style={{ ...hueStyle(p.position.symbol), ["--rot" as string]: `${(i - 4.5) * 9}deg`, ["--fx" as string]: `${(i - 4.5) * 34}px`, animationDelay: `${120 + i * 55}ms` }}>
                  {p.position.symbol}
                </span>
              ))}
            </div>
          )}
          {/* A loading screen, not wallet step text: tickers reel past while the pack is bought. */}
          {stage.kind === "charging" && (
            <div className="mt-9 flex w-[min(19rem,78vw)] flex-col items-center gap-4">
              <div className="rip-reel h-7 overflow-hidden text-center">
                <div className="rip-reel__track font-display text-xl font-semibold tracking-[-0.02em]">
                  {[...new Set(lots.map((l) => l.symbol))].concat([...new Set(lots.map((l) => l.symbol))].slice(0, 1)).map((s, i) => <div key={i} className="h-7 leading-7">{s} <span className="text-p">↑</span></div>)}
                </div>
              </div>
              <div className="bg-line/60 h-1 w-full overflow-hidden rounded-full"><div className="rip-progress h-full w-1/3 rounded-full bg-[var(--color-accent)]" /></div>
              <span className="sr-only">Opening your pack</span>
            </div>
          )}
        </div>
      )}

      {stage.kind === "failed" && (
        <div className="bg-panel border-line rip-fade-up w-full max-w-sm rounded-3xl border p-6 text-center">
          <p className="font-display text-2xl font-semibold tracking-[-0.03em]">
            {"That Rip didn’t go through"}
          </p>
          <p className="text-muted mt-3 text-sm leading-6">
            {stage.message}
          </p>
          {buy.transaction && <a className="mt-3 block text-sm underline" href={txExplorer(buy.transaction)} target="_blank" rel="noreferrer">Check transaction receipt</a>}
          <div className="mt-6 grid gap-2">
            <Button variant="rip" className="h-14 text-lg" onClick={onRipAgain}>
              Try again — ${amount}
            </Button>
            <Button variant="ghost" className="text-muted hover:text-text py-2 text-sm hover:bg-transparent" onClick={onClose}>
              Close
            </Button>
          </div>
        </div>
      )}

      {stage.kind === "revealed" && stage.pulls.length > 1 && (() => {
        // Several packs, or several listings of one stock, can pull the same claim: one card each, amounts summed.
        const grouped = [...stage.pulls.reduce((m, p) => {
          const g = m.get(stockKey(p));
          m.set(stockKey(p), g ? { ...g, fill: { ...g.fill, qty: g.fill.qty + p.fill.qty, paid: g.fill.paid + p.fill.paid } } : p);
          return m;
        }, new Map<string, Pull>()).values()];
        const spent = stage.pulls.reduce((s, p) => s + p.fill.paid, 0);
        return (
        <div className="flex w-full max-w-2xl flex-col items-center">
          <p className="text-dim rip-fade-up text-xs font-semibold tracking-[0.22em] uppercase">You pulled</p>
          <p className="font-display rip-reveal-ticker mt-2 text-center text-[2.6rem] leading-none font-bold tracking-[-0.05em]">{grouped.length} stocks <span className="text-p">↑</span></p>
          <p className="text-muted rip-fade-up mt-2 text-sm">{usd(spent)} of upside{grouped.length === stage.pulls.length ? ` · ${usd(stage.pulls[0].fill.paid)} on each` : ""}</p>
          <ul className="mt-6 grid w-full grid-cols-2 gap-2.5 sm:grid-cols-5">
            {grouped.map((p, i) => (
              <li key={p.position.id} className="rip-reveal-card" style={{ ...hueStyle(p.position.symbol), animationDelay: `${i * 60}ms` }}>
                <Link href={`/rips/position?id=${encodeURIComponent(p.position.id)}`} className="rip-card flex h-full flex-col items-center p-3 text-center">
                  <TickerMark symbol={p.position.symbol} size={34} />
                  <span className="font-display mt-2 text-lg leading-none font-bold tracking-[-0.03em]">{p.position.symbol} <span className="text-p">↑</span></span>
                  <span className="text-dim mt-1.5 text-[0.6875rem] leading-tight tabular-nums">above {usd(p.position.strike)}</span>
                  <span className="text-muted mt-0.5 text-[0.6875rem] tabular-nums">{p.fill.qty.toLocaleString("en-US", { maximumFractionDigits: 4 })} claims</span>
                </Link>
              </li>
            ))}
          </ul>
          <p className="text-dim rip-fade-up mt-3 text-center text-xs [animation-delay:600ms]">Each pays if that stock ends above its price on {shortDate(stage.pulls[0].position.expiryTs)}.</p>
          <div className="rip-fade-up mt-5 grid w-full max-w-sm gap-2.5 [animation-delay:650ms]">
            <Button variant="rip" className="h-16 text-2xl" onClick={onRipAgain}>RIP AGAIN — ${amount}</Button>
            {stage.hash && <a className="text-center text-sm underline" target="_blank" rel="noreferrer" href={txExplorer(stage.hash)}>View confirmed transaction</a>}
            <div className="mt-1 flex items-center justify-center gap-5 text-sm">
              <Link href="/rips" className="text-muted hover:text-text">My Rips</Link>
              <Button variant="link" onClick={onClose} className="text-muted hover:text-text h-auto p-0 font-normal hover:no-underline">Done</Button>
            </div>
          </div>
          <span className="sr-only" aria-live="assertive">You pulled {grouped.length} stocks: {grouped.map((p) => p.position.symbol).join(", ")}.</span>
        </div>
        );
      })()}

      {stage.kind === "revealed" && stage.pulls.length === 1 && (() => {
        const { position: snapshot, fill, lot } = stage.pulls[0];
        const position = positions.find((p) => p.id === snapshot.id) ?? snapshot;
        const mark = marks.get(position.id);
        const move = positionMove(position);
        const liveLot = lots.find((l) => l.id === lot.id);
        const canTopUp = !!liveLot && liveLot.availableUsd >= BUY_MORE_PRICE;
        const value = mark?.value !== null && mark?.value !== undefined ? (mark.value * fill.qty) / Math.max(1e-12, position.fills.reduce((s, f) => s + f.qty, 0)) : null;
        const doTopUp = async () => {
          if (!liveLot) return;
          setTopUp({ kind: "busy" });
          const r = await buy.buy(liveLot, BUY_MORE_PRICE, "buy");
          setTopUp(r.ok ? { kind: "done", added: r.fill.paid } : { kind: "failed", message: r.reason });
        };
        return (
          <div className="relative flex w-full max-w-sm flex-col items-center" style={hueStyle(position.symbol)}>
            <div className="rip-card rip-reveal-card relative w-full p-6 text-center shadow-[var(--shadow-pop)]">
              <p className="text-dim text-xs font-semibold tracking-[0.22em] uppercase">You pulled</p>
              <div className="rip-reveal-ticker mt-5 flex flex-col items-center">
                <TickerMark symbol={position.symbol} size={64} />
                <p className="text-muted mt-3 text-base font-medium">{position.name}</p>
                <p className="font-display mt-1 text-[4.25rem] leading-[0.95] font-bold tracking-[-0.06em]">
                  {position.symbol} <span className="text-p">↑</span>
                </p>
                {move && (
                  <p className="font-display text-p mt-1 text-3xl font-semibold tracking-[-0.03em]">UP {move}</p>
                )}
                <p className="text-dim mt-2 text-sm font-semibold tracking-[0.18em] uppercase">
                  {position.termDays} days
                </p>
              </div>
              <dl className="border-line/70 rip-fade-up mt-6 grid grid-cols-2 gap-x-4 gap-y-2 border-t pt-4 text-left text-[0.8125rem] [animation-delay:200ms]">
                <dt className="text-dim">Bought</dt>
                <dd className="text-right tabular-nums">{usd(fill.paid)}</dd>
                <dt className="text-dim">Position</dt>
                <dd className="text-right">
                  {position.symbol} upside above {usd(position.strike)}
                </dd>
                <dt className="text-dim">Expires</dt>
                <dd className="text-right">{shortDate(position.expiryTs)}</dd>
                <dt className="text-dim">Current value</dt>
                <dd className="text-right tabular-nums">{value === null ? "Unavailable" : usd(value)}</dd>
              </dl>
              {lot.source === "demo" && <DemoBadge className="mt-4" />}
            </div>

            <div className="rip-fade-up mt-5 grid w-full gap-2.5 [animation-delay:260ms]">
              <Button variant="rip" className="h-16 text-2xl" onClick={onRipAgain}>
                RIP AGAIN — ${amount}
              </Button>
              <div className={`grid gap-2.5 ${RIPS_SHOW_EXTRAS ? "grid-cols-2" : "grid-cols-1"}`}>
                {topUp.kind === "done" ? (
                  <p className="border-p/40 text-p col-span-2 rounded-full border py-3.5 text-center text-sm font-medium">
                    Added {usd(topUp.added)} · total spent {usd(totalPaid(position))} on {position.symbol} ↑
                  </p>
                ) : (
                  <Button
                    variant="outline"
                    disabled={!canTopUp || topUp.kind === "busy"}
                    onClick={() => void doTopUp()}
                    aria-describedby={!canTopUp ? "topup-why" : undefined}
                    title={!canTopUp ? `Less than $${BUY_MORE_PRICE} of this position is left in the pool.` : undefined}
                    className="border-text hover:bg-text hover:text-bg h-14 rounded-full border-2 bg-transparent px-3 text-sm leading-tight font-semibold whitespace-normal shadow-none disabled:pointer-events-auto disabled:cursor-not-allowed disabled:hover:bg-transparent disabled:hover:text-current"
                  >
                    {topUp.kind === "busy" ? "Buying…" : `Buy $${BUY_MORE_PRICE} more ${position.symbol} UP`}
                  </Button>
                )}
                {RIPS_SHOW_EXTRAS && <Button
                  variant="secondary"
                  onClick={() => setShare(true)}
                  className={`border-line hover:border-text h-14 rounded-full border px-3 text-sm font-semibold ${topUp.kind === "done" ? "col-span-2" : ""}`}
                >
                  Share your pull
                </Button>}
              </div>
              {!canTopUp && topUp.kind !== "done" && (
                <p id="topup-why" className="text-dim text-center text-xs">
                  Less than ${BUY_MORE_PRICE} of this position is available at a current quote.{" "}
                  <Button variant="link" className="text-dim inline h-auto p-0 align-baseline text-xs font-normal underline underline-offset-auto" onClick={() => void refresh()}>Refresh pool</Button>
                </p>
              )}
              {topUp.kind === "failed" && (
                <p className="text-danger text-center text-xs">
                  {topUp.message}
                </p>
              )}
              {fill.signature && <a className="text-center text-sm underline" target="_blank" rel="noreferrer" href={txExplorer(fill.signature)}>View confirmed transaction</a>}
              <div className="mt-1 flex items-center justify-center gap-5 text-sm">
                <Link href={`/rips/position?id=${encodeURIComponent(position.id)}`} className="text-muted hover:text-text">
                  Details
                </Link>
                <Button variant="link" onClick={onClose} className="text-muted hover:text-text h-auto p-0 font-normal hover:no-underline">
                  Done
                </Button>
              </div>
            </div>
            {share && (
              <ShareSheet
                subject={{ symbol: position.symbol, move, termDays: position.termDays, paid: fill.paid, demo: position.source === "demo" }}
                onClose={() => setShare(false)}
              />
            )}
            <span className="sr-only" aria-live="assertive">
              You pulled {position.name}, {position.symbol} up {move}, {position.termDays} days. Worth {value === null ? "Unavailable" : usd(value)}.
            </span>
          </div>
        );
      })()}
      </div>
    </DialogContent>
    </Dialog>
  );
}
