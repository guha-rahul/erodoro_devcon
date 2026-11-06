"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { symbolFor } from "@/lib/rips/live";
import { ConnectButton } from "@/components/connect-button";

import { IS_TESTNET as IS_DEVNET, DEPLOYMENT } from "@/lib/deployment";
import { RIP_PRICE, pctChange, signedPct, totalPaid, usd, type PoolLot } from "@/lib/rips/model";
import { DemoBadge, TickerMark } from "./bits";
import { RipCard } from "./rip-card";
import { RipOverlay, useRipFlow } from "./rip-flow";
import { useRips } from "./rips-shell";
import { readShared, type ShareSubject } from "./share-card";
import { RIPS_SHOW_DEMO, RIPS_SHOW_EXTRAS } from "@/lib/rips/ui";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

/** Ticker chips drifting behind the button: what is in the pool, not which one you get. */
function PoolDrift({ lots }: { lots: PoolLot[] }) {
  const symbols = useMemo(() => [...new Set(lots.map((l) => l.symbol))], [lots]);
  if (symbols.length === 0) return null;
  const row = [...symbols, ...symbols, ...symbols, ...symbols].slice(0, Math.max(8, symbols.length * 2));
  const chips = (key: string) =>
    [...row, ...row].map((s, i) => (
      <span
        key={`${key}${i}`}
        className="border-line bg-panel/80 inline-flex items-center gap-2 rounded-full border py-1.5 pr-3.5 pl-1.5"
      >
        <TickerMark symbol={s} size={26} />
        <span className="font-display text-[0.95rem] font-semibold tracking-[-0.02em]">
          {s} <span className="text-p">↑</span>
        </span>
      </span>
    ));
  return (
    <div
      aria-hidden
      className="pointer-events-none absolute inset-x-[-1rem] top-1/2 -translate-y-1/2 space-y-3 overflow-hidden opacity-55 [mask-image:linear-gradient(90deg,transparent,black_18%,black_82%,transparent)]"
    >
      <div className="rip-marquee">{chips("a")}</div>
      <div className="rip-marquee rip-marquee--reverse">{chips("b")}</div>
      <div className="rip-marquee">{chips("c")}</div>
    </div>
  );
}

/**
 * Someone opened a friend's shared pull. Show what they pulled and hand over
 * the same button: the whole point of the link is "your turn".
 */
function SharedPull({ pull, onDismiss }: { pull: ShareSubject; onDismiss: () => void }) {
  return (
    <div className="border-line bg-panel rip-fade-up relative mt-5 flex items-center gap-3 rounded-2xl border p-3 pr-10 text-left">
      <TickerMark symbol={pull.symbol} size={40} />
      <p className="text-sm leading-5">
        <span className="text-muted">A friend ripped</span>{" "}
        <span className="font-display font-semibold">
          {pull.symbol} <span className="text-p">↑</span>
          {pull.move && ` ${pull.move}`} · {pull.termDays}D
        </span>
        <span className="text-muted">{pull.demo ? " in the demo pool" : ""}. Your turn — what will you pull?</span>
      </p>
      <Button
        variant="ghost"
        size="icon-sm"
        onClick={onDismiss}
        aria-label="Dismiss"
        className="text-dim hover:text-text absolute top-2 right-2 rounded-full text-lg leading-none hover:bg-transparent"
      >
        ×
      </Button>
    </div>
  );
}

export function RipsHome() {
  const { mode, modeReady, setMode, canSwitch, lots, liveState, positions, marks, prices, now, buy, balance, supported, snapshot, refresh } = useRips();
  const { stage, rip, close } = useRipFlow();

  const [filter, setFilter] = useState("");
  // Packs per purchase: one per dollar, up to what the pool can fill and the wallet can pay. Orders larger than
  // one call allows (MAX_PACKS) go out as several transactions.
  const [count, setCount] = useState(1);
  const packMode = modeReady && mode === "live" && buy.packs;
  const affordable = buy.signer && balance !== null ? Math.floor(balance) : Infinity;
  const maxCount = packMode ? Math.max(1, Math.min(buy.packsLeft, affordable)) : 1;
  const n = Math.min(Math.max(1, count), maxCount);
  const [shared, setShared] = useState<ShareSubject | null>(null);
  useEffect(() => { const t = setTimeout(() => setShared(readShared(window.location.search)), 0); return () => clearTimeout(t); }, []);

  const ripable = lots.filter((l) => l.availableUsd >= RIP_PRICE * 0.98);
  const needsWallet = modeReady && mode === "live" && !buy.signer;
  const poolEmpty = ripable.length === 0;
  const loading = !modeReady || (mode === "live" && liveState === "loading");

  const portfolio = positions.reduce(
    (acc, p) => {
      const mark = marks.get(p.id);
      acc.paid += totalPaid(p);
      acc.value += mark?.value ?? 0;
      return acc;
    },
    { paid: 0, value: 0 },
  );
  const sorted = [...positions].sort((a, b) => Math.max(...b.fills.map((f) => f.at)) - Math.max(...a.fills.map((f) => f.at)));

  const why = loading
    ? "Reading the pool…"
    : liveState === "undeployed" && mode === "live"
      ? "Rips is awaiting a deployed, funded pool on this network."
      : liveState === "error" && mode === "live"
        ? "The pool could not be read. Use Retry pool read above."
      : mode === "live" && !supported
        ? "This network needs an upgraded, funded Rips pool before purchases open."
      : buy.paused
        ? "Sales are paused for now. Your Rips are safe; buying reopens soon."
      : poolEmpty
        ? "No current, funded quotes are available. The pool operator supplies inventory and quotes."
        : null;

  const onRip = () => {
    if (needsWallet) {
      document.getElementById("rips-connect")?.scrollIntoView({ block: "center" });
      return;
    }
    void rip(n);
  };

  return (
    <>
      <div className="flex items-center justify-between gap-3 pt-5 text-sm">
        {!modeReady ? (
          <span />
        ) : mode === "demo" ? (
          <DemoBadge />
        ) : (
          <span className="text-muted tabular-nums">
            {buy.signer ? (balance === null ? "Balance unavailable" : `${usd(balance, 2)} ${DEPLOYMENT.quote?.symbol}`) : "Not connected"}
          </span>
        )}
        {RIPS_SHOW_EXTRAS && positions.length > 0 && (
          <Link href="/rips" className="text-muted hover:text-text tabular-nums">
            My Rips <span className="text-text font-medium">{mode === "demo" ? usd(portfolio.value) : `${usd(portfolio.paid)} spent`}</span>{" "}
            {mode === "demo" && portfolio.paid > 0 && (
              <span className={portfolio.value >= portfolio.paid ? "text-p" : "text-danger"}>
                {signedPct(pctChange(portfolio.value, portfolio.paid))}
              </span>
            )}
          </Link>
        )}
      </div>

      {RIPS_SHOW_EXTRAS && shared && <SharedPull pull={shared} onDismiss={() => setShared(null)} />}

      <section className="pt-10 text-center sm:pt-14" aria-labelledby="rip-title">
        {RIPS_SHOW_EXTRAS && <p className="text-accent-ink text-xs font-semibold tracking-[0.28em] uppercase">Market Rip</p>}
        <h1 id="rip-title" className="font-display mt-3 text-[2.75rem] leading-[1] font-semibold tracking-[-0.05em] sm:text-6xl">
          $1. Pull a move.
        </h1>

        <div className="relative my-10 flex h-64 items-center justify-center sm:h-72">
          {RIPS_SHOW_EXTRAS && <PoolDrift lots={ripable} />}
          <Button
            variant="rip"
            onClick={onRip}
            disabled={!!why || stage.kind !== "idle" || (mode === "live" && (!buy.signer || buy.wrongNetwork))}
            aria-describedby="rip-sub"
            title={!needsWallet && why ? why : undefined}
            className="rip-cta--hero relative z-10 h-32 w-[min(20rem,82vw)] text-[3.25rem] sm:h-36 sm:text-6xl"
          >
            RIP ${n}
          </Button>
        </div>

        {packMode && <div className="-mt-4 mb-6 flex flex-col items-center gap-2">
          <div role="group" aria-label="Rips to buy" className="border-line bg-panel inline-flex items-center rounded-full border p-1">
            <Button variant="ghost" size="icon" aria-label="One fewer Rip" disabled={n <= 1 || !!why || stage.kind !== "idle"} onClick={() => setCount(n - 1)} className="size-10 rounded-full text-xl">−</Button>
            <input aria-label="Number of Rips" inputMode="numeric" value={n} disabled={!!why || stage.kind !== "idle"}
              onChange={(e) => { const v = Number(e.target.value.replace(/\D/g, "")); if (v > 0) setCount(v); }}
              className="font-display w-14 bg-transparent text-center text-2xl font-semibold tabular-nums outline-none" />
            <Button variant="ghost" size="icon" aria-label="One more Rip" disabled={n >= maxCount || !!why || stage.kind !== "idle"} onClick={() => setCount(n + 1)} className="size-10 rounded-full text-xl">+</Button>
          </div>
          <p className="text-muted text-xs tabular-nums">
            {buy.packsLeft} {buy.packsLeft === 1 ? "Rip" : "Rips"} available{affordable < buy.packsLeft ? ` · you can afford ${affordable}` : ""}{n > buy.maxPacks ? ` · ${Math.ceil(n / buy.maxPacks)} transactions` : ""}
          </p>
        </div>}

        <p id="rip-sub" className="text-muted mx-auto max-w-xs text-sm leading-6">
          {needsWallet
            ? (why ?? "Connect a wallet to Rip.")
            : (why ??
              (mode === "demo"
                ? `Demo pool: nothing is bought.`
                : ""))}
        </p>
        {needsWallet && <div id="rips-connect" className="mt-4 flex justify-center"><ConnectButton /></div>}
        {RIPS_SHOW_DEMO && canSwitch && needsWallet && (
          <Button variant="link" onClick={() => setMode("demo")} className="text-accent-ink mt-3 h-auto p-0 text-sm font-medium underline underline-offset-4">
            No wallet? Try a free demo Rip
          </Button>
        )}
        {RIPS_SHOW_DEMO && canSwitch && mode === "live" && (poolEmpty || liveState === "undeployed") && !loading && (
          <Button variant="link" onClick={() => setMode("demo")} className="text-accent-ink mt-3 h-auto p-0 text-sm font-medium underline underline-offset-4">
            Try the demo pool
          </Button>
        )}
      </section>

      {RIPS_SHOW_EXTRAS && <section className="mt-14" aria-labelledby="my-rips-preview">
        <div className="flex items-baseline justify-between">
          <h2 id="my-rips-preview" className="font-display text-2xl font-semibold tracking-[-0.04em]">
            My Rips
          </h2>
          {positions.length > 0 && (
            <Link href="/rips" className="text-muted hover:text-text text-sm">
              See all →
            </Link>
          )}
        </div>
        {positions.length === 0 ? (
          <p className="text-muted border-line mt-4 rounded-2xl border border-dashed p-6 text-center text-sm">
            {mode === "live" && liveState === "loading" ? "Reading your on-chain Rips…"
              : mode === "live" && !buy.signer ? "Connect your wallet to read your on-chain Rips."
              : mode === "live" && liveState === "error" ? "Your holdings are unavailable until the on-chain read succeeds."
              : "Nothing yet. Your Rips land here and move with the market."}
          </p>
        ) : (
          <div className="-mx-4 mt-4 flex gap-3 overflow-x-auto px-4 pb-2">
            {sorted.slice(0, 8).map((p) => (
              <RipCard key={p.id} position={p} mark={marks.get(p.id)} now={now} compact />
            ))}
          </div>
        )}
      </section>}

      {RIPS_SHOW_EXTRAS && <details className="border-line/70 mt-12 border-t pt-5 text-sm">
        <summary className="cursor-pointer font-medium">What is a Rip?</summary>
        <div className="text-muted mt-3 space-y-2 leading-6">
          <p>
            A Rip spends $1 on a randomly chosen position from the pool. Every live position is an upside claim on a{" "}
            {IS_DEVNET ? "test token" : "tokenized stock"}: it pays based on how far the price ends above a set level on a set date.
          </p>
          <p>
            You get a real, fractional position bought from funded inventory held by the Base pool. If the price
            finishes below the level, the position expires worth nothing.
          </p>
          <p>Like what you pulled? Buy more of that exact position from its detail page.</p>
        </div>
      </details>}

      <section className="mt-8 border-t border-line pt-5"><h2 className="font-display text-xl">Available positions</h2>
        {RIPS_SHOW_EXTRAS && <p className="text-muted mt-2 text-sm">Choose a position to review its strike, expiry, and available inventory before buying.</p>}
        {RIPS_SHOW_EXTRAS && <div className="mt-4 grid gap-2"><Label htmlFor="rips-search">Search positions</Label><Input id="rips-search" type="search" value={filter} onChange={e => setFilter(e.target.value)} placeholder="Ticker or asset name" className="bg-panel h-10" /></div>}
        <div className="mt-4 grid grid-cols-2 gap-3 sm:grid-cols-3">{ripable.filter(l => `${l.symbol} ${l.name}`.toLowerCase().includes(filter.toLowerCase())).map(l => <Link key={l.id} href={`/rips/position?id=${encodeURIComponent(`${l.source}:${l.id}`)}`} className="rip-card p-4"><TickerMark symbol={l.symbol} size={30} /><p className="mt-2 font-semibold">{l.symbol} ↑</p>{prices.get(l.symbol) && <p className="text-xs tabular-nums">{usd(prices.get(l.symbol)!.price, 2)} · strike {usd(l.strike, 2)}</p>}<p className="text-muted text-xs">{usd(l.availableUsd)} available</p>{l.listedBy && <p className="text-dim mt-1 text-[0.7rem]">Sold by {l.listedBy.slice(0, 6)}…{l.listedBy.slice(-4)}</p>}</Link>)}</div>
        {filter && !ripable.some(l => `${l.symbol} ${l.name}`.toLowerCase().includes(filter.toLowerCase())) && <p className="mt-4 text-muted text-sm">No positions match that search. Try another ticker.</p>}
        {!loading && !ripable.length && <p className="text-muted mt-4 text-sm">No funded upside positions are available.</p>}
      </section>
      {RIPS_SHOW_EXTRAS && mode === "live" && <details className="mt-8 border-t border-line pt-5 text-sm"><summary>Pool state</summary><p className="text-muted mt-3">Batch {snapshot.batchId.toString()} · Quotes are supplied by the operator and expire within five minutes. A sale quote is not a resale bid.</p><ul className="mt-3 space-y-2">{snapshot.positions.map(({id, row}) => <li key={id.toString()}>{symbolFor(row.stock)} {row.direction === 0 ? "UP" : "DOWN (excluded from Rips)"} · {now >= Number(row.expiry) ? "Expired" : now > Number(row.quoteValidUntil) ? "Quote expired" : row.remainingUnits < row.unitsPerRip ? "Sold out" : `${row.remainingUnits / (row.unitsPerRip || 1n)} one-dollar purchases available`} · Sold {usd(Number(row.amountSold) / 1e6)} · {row.buyerCount.toString()} buyers · {row.collateralSupplied.toString()} raw collateral units</li>)}</ul><Button variant="link" className="text-text mt-3 h-auto p-0 font-normal underline underline-offset-auto" onClick={() => void refresh()}>Refresh pool</Button></details>}
      <RipOverlay stage={stage} amount={packMode ? n : 1} onRipAgain={() => void rip(n)} onClose={close} />
    </>
  );
}
