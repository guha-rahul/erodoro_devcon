"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { useAccount } from "wagmi";
import { usePortfolioBalances } from "@/lib/use-balances";
import { useSeriesList } from "@/lib/use-series";
import { useNow } from "@/lib/use-now";
import { assetFor } from "@/lib/issuers";
import { formatDate, fromRaw } from "@/lib/format";
import { DEPLOYMENT, txExplorer } from "@/lib/deployment";
import { SWAP_API } from "@/lib/swap-api";
import type { AuctionView, SellIntentWire } from "@/lib/use-intent";
import { isMatured } from "@/lib/market-status";
import { Panel } from "../ui";
import { InvestPremiumPanel } from "../megapot/InvestPremiumPanel";
import { AuctionStatusBadge } from "./AuctionStatusBadge";

type Entry = { intent: SellIntentWire; auction: AuctionView | null; role: "seller" | "buyer" };

/** Compact auction position row. Premium shown only where actually known. */
export function PositionCard({ entry }: { entry: Entry }) {
  const { intent, auction, role } = entry;
  const asset = assetFor(intent.collateral);
  const quote = DEPLOYMENT.quote!;
  const dp = asset?.decimals ?? 8;
  const capUsd = Number(BigInt(intent.strike)) / 10 ** 8;
  const seriesId = (BigInt(intent.claimId) & ~1n).toString(16).padStart(64, "0");
  const premium =
    auction?.winningPremium ? fromRaw(BigInt(auction.winningPremium), quote.decimals, 2) : null;
  const rawPremium = auction?.winningPremium ? BigInt(auction.winningPremium) : null;
  return (
    <div className="border-line-soft flex flex-wrap items-center justify-between gap-3 border-b py-3 last:border-0">
      <div>
        <div className="font-medium">
          {asset?.symbol ?? "Stock"} · {fromRaw(BigInt(intent.claimAmount), dp, 2)} @ ${capUsd.toFixed(2)} cap
        </div>
        <div className="text-dim mt-0.5 font-mono text-[0.78rem] tabular-nums">
          Expires {formatDate(BigInt(intent.maturity))} · Floor {fromRaw(BigInt(intent.minPremium), quote.decimals, 2)} {quote.symbol}
          {premium !== null && <> · {role === "seller" ? "Earned" : "Paid"} {premium} {quote.symbol}</>}
        </div>
      </div>
      <div className="flex items-center gap-2">
        <AuctionStatusBadge status={auction ? auction.state : "Signed"} />
        {rawPremium !== null && rawPremium > 0n && (
          <InvestPremiumPanel premium={rawPremium} symbol={quote.symbol} compact />
        )}
        <Link
          href={`/app?market=${seriesId}&auction=${intentHashOf(intent)}`}
          className="border-line hover:border-text rounded-sm border px-3 py-1.5 text-[0.8125rem] transition-colors"
        >
          Open
        </Link>
      </div>
    </div>
  );
}

function intentHashOf(intent: SellIntentWire): string {
  const key = `${intent.seller.toLowerCase()}|${intent.claims.toLowerCase()}|${intent.claimId}|${intent.nonce}`;
  let h1 = 0x811c9dc5;
  let h2 = 0x01000193;
  let out = "";
  for (let i = 0; i < 8; i++) {
    for (let j = 0; j < key.length; j++) {
      h1 = (h1 ^ (key.charCodeAt(j) + i * 31 + j)) >>> 0;
      h1 = Math.imul(h1, 16777619) >>> 0;
      h2 = (Math.imul(h2, 31) + key.charCodeAt(j) + i) >>> 0;
    }
    out += h1.toString(16).padStart(8, "0") + h2.toString(16).padStart(8, "0");
  }
  return `0x${out.slice(0, 64)}`;
}

/** Auction history: every terminal intent with its outcome and receipt. */
export function HistoryTable({ entries }: { entries: Entry[] }) {
  const quote = DEPLOYMENT.quote!;
  const done = entries.filter((e) =>
    ["Filled", "Settled", "Cancelled", "Expired", "Failed"].includes(e.auction?.state ?? ""),
  );
  if (done.length === 0) {
    return <p className="text-dim py-4 text-sm">No auction history yet.</p>;
  }
  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[720px] text-left text-sm">
        <thead>
          <tr className="border-line-soft text-dim border-b text-[0.72rem] tracking-[0.08em] uppercase">
            <th className="py-2 pr-4 font-medium">Date</th>
            <th className="py-2 pr-4 font-medium">Asset</th>
            <th className="py-2 pr-4 font-medium">Qty</th>
            <th className="py-2 pr-4 font-medium">Cap</th>
            <th className="py-2 pr-4 font-medium">Expiry</th>
            <th className="py-2 pr-4 font-medium">Winning premium</th>
            <th className="py-2 pr-4 font-medium">Status</th>
            <th className="py-2 font-medium">Tx</th>
          </tr>
        </thead>
        <tbody className="divide-line-soft divide-y">
          {done.map(({ intent, auction }) => {
            const asset = assetFor(intent.collateral);
            const dp = asset?.decimals ?? 8;
            return (
              <tr key={intentHashOf(intent)}>
                <td className="py-2 pr-4 whitespace-nowrap">{formatDate(BigInt(auction?.createdAt ?? 0))}</td>
                <td className="py-2 pr-4 font-medium">{asset?.symbol ?? "—"}</td>
                <td className="py-2 pr-4 font-mono tabular-nums">{fromRaw(BigInt(intent.claimAmount), dp, 2)}</td>
                <td className="py-2 pr-4 font-mono tabular-nums">${(Number(BigInt(intent.strike)) / 1e8).toFixed(2)}</td>
                <td className="py-2 pr-4 whitespace-nowrap">{formatDate(BigInt(intent.maturity))}</td>
                <td className="py-2 pr-4 font-mono tabular-nums">
                  {auction?.winningPremium ? `${fromRaw(BigInt(auction.winningPremium), quote.decimals, 2)} ${quote.symbol}` : "—"}
                </td>
                <td className="py-2 pr-4"><AuctionStatusBadge status={auction?.state ?? "Expired"} /></td>
                <td className="py-2 font-mono">
                  {auction?.settlementTx ? (
                    <a href={txExplorer(auction.settlementTx)} target="_blank" rel="noreferrer" className="underline underline-offset-4">
                      {auction.settlementTx.slice(0, 8)}…
                    </a>
                  ) : (
                    <span className="text-dim">—</span>
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

const TABS = ["Auctioning", "Filled", "History"] as const;

/** Screens 6+7 — the wallet's auction positions and their outcomes. */
export function AuctionPortfolio() {
  const { address, isConnected } = useAccount();
  const [entries, setEntries] = useState<Entry[] | null>(null);
  const [tab, setTab] = useState<(typeof TABS)[number]>("Auctioning");
  const marketQuery = useSeriesList();
  const balances = usePortfolioBalances(marketQuery.data);
  const now = useNow();

  useEffect(() => {
    if (!address) return;
    let live = true;
    let failures = 0;
    const load = async () => {
      try {
        const res = await fetch(`${SWAP_API}/api/intents?status=all`);
        const body = await res.json().catch(() => null);
        if (!res.ok || !Array.isArray(body?.intents)) throw new Error("bad response");
        const intents: SellIntentWire[] = body.intents ?? [];
        const full: Entry[] = await Promise.all(
          intents.map(async (intent) => {
            const id = intentHashOf(intent);
            try {
              const r = await fetch(`${SWAP_API}/api/auctions/${id}`);
              if (!r.ok) return { intent, auction: null, role: "seller" as const };
              const f = await r.json();
              const auction = (f.auction ?? null) as AuctionView | null;
              const buyer = auction?.buyer
                ?? auction?.winner?.bidder
                ?? (auction?.state === "Filled" && auction.bids.length === 1 ? auction.bids[0].bidder : null);
              const role = buyer?.toLowerCase() === address.toLowerCase() ? "buyer" : "seller";
              return { intent, auction, role };
            } catch {
              return { intent, auction: null, role: "seller" as const };
            }
          }),
        );
        const mine = full.filter(({ intent, role }) =>
          role === "buyer" || intent.seller.toLowerCase() === address.toLowerCase(),
        );
        if (live) setEntries(mine);
      } catch {
        failures += 1;
        if (live && failures >= 3) setEntries([]);
      }
    };
    load();
    const timer = setInterval(load, 10_000);
    return () => {
      live = false;
      clearInterval(timer);
    };
  }, [address]);

  if (!isConnected) return null;

  const openStates = ["FastAuction", "DiscoveryAuction", "BidReceived", "PartiallyFilled", "SettlementPending"];
  const auctioning = (entries ?? []).filter((e) => e.auction && openStates.includes(e.auction.state));
  const filled = (entries ?? []).filter((e) => ["Filled", "Settled"].includes(e.auction?.state ?? ""));
  const maturedCount = balances.rows.filter(
    ({ series, p, n }) => (p > 0n || n > 0n) && isMatured(series, now),
  ).length;

  return (
    <Panel title="Auctions" subtitle="Your upside auctions and their outcomes">
      <div className="flex gap-1" role="tablist" aria-label="Auction positions">
        {TABS.map((t) => (
          <button
            key={t}
            role="tab"
            aria-selected={tab === t}
            onClick={() => setTab(t)}
            className={`rounded-sm px-3 py-1.5 text-[0.8125rem] transition-colors ${
              tab === t ? "bg-panel-2 text-text font-medium" : "text-muted hover:text-text"
            }`}
          >
            {t}
            {t === "Auctioning" && auctioning.length > 0 && ` (${auctioning.length})`}
            {t === "Filled" && filled.length > 0 && ` (${filled.length})`}
          </button>
        ))}
      </div>
      <div className="mt-3">
        {entries === null ? (
          <p className="text-muted py-4 text-sm">Loading your auctions…</p>
        ) : tab === "Auctioning" ? (
          auctioning.length === 0 ? (
            <p className="text-dim py-4 text-sm">
              No open auctions. Start one from Earn — and note {maturedCount} matured onchain position{maturedCount === 1 ? "" : "s"} below.
            </p>
          ) : (
            auctioning.map((e) => <PositionCard key={intentHashOf(e.intent)} entry={e} />)
          )
        ) : tab === "Filled" ? (
          filled.length === 0 ? (
            <p className="text-dim py-4 text-sm">Nothing filled yet.</p>
          ) : (
            filled.map((e) => <PositionCard key={intentHashOf(e.intent)} entry={e} />)
          )
        ) : (
          <HistoryTable entries={entries} />
        )}
        <p className="text-dim mt-3 text-[0.78rem]">
          Onchain P/N holdings remain in Positions above; premium earned shows only where the
          auction recorded a winning premium.
        </p>
      </div>
    </Panel>
  );
}
