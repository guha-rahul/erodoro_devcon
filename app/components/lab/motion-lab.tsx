"use client";

import { Anton } from "next/font/google";
import { useEffect, useMemo, useState } from "react";
import { COINBASE_STOCK_FEEDS, stockPrice } from "@/lib/rips/prices";
import { IS_TESTNET } from "@/lib/deployment";

const poster = Anton({ weight: "400", subsets: ["latin"], variable: "--font-poster" });

// 70s palette from the moodboard, layered on the app's own accent.
const RUST = "#c1512a", ORANGE = "#e9772f", MUSTARD = "#e8a33d", BROWN = "#7a3a1c", CREAM = "#f2f0e9", TEAL = "#2f8f8a";
const TICKERS = Object.keys(COINBASE_STOCK_FEEDS);

const CSS = `
@keyframes ml-drift { to { transform: translateX(-50%) } }
@keyframes ml-spin { to { transform: rotate(360deg) } }
@keyframes ml-marquee { to { transform: translateX(-50%) } }
@keyframes ml-flap { 0% { transform: rotateX(90deg); opacity:.2 } 60% { transform: rotateX(-12deg); opacity:1 } 100% { transform: rotateX(0) } }
@keyframes ml-stamp { 0% { transform: scale(1.25) rotate(-3deg); opacity: 0 } 55% { transform: scale(.97) rotate(.5deg); opacity: 1 } 100% { transform: scale(1) rotate(0) } }
@keyframes ml-misreg { from { text-shadow: 14px 8px 0 ${TEAL}, -10px -6px 0 ${MUSTARD} } to { text-shadow: 3px 2px 0 ${TEAL}, -2px -1px 0 ${MUSTARD} } }
@keyframes ml-grain { 0%{transform:translate(0,0)} 25%{transform:translate(-3%,2%)} 50%{transform:translate(2%,-3%)} 75%{transform:translate(-2%,-2%)} 100%{transform:translate(0,0)} }
@keyframes ml-out { to { transform: translateX(62%) } }
.ml-drift { animation: ml-drift var(--d, 40s) linear infinite; }
.ml-spin { animation: ml-spin 6s linear infinite; }
.ml-marquee { animation: ml-marquee 38s linear infinite; }
.ml-flap { display:inline-block; animation: ml-flap .55s cubic-bezier(.3,.7,.4,1.3) both; transform-origin: 50% 50%; }
.ml-stamp { animation: ml-stamp .8s cubic-bezier(.2,.8,.3,1.1) both, ml-misreg 1.4s .3s ease-out both; }
.ml-grain { animation: ml-grain .6s steps(4) infinite; }
.ml-out { animation: ml-out .7s cubic-bezier(.2,.8,.3,1) forwards; }
@media (prefers-reduced-motion: reduce) { .ml-drift,.ml-spin,.ml-marquee,.ml-grain { animation: none } .ml-flap,.ml-stamp,.ml-out { animation-duration: 1ms } }
`;

function Label({ id, title, note }: { id: string; title: string; note: string }) {
  return (
    <div className="absolute top-4 left-4 z-30 max-w-xs bg-black/80 px-3 py-2 font-mono text-[0.6875rem] text-white">
      <b className="tracking-[0.12em] uppercase">Option {id} · {title}</b>
      <p className="mt-1 opacity-75">{note}</p>
    </div>
  );
}

function Headline({ className = "" }: { className?: string }) {
  return <h2 className={`display-1 relative z-10 max-w-[13ch] text-balance ${className}`}>Buy a stock&rsquo;s upside for $1.</h2>;
}

/** A: thick sine-wave stripes in the 70s palette drifting behind the hero. */
function Stripes() {
  // A sine-like band: one cubic per 300px, repeated across twice the width so the drift loops seamlessly.
  const wave = (y: number) => {
    let d = `M0 ${y}`;
    for (let x = 0; x < 2400; x += 300) d += ` C ${x + 100} ${y - 70}, ${x + 200} ${y + 70}, ${x + 300} ${y}`;
    return d;
  };
  const bands = [[MUSTARD, 330, "46s"], [ORANGE, 400, "40s"], [RUST, 470, "34s"], [BROWN, 540, "28s"]] as const;
  return (
    <section id="a" className="relative flex min-h-[38rem] items-center overflow-hidden px-8">
      <Label id="A" title="Wavy 70s stripes" note="Four bands drift at different speeds behind the hero." />
      <div aria-hidden className="absolute inset-x-0 bottom-0 h-[26rem] opacity-90">
        {bands.map(([color, y, dur]) => (
          <svg key={color} viewBox="0 0 2400 700" preserveAspectRatio="none" className="ml-drift absolute inset-y-0 left-0 h-full w-[200%]" style={{ ["--d" as string]: dur }}>
            <path d={wave(y)} fill="none" stroke={color} strokeWidth="64" strokeLinecap="round" />
          </svg>
        ))}
      </div>
      <div className="relative mx-auto w-full max-w-5xl pb-40"><Headline /></div>
    </section>
  );
}

/** B: a record sleeve; the disc spins, and ripping slides it out with the pulled stock on its label. */
function RecordPack() {
  const [pulled, setPulled] = useState<string | null>(null);
  const [n, setN] = useState(0);
  const rip = () => { setN((x) => x + 1); setPulled(TICKERS[Math.floor(Math.random() * TICKERS.length)]); };
  return (
    <section id="b" className="relative flex min-h-[38rem] items-center overflow-hidden px-8">
      <Label id="B" title="Spinning record pack" note="Click the sleeve. The record slides out with your pull on the label (demo pick)." />
      <div className="mx-auto grid w-full max-w-5xl items-center gap-12 lg:grid-cols-[1fr_auto]">
        <Headline />
        <button type="button" onClick={rip} aria-label="Rip the record pack" className="relative h-72 w-[30rem] max-w-full cursor-pointer">
          <span key={n} className={`absolute top-4 left-24 block size-64 ${pulled ? "ml-out" : ""}`}>
            <span className="ml-spin block size-full rounded-full shadow-2xl" style={{ background: `radial-gradient(circle, ${pulled ? RUST : MUSTARD} 0 18%, #111 18.5% 21%, transparent 21%), repeating-radial-gradient(circle, #151515 0 2px, #222 2px 4px)` }}>
            </span>
            <span className="absolute inset-0 flex items-center justify-center text-[0.95rem] tracking-wide text-white" style={{ fontFamily: "var(--font-poster)" }}>{pulled ? `${pulled} ↑` : "$1"}</span>
          </span>
          <span className="absolute top-0 left-0 z-10 flex size-72 flex-col justify-between p-5 text-left shadow-xl" style={{ background: `repeating-linear-gradient(180deg, ${CREAM} 0 52%, ${MUSTARD} 52% 58%, ${ORANGE} 58% 64%, ${RUST} 64% 70%, ${BROWN} 70% 76%, ${CREAM} 76% 100%)` }}>
            <span className="text-[2.6rem] leading-none text-[#1b1b1b]" style={{ fontFamily: "var(--font-poster)" }}>RIPS</span>
            <span className="font-mono text-[0.625rem] tracking-[0.2em] text-[#1b1b1b] uppercase">erodoro · $1 pack · ?? stocks</span>
          </span>
        </button>
      </div>
    </section>
  );
}

/** C: split-flap ticker tape with live Chainlink prices. */
function Ticker() {
  const [prices, setPrices] = useState<Record<string, number>>({});
  useEffect(() => {
    let live = true;
    void Promise.all(TICKERS.map(async (t) => [t, (await stockPrice(IS_TESTNET ? `t${t}` : t))?.price] as const)).then((rows) => {
      if (live) setPrices(Object.fromEntries(rows.filter(([, p]) => p).map(([t, p]) => [t, p!])));
    });
    return () => { live = false; };
  }, []);
  const items = TICKERS.map((t) => `${t} ↑ ${prices[t] ? `$${prices[t].toFixed(2)}` : "···"}`);
  const strip = [...items, ...items];
  return (
    <section id="c" className="relative flex min-h-[38rem] flex-col justify-center overflow-hidden">
      <Label id="C" title="Split-flap ticker tape" note="Live Chainlink prices scroll past; letters flip in like a departure board." />
      <div className="mx-auto w-full max-w-5xl px-8"><Headline /></div>
      <div className="mt-14 -rotate-2 overflow-hidden border-y-4 py-3" style={{ background: "#141210", borderColor: RUST }}>
        <div className="ml-marquee flex w-max gap-10 font-mono text-[1.35rem] tracking-[0.08em] whitespace-nowrap" style={{ color: MUSTARD }}>
          {strip.map((s, i) => (
            <span key={i} className="flex gap-[2px]">
              {[...s].map((ch, j) => (
                <span key={j} className="ml-flap rounded-[2px] bg-[#221e1a] px-[3px]" style={{ animationDelay: `${(i % items.length) * 60 + j * 25}ms` }}>{ch === " " ? " " : ch}</span>
              ))}
            </span>
          ))}
        </div>
      </div>
    </section>
  );
}

/** D: a screen-printed poster headline that stamps in and settles its misregistration, under moving film grain. */
function PosterReveal() {
  const [k, setK] = useState(0);
  const grain = useMemo(() => `url("data:image/svg+xml,${encodeURIComponent("<svg xmlns='http://www.w3.org/2000/svg' width='220' height='220'><filter id='n'><feTurbulence type='fractalNoise' baseFrequency='.85' numOctaves='3' stitchTiles='stitch'/></filter><rect width='100%' height='100%' filter='url(#n)' opacity='.55'/></svg>")}")`, []);
  return (
    <section id="d" className="relative flex min-h-[38rem] items-center overflow-hidden px-8" style={{ background: ORANGE }}>
      <Label id="D" title="Poster headline reveal" note="Stamps in with ink misregistration, then settles. Film grain moves on top. Click to replay." />
      <div aria-hidden className="ml-grain pointer-events-none absolute -inset-[10%] opacity-30 mix-blend-multiply" style={{ backgroundImage: grain }} />
      <button type="button" onClick={() => setK((x) => x + 1)} className="relative mx-auto w-full max-w-5xl cursor-pointer text-left">
        <span key={k} className="ml-stamp block text-[clamp(3.5rem,11vw,9.5rem)] leading-[0.88] tracking-tight text-[#1b1b1b] uppercase" style={{ fontFamily: "var(--font-poster)" }}>
          Buy the<br />upside.<br /><span style={{ color: CREAM }}>$1.</span>
        </span>
      </button>
    </section>
  );
}

export function MotionLab() {
  return (
    <div className={`${poster.variable} bg-bg text-text`}>
      <style>{CSS}</style>
      <nav className="bg-bg/90 border-line sticky top-0 z-40 flex flex-wrap items-center gap-2 border-b px-4 py-3 font-mono text-xs backdrop-blur">
        <b className="mr-2 tracking-[0.12em] uppercase">Motion lab</b>
        {[["a", "A · Stripes"], ["b", "B · Record"], ["c", "C · Ticker"], ["d", "D · Poster"]].map(([id, l]) => (
          <a key={id} href={`#${id}`} className="border-line hover:border-text border px-2.5 py-1">{l}</a>
        ))}
      </nav>
      <Stripes />
      <RecordPack />
      <Ticker />
      <PosterReveal />
    </div>
  );
}
