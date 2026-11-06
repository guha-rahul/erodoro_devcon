"use client";

import Link from "next/link";
import { Anton } from "next/font/google";
import { useEffect, useState, type CSSProperties, type ReactNode } from "react";
import { IS_TESTNET } from "@/lib/deployment";
import { pickLot, shortDate, type PoolLot } from "@/lib/rips/model";
import { useRips } from "./rips-shell";
import { WaitlistInline } from "./waitlist-inline";

const poster = Anton({ weight: "400", subsets: ["latin"] });

// Option D, the screen-printed poster: orange paper, black ink, cream highlight.
// Scoped theme tokens recolour everything inside it (waitlist, pack) to match.
const POSTER_COLORS = { bg: "#e9772f", text: "#1b1b1b", muted: "#2d1a0e", dim: "#4a2a14", accent: "#1b1b1b", ink: "#f2f0e9", panel: "#f2f0e9", line: "#1b1b1b" };
// Both layers: Tailwind's --color-* are resolved at :root, so they need overriding here too.
const POSTER_THEME = Object.fromEntries(
  Object.entries(POSTER_COLORS).flatMap(([k, v]) => [[`--c-${k}`, v], [`--color-${k}`, v]]),
) as CSSProperties;

const POSTER_CSS = `
@keyframes rh-stamp { 0% { transform: scale(1.25) rotate(-3deg); opacity: 0 } 55% { transform: scale(.97) rotate(.5deg); opacity: 1 } 100% { transform: scale(1) rotate(0) } }
@keyframes rh-misreg { from { text-shadow: 14px 8px 0 #2f8f8a, -10px -6px 0 #e8a33d } to { text-shadow: 3px 2px 0 #2f8f8a, -2px -1px 0 #e8a33d } }
@keyframes rh-grain { 0%{transform:translate(0,0)} 25%{transform:translate(-3%,2%)} 50%{transform:translate(2%,-3%)} 75%{transform:translate(-2%,-2%)} 100%{transform:translate(0,0)} }
.rh-stamp { animation: rh-stamp .8s cubic-bezier(.2,.8,.3,1.1) both, rh-misreg 1.4s .3s ease-out both; }
.rh-grain { animation: rh-grain .6s steps(4) infinite; }
@media (prefers-reduced-motion: reduce) { .rh-grain { animation: none } .rh-stamp { animation-duration: 1ms } }
`;

const GRAIN = `url("data:image/svg+xml,${encodeURIComponent("<svg xmlns='http://www.w3.org/2000/svg' width='220' height='220'><filter id='n'><feTurbulence type='fractalNoise' baseFrequency='.85' numOctaves='3' stitchTiles='stitch'/></filter><rect width='100%' height='100%' filter='url(#n)' opacity='.55'/></svg>")}")`;

const money = (n: number, digits = 2) =>
  n.toLocaleString("en-US", { style: "currency", currency: "USD", minimumFractionDigits: digits, maximumFractionDigits: digits });
const claims = (n: number) => n.toLocaleString("en-US", { maximumFractionDigits: n < 1 ? 3 : 2 });

/** Testnet fixtures are `t<TICKER>`; the landing names the stock and says once that these are test tokens. */
const shown = (symbol: string) => (IS_TESTNET && /^t[A-Z]+$/.test(symbol) ? symbol.slice(1) : symbol);

/** One row per stock: its cheapest listing, with everything on offer for it. */
function byStock(lots: PoolLot[]): PoolLot[] {
  const best = new Map<string, PoolLot>();
  for (const l of lots) {
    const cur = best.get(l.symbol);
    if (!cur) best.set(l.symbol, { ...l });
    else {
      const cheaper = l.askPrice < cur.askPrice ? { ...l } : cur;
      best.set(l.symbol, { ...cheaper, availableUsd: cur.availableUsd + l.availableUsd });
    }
  }
  return [...best.values()].sort((a, b) => b.availableUsd - a.availableUsd);
}

const PACK_CSS = `
@keyframes rp-wiggle { 0%,100% { transform: rotate(0) } 25% { transform: rotate(-2.5deg) } 75% { transform: rotate(2.5deg) } }
@keyframes rp-shine { from { background-position: 0% 50% } to { background-position: 200% 50% } }
@keyframes rp-float { 0%,100% { transform: translateY(0) rotate(-1.5deg) } 50% { transform: translateY(-8px) rotate(1.5deg) } }
@keyframes rp-tear { to { transform: translate(70px,-120px) rotate(28deg); opacity: 0 } }
@keyframes rp-out { from { transform: translateY(40%) scale(.9); opacity: 0 } to { transform: translateY(-34%) scale(1); opacity: 1 } }
.rp-pack { animation: rp-float 5s ease-in-out infinite; }
.rp-pack:hover .rp-body, .rp-pack:focus-visible .rp-body { animation: rp-wiggle .35s ease-in-out 2; }
.rp-foil { background: linear-gradient(115deg, var(--c-accent) 0%, color-mix(in oklab, var(--c-accent) 55%, white) 22%, var(--c-accent) 40%, color-mix(in oklab, var(--c-accent) 70%, black) 60%, var(--c-accent) 80%, color-mix(in oklab, var(--c-accent) 55%, white) 100%); background-size: 200% 100%; animation: rp-shine 6s linear infinite; }
.rp-torn .rp-top { animation: rp-tear .5s cubic-bezier(.5,0,.7,.4) forwards; }
.rp-card { animation: rp-out .55s .25s cubic-bezier(.2,.9,.3,1.2) both; }
@media (prefers-reduced-motion: reduce) { .rp-pack, .rp-foil, .rp-pack:hover .rp-body { animation: none } .rp-torn .rp-top { animation-duration: 1ms } .rp-card { animation-duration: 1ms } }
`;

/** A sealed foil pack; torn, it shows the pulled card rising out of it. */
function Pack({ torn, pulled, onRip, disabled }: { torn: number; pulled: PoolLot | null; onRip: () => void; disabled: boolean }) {
  return (
    <button
      type="button"
      onClick={onRip}
      disabled={disabled}
      aria-label={pulled ? `Rip another pack` : "Rip a $1 pack"}
      className="rp-pack relative block h-[17rem] w-[12.5rem] shrink-0 cursor-pointer outline-none disabled:cursor-wait sm:h-[19rem] sm:w-[14rem] lg:h-[25rem] lg:w-[18rem]"
    >
      <span key={torn} className={`rp-body absolute inset-0 block ${torn ? "rp-torn" : ""}`}>
        {pulled && (
          <span className="rp-card bg-panel border-line absolute inset-x-3 top-6 bottom-10 z-0 flex flex-col items-start gap-3 border p-4 text-left shadow-xl">
            <span className="label-mono text-dim text-[0.625rem] tracking-[0.14em] uppercase">You pulled</span>
            <span>
              <span className="display-2 block text-[2.4rem] leading-none">{shown(pulled.symbol)} <span className="text-p">↑</span></span>
              <span className="text-muted prose-editorial mt-2 block text-[0.8125rem] leading-snug">
                {claims(1 / pulled.askPrice)} claims · pays above {money(pulled.strike)} · {shortDate(pulled.expiryTs)}
              </span>
            </span>
          </span>
        )}
        <span className="rp-foil absolute inset-x-0 top-[18%] bottom-0 z-10 flex flex-col items-center justify-center gap-2 text-ink shadow-[0_24px_50px_-18px_rgba(0,0,0,.45)]" style={pulled ? { clipPath: "inset(48% 0 0 0)" } : undefined}>
          {!pulled && <span className="display-2 text-[3rem] leading-none">$1</span>}
          <span className={`label-mono text-[0.625rem] tracking-[0.18em] uppercase opacity-80 ${pulled ? "mt-[55%]" : ""}`}>?? stocks inside</span>
          <span className="label-mono absolute bottom-3 text-[0.5625rem] tracking-[0.2em] uppercase opacity-60">erodoro rips</span>
        </span>
        <span className="rp-top rp-foil absolute inset-x-0 top-0 z-20 flex h-[18%] items-center justify-center border-b-2 border-dashed border-[color-mix(in_oklab,var(--c-ink)_45%,transparent)] text-ink">
          <span className="label-mono text-[0.625rem] tracking-[0.3em] uppercase">░ rip here ░</span>
        </span>
      </span>
    </button>
  );
}

/** A uniform draw for the preview pull; only ever called from event handlers. */
const roll = () => Math.random();

type Look = "classic" | "stripes" | "record" | "ticker" | "poster";
const LOOKS: [Look, string][] = [["classic", "Original"], ["stripes", "A · Stripes"], ["record", "B · Record"], ["ticker", "C · Ticker"], ["poster", "D · Poster"]];

/** The hero treatment: B (record) by default; `?look=` previews the others. */
function useLook(): Look {
  const [look, setLook] = useState<Look>("record");
  useEffect(() => {
    const v = new URLSearchParams(window.location.search).get("look");
    // eslint-disable-next-line react-hooks/set-state-in-effect -- read once after hydration so server and client HTML match
    if (LOOKS.some(([k]) => k === v)) setLook(v as Look);
  }, []);
  return look;
}

const RETRO = { mustard: "#e8a33d", orange: "#e9772f", rust: "#c1512a", brown: "#7a3a1c", cream: "#f2f0e9" };
const LOOK_CSS = `
@keyframes rh-drift { to { transform: translateX(-50%) } }
@keyframes rh-spin { to { transform: rotate(360deg) } }
@keyframes rh-out { to { transform: translateX(58%) } }
@keyframes rh-flap { 0% { transform: rotateX(90deg); opacity:.2 } 60% { transform: rotateX(-12deg); opacity:1 } 100% { transform: rotateX(0) } }
.rh-drift { animation: rh-drift var(--d, 40s) linear infinite; }
.rh-spin { animation: rh-spin 6s linear infinite; }
.rh-out { animation: rh-out .7s cubic-bezier(.2,.8,.3,1) forwards; }
.rh-marquee { animation: rh-drift 38s linear infinite; }
.rh-flap { display:inline-block; animation: rh-flap .55s cubic-bezier(.3,.7,.4,1.3) both; }
@media (prefers-reduced-motion: reduce) { .rh-drift,.rh-spin,.rh-marquee { animation: none } .rh-out,.rh-flap { animation-duration: 1ms } }
`;

/** A: thick wavy 70s bands drifting along the bottom of the hero. */
function Stripes() {
  const wave = (y: number) => {
    let d = `M0 ${y}`;
    for (let x = 0; x < 2400; x += 300) d += ` C ${x + 100} ${y - 70}, ${x + 200} ${y + 70}, ${x + 300} ${y}`;
    return d;
  };
  const bands = [[RETRO.mustard, 330, "46s"], [RETRO.orange, 400, "40s"], [RETRO.rust, 470, "34s"], [RETRO.brown, 540, "28s"]] as const;
  return (
    <div aria-hidden className="pointer-events-none absolute inset-x-0 bottom-0 h-[16rem] opacity-90 lg:h-[20rem]">
      {bands.map(([color, y, dur]) => (
        <svg key={color} viewBox="0 0 2400 700" preserveAspectRatio="none" className="rh-drift absolute inset-y-0 left-0 h-full w-[200%]" style={{ ["--d" as string]: dur }}>
          <path d={wave(y)} fill="none" stroke={color} strokeWidth="64" strokeLinecap="round" />
        </svg>
      ))}
    </div>
  );
}

/** B: a record sleeve; ripping slides the spinning disc out with the pulled stock on its label. */
function RecordPack({ torn, pulled, onRip, disabled }: { torn: number; pulled: PoolLot | null; onRip: () => void; disabled: boolean }) {
  return (
    <button type="button" onClick={onRip} disabled={disabled} aria-label={pulled ? "Rip another pack" : "Rip a $1 pack"} className="relative h-52 w-[19rem] max-w-full shrink-0 cursor-pointer disabled:cursor-wait sm:h-72 sm:w-[30rem]">
      <span key={torn} className={`absolute top-2 left-12 block size-44 sm:top-3 sm:left-24 sm:size-64 ${pulled ? "rh-out" : ""}`}>
        <span className="rh-spin block size-full rounded-full shadow-2xl" style={{ background: `radial-gradient(circle, ${pulled ? RETRO.rust : RETRO.mustard} 0 22%, #111 22.5% 25%, transparent 25%), repeating-radial-gradient(circle, #151515 0 2px, #222 2px 4px)` }} />
        <span className="absolute inset-0 flex flex-col items-center justify-center text-white">
          <span className={`${poster.className} text-[1.05rem] leading-none`}>{pulled ? `${shown(pulled.symbol)} ↑` : "$1"}</span>
          {pulled && <span className="mt-1 font-mono text-[0.5rem] tracking-wide">above {money(pulled.strike, 0)}</span>}
        </span>
      </span>
      <span className="absolute top-0 left-0 z-10 flex size-48 flex-col justify-between p-4 text-left shadow-xl sm:size-72 sm:p-5" style={{ background: `linear-gradient(180deg, ${RETRO.cream} 0 52%, ${RETRO.mustard} 52% 58%, ${RETRO.orange} 58% 64%, ${RETRO.rust} 64% 70%, ${RETRO.brown} 70% 76%, ${RETRO.cream} 76% 100%)` }}>
        <span className={`${poster.className} text-[2rem] leading-none text-[#1b1b1b] sm:text-[2.6rem]`}>RIPS</span>
        <span className="font-mono text-[0.5625rem] tracking-[0.18em] text-[#1b1b1b] uppercase sm:text-[0.625rem]">erodoro · $1 pack · ?? stocks</span>
      </span>
    </button>
  );
}

/** C: split-flap ticker tape of the live markets with their Chainlink prices. */
function TickerTape({ items }: { items: string[] }) {
  if (!items.length) return null;
  const strip = [...items, ...items];
  return (
    <div aria-hidden className="relative -mx-6 -rotate-2 overflow-hidden border-y-4 py-3" style={{ background: "#141210", borderColor: RETRO.rust }}>
      <div className="rh-marquee flex w-max gap-10 font-mono text-[1.15rem] tracking-[0.08em] whitespace-nowrap sm:text-[1.35rem]" style={{ color: RETRO.mustard }}>
        {strip.map((s, i) => (
          <span key={i} className="flex gap-[2px]">
            {[...s].map((ch, j) => (
              <span key={j} className="rh-flap rounded-[2px] bg-[#221e1a] px-[3px]" style={{ animationDelay: `${(i % items.length) * 60 + j * 25}ms` }}>{ch === " " ? "\u00a0" : ch}</span>
            ))}
          </span>
        ))}
      </div>
    </div>
  );
}

/**
 * The landing hero: the promise, and a $1 pack to rip. Ripping here is a stub:
 * it tears open on a labelled preview pull from the live pool and never asks a
 * wallet for anything. Real buys start from /market-rip. The pack is a record
 * sleeve (option B); `?look=` previews the other retro treatments.
 */
export function RipsHero({ fallback }: { fallback: ReactNode }) {
  const { catalog, liveState, now, prices } = useRips();
  const [preview, setPreview] = useState<PoolLot | null>(null);
  const [torn, setTorn] = useState(0);
  const look = useLook();
  // A preview never buys, so it draws from every unexpired position with
  // inventory, not only those whose short-lived (5 minute) house quote is
  // current. Otherwise the pack vanishes whenever quotes lapse.
  const lots = catalog.filter((l) => l.availableUsd >= 1 && l.expiryTs > now);
  const markets = byStock(lots);
  const ready = liveState === "ready" && markets.length > 0;
  const isPoster = look === "poster";

  // A stub: the landing only ever previews a pull. Buying happens on /market-rip.
  const onRip = () => {
    setTorn((n) => n + 1);
    setPreview(pickLot(lots, roll()));
  };
  const tape = markets.map((l) => {
    const p = prices.get(l.symbol)?.price;
    return `${shown(l.symbol)} ↑ ${p ? money(p) : "···"}`;
  });

  return (
    <div className={isPoster ? "bg-bg text-text relative overflow-clip" : "relative overflow-clip"} style={isPoster ? POSTER_THEME : undefined}>
      <style>{PACK_CSS + POSTER_CSS + LOOK_CSS}</style>
      {isPoster && <div aria-hidden className="rh-grain pointer-events-none absolute -inset-[10%] opacity-30 mix-blend-multiply" style={{ backgroundImage: GRAIN }} />}
      {look === "stripes" && <Stripes />}
      <div className={`relative mx-auto grid max-w-5xl items-center gap-12 px-6 py-14 lg:grid-cols-[minmax(0,1.15fr)_auto] lg:gap-20 ${look === "ticker" ? "min-h-[calc(100svh-16rem)]" : "min-h-[calc(100svh-9rem)]"} ${look === "stripes" ? "pb-56 lg:pb-64" : ""}`}>
        <div className="flex flex-col items-center text-center lg:items-start lg:text-left">
          {isPoster ? (
            <h1 className={`${poster.className} rh-stamp text-[clamp(3.5rem,10vw,8.5rem)] leading-[0.88] tracking-tight uppercase`}>
              Buy the<br />upside.<br /><span className="text-[#f2f0e9]">$1.</span>
            </h1>
          ) : (
            <h1 className="display-1 max-w-[13ch] text-balance">Buy a stock&rsquo;s upside for $1.</h1>
          )}
          <p className={`text-muted prose-editorial max-w-[38ch] text-lg text-pretty ${isPoster ? "mt-7" : "mt-6"}`}>
            Rip a pack, get a random stock&rsquo;s claims. They pay if it ends above a set price.
          </p>
          <div data-hero-actions className="mt-10 flex w-full flex-col items-center gap-4 lg:items-start">
            <WaitlistInline />
            <Link href="/market-rip" className="bg-text text-bg hover:bg-accent hover:text-ink label-mono inline-flex items-center gap-3 px-6 py-3.5 tracking-[0.1em] uppercase transition-colors">
              Open app <span aria-hidden>↗</span>
            </Link>
          </div>
        </div>
        <div className="mt-12 flex flex-col items-center gap-5 lg:mt-0">
          {!(ready || liveState === "loading")
            ? <div className="w-full max-w-md">{fallback}</div>
            : look === "record"
              ? <RecordPack torn={torn} pulled={preview} onRip={onRip} disabled={!ready} />
              : <Pack torn={torn} pulled={preview} onRip={onRip} disabled={!ready} />}
          <div className={`flex items-center gap-4 ${preview ? "" : "invisible"}`} role="status" data-preview>
            <span className="label-mono text-dim text-[0.6875rem] tracking-[0.12em] uppercase">Preview · nothing bought</span>
          </div>
        </div>
      </div>
      {look === "ticker" && <div className="px-6 pb-12"><TickerTape items={tape} /></div>}
    </div>
  );
}
