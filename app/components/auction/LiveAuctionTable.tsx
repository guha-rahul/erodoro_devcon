"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { useSeriesList } from "@/lib/use-series";
import { useNow } from "@/lib/use-now";
import { assetFor } from "@/lib/issuers";
import { formatDate, fromRaw } from "@/lib/format";
import { DEPLOYMENT } from "@/lib/deployment";
import { SWAP_API } from "@/lib/swap-api";
import type { AuctionView, SellIntentWire } from "@/lib/use-intent";
import { AuctionStatusBadge } from "./AuctionStatusBadge";

type Row = { auction: AuctionView; intent: SellIntentWire | null };

/**
 * Screen 4 — Live Auctions. One card per opportunity, with the current
 * leading premium, seller minimum, countdown, and one clear bidding action.
 */
export function LiveAuctionTable() {
  const [rows, setRows] = useState<Row[] | null>(null);
  const { data: series } = useSeriesList();
  const now = useNow();
  const quote = DEPLOYMENT.quote;

  useEffect(() => {
    let live = true;
    let failures = 0;
    const load = async () => {
      try {
        const res = await fetch(`${SWAP_API}/api/auctions`);
        const body = await res.json().catch(() => null);
        if (!res.ok || !Array.isArray(body?.auctions)) throw new Error("bad response");
        const list: AuctionView[] = body.auctions ?? [];
        const full: Row[] = await Promise.all(
          list.map(async (a) => {
            try {
              // Keep list status aligned with the coordinator clock even when
              // nobody has opened the individual auction view.
              await fetch(`${SWAP_API}/api/auctions/${a.id}/advance`, { method: "POST" });
              const r = await fetch(`${SWAP_API}/api/auctions/${a.id}`);
              if (!r.ok) return { auction: a, intent: null };
              const f = await r.json();
              return { auction: f.auction ?? a, intent: f.intent ?? null };
            } catch {
              return { auction: a, intent: null };
            }
          }),
        );
        if (live) setRows(full);
      } catch {
        // After repeated failures show the empty state instead of spinning:
        // the coordinator is unreachable, which is itself the signal.
        failures += 1;
        if (live && failures >= 3) setRows([]);
      }
    };
    load();
    const timer = setInterval(load, 8000);
    return () => {
      live = false;
      clearInterval(timer);
    };
  }, []);

  if (rows === null) {
    return <p className="text-muted py-8 text-sm">Loading live auctions…</p>;
  }
  const open = rows.filter(
    (r) => r.intent && !["Filled", "Settled", "Cancelled", "Expired", "Failed"].includes(r.auction.state),
  );
  if (open.length === 0) {
    return (
      <div className="border-line bg-panel rounded-md border p-8 text-center">
        <p className="text-base font-medium">No upside is for sale right now.</p>
        <p className="text-muted mx-auto mt-2 max-w-md text-sm">Start an auction from Earn and it will appear here as soon as it opens.</p>
        <Link href="/earn" className="bg-text text-bg hover:bg-accent mt-5 inline-block rounded-sm px-4 py-2.5 text-sm font-medium transition-colors">
          Sell upside →
        </Link>
      </div>
    );
  }

  const byId = new Map(series.map((s) => [s.id.toString(16).padStart(64, "0"), s]));

  return (
    <div>
      <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
          {open.map(({ auction, intent }) => {
            if (!intent) return null;
            const seriesId = (BigInt(intent.claimId) & ~1n).toString(16).padStart(64, "0");
            const s = byId.get(seriesId);
            const asset = assetFor(intent.collateral);
            const dp = s?.config.collateralDecimals ?? asset?.decimals ?? 8;
            const priceDec = s?.config.priceDecimals ?? 8;
            const capUsd = Number(BigInt(intent.strike)) / 10 ** priceDec;
            const best = auction.bids.length
              ? [...auction.bids].sort((a, b) => {
                  const left = BigInt(b.premium) * BigInt(a.amount);
                  const right = BigInt(a.premium) * BigInt(b.amount);
                  return left === right ? 0 : left > right ? 1 : -1;
                })[0]
              : null;
            const endsAt = auction.path === "discovery" ? auction.discoveryEndsAt : auction.fastEndsAt;
            const left = Math.max(0, endsAt - Number(now));
            const mm = String(Math.floor(left / 60)).padStart(2, "0");
            const ss = String(left % 60).padStart(2, "0");
            const bidders = new Set(auction.bids.map((b) => b.bidder.toLowerCase())).size;
            const remaining = BigInt(intent.claimAmount) - BigInt(auction.filledAmount ?? "0");
            const claimUnit = 10n ** BigInt(dp);
            const minimumPerShare = (BigInt(intent.minPremium) * claimUnit + BigInt(intent.claimAmount) - 1n)
              / BigInt(intent.claimAmount);
            const bestPerShare = best
              ? (BigInt(best.premium) * claimUnit + BigInt(best.amount) - 1n) / BigInt(best.amount)
              : null;
            const buyerSelected = Boolean(auction.winner);
            const href = `/app?market=${seriesId}&auction=${auction.id}#live-auction`;
            return (
              <article key={auction.id} className="border-line bg-panel rounded-md border p-5 transition-[border-color,transform] hover:-translate-y-0.5 hover:border-text/50">
                <div className="flex items-start justify-between gap-3">
                  <div>
                    <h2 className="text-xl font-medium">{asset?.symbol ?? "Stock"} upside</h2>
                    <p className="text-muted mt-1 text-sm">Gains above <span className="font-mono text-text">${capUsd.toFixed(2)}</span></p>
                  </div>
                  <AuctionStatusBadge status={buyerSelected ? "Winner" : "LIVE"} />
                </div>

                <dl className="border-line-soft mt-5 grid grid-cols-2 gap-x-4 gap-y-5 border-y py-5 text-sm">
                  <div>
                    <dt className="text-dim text-[0.7rem] tracking-[0.08em] uppercase">Quantity</dt>
                    <dd className="mt-1 font-mono tabular-nums">{fromRaw(remaining, dp, dp)} {asset?.symbol}</dd>
                  </div>
                  <div>
                    <dt className="text-dim text-[0.7rem] tracking-[0.08em] uppercase">{auction.round && auction.round > 1 ? `Round ${auction.round} · time left` : "Time left"}</dt>
                    <dd className="mt-1 font-mono text-lg tabular-nums" role="timer">{mm}:{ss}</dd>
                  </div>
                  <div className="col-span-2">
                    <dt className="text-dim text-[0.7rem] tracking-[0.08em] uppercase">Expiry</dt>
                    <dd className="mt-1">{s ? formatDate(s.config.maturity) : "—"}</dd>
                  </div>
                </dl>

                <div className="mt-5 flex items-end justify-between gap-4">
                  <div>
                    <p className="text-dim text-[0.7rem] tracking-[0.08em] uppercase">{buyerSelected ? "Winning bid / share" : bestPerShare ? "Highest bid / share" : "Seller minimum / share"}</p>
                    <p className="mt-1 font-mono text-2xl font-medium tabular-nums">
                      {buyerSelected && auction.winner
                        ? `${fromRaw((BigInt(auction.winner.premium) * claimUnit + BigInt(auction.winner.amount) - 1n) / BigInt(auction.winner.amount), quote!.decimals, quote!.decimals)} ${quote!.symbol}`
                        : `${fromRaw(bestPerShare ?? minimumPerShare, quote!.decimals, quote!.decimals)} ${quote!.symbol}`}
                    </p>
                  </div>
                  <p className="text-dim text-right text-xs">{bidders} {bidders === 1 ? "bidder" : "bidders"}</p>
                </div>

                {bestPerShare && !buyerSelected && (
                  <p className="text-muted mt-3 text-xs">
                    Seller minimum: <span className="font-mono text-text">{fromRaw(minimumPerShare, quote!.decimals, quote!.decimals)} {quote!.symbol} / share</span>
                  </p>
                )}
                <a href={href} className="bg-text text-bg hover:bg-accent mt-5 block rounded-sm px-4 py-3 text-center text-sm font-medium transition-colors">
                  {buyerSelected ? "View result →" : "Bid on upside →"}
                </a>
              </article>
            );
          })}
      </div>
      <div className="text-dim mt-4 flex items-center gap-2 text-[0.78rem]">
        <AuctionStatusBadge status="LIVE" />
        <span>{open.length} live {open.length === 1 ? "auction" : "auctions"} · highest valid bid wins when time expires</span>
      </div>
    </div>
  );
}
