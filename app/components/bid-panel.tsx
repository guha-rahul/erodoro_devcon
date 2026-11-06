"use client";

import { useEffect, useState } from "react";
import { useAccount } from "wagmi";
import { useAuction, useBidder, intentAvailable, type AuctionView, type SellIntentWire } from "@/lib/use-intent";
import { DEPLOYMENT, txExplorer } from "@/lib/deployment";
import { SWAP_API } from "@/lib/swap-api";
import { assetFor } from "@/lib/issuers";
import { fromRaw, toRaw } from "@/lib/format";
import { nId, type Series } from "@/lib/types";
import { AmountInput, Button, Panel, TxStatus } from "./ui";
import { AuctionStatusBadge } from "./auction/AuctionStatusBadge";
import { PayoffPreview } from "./auction/Summary";

/**
 * Screen 5 — Buy upside. One market's open auctions, a premium bid form,
 * winner settlement, and plain payoff examples. No Greeks, no book.
 */
export function BidPanel({ series, initialAuction = null }: { series: Series; initialAuction?: string | null }) {
  const { address, isConnected } = useAccount();
  const { state, submitBid, settle } = useBidder();
  const [auctions, setAuctions] = useState<AuctionView[]>([]);
  const [intents, setIntents] = useState<Record<string, SellIntentWire>>({});
  const [amount, setAmount] = useState("");
  const [premium, setPremium] = useState("");
  const [selected, setSelected] = useState<string | null>(initialAuction);
  const [tx, setTx] = useState<string | null>(null);

  const quote = DEPLOYMENT.quote;
  const dp = series.config.collateralDecimals;
  const wantedN = nId(series.id);
  const asset = assetFor(series.config.collateral);

  useEffect(() => {
    let live = true;
    const load = async () => {
      try {
        const res = await fetch(`${SWAP_API}/auctions`);
        if (!res.ok) return;
        const body = await res.json();
        const mine = (body.auctions ?? []).filter((a: AuctionView) => a.bids !== undefined);
        if (!live) return;
        const found: AuctionView[] = [];
        const wires: Record<string, SellIntentWire> = {};
        await Promise.all(
          mine.map(async (a: AuctionView) => {
            try {
              const r = await fetch(`${SWAP_API}/auctions/${a.id}`);
              if (!r.ok) return;
              const full = await r.json();
              if (full.intent && BigInt(full.intent.claimId) === wantedN) {
                found.push(full.auction);
                wires[a.id] = full.intent;
              }
            } catch {
              /* skip */
            }
          }),
        );
        if (live) {
          setAuctions(found);
          setIntents(wires);
          if (!selected && found.length > 0) setSelected(found[0].id);
        }
      } catch {
        /* offline */
      }
    };
    load();
    const timer = setInterval(load, 8000);
    return () => {
      live = false;
      clearInterval(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [series.id]);

  if (!intentAvailable() || !quote) {
    return (
      <Panel title="Buy upside" subtitle="Get leveraged upside without liquidation">
        <p className="text-muted text-sm leading-6">
          Bidding is not live on this network yet. When it is, open auctions for this market appear here.
        </p>
      </Panel>
    );
  }

  const auction = auctions.find((a) => a.id === selected) ?? null;
  const wire = selected ? intents[selected] : null;
  const winner = auction?.winner ?? null;
  const iWon = winner && address && winner.bidder.toLowerCase() === address.toLowerCase();
  const rawAmount = amount ? toRaw(amount, dp) : 0n;
  const rawPremium = premium && quote ? toRaw(premium, quote.decimals) : 0n;
  const capUsd = wire ? Number(BigInt(wire.strike)) / 10 ** series.config.priceDecimals : 0;
  const qty = wire ? Number(BigInt(wire.claimAmount)) / 10 ** dp : 0;

  return (
    <Panel title={`Buy ${asset?.symbol ?? ""} upside`} subtitle="Get leveraged upside without liquidation">
      {auctions.length === 0 ? (
        <p className="text-muted text-sm leading-6">
          No open auctions for this market. Sellers start one from Earn; the moment one opens it appears
          here with its minimum and countdown.
        </p>
      ) : (
        <>
          <label className="block">
            <span className="text-dim text-[0.8125rem] tracking-[0.08em] uppercase">Auction</span>
            <select
              value={selected ?? ""}
              onChange={(e) => setSelected(e.target.value)}
              className="border-line bg-panel focus:border-accent mt-1.5 w-full rounded-sm border px-3 py-2 text-[0.9rem] outline-none transition-colors"
            >
              {auctions.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.state} · {a.path} · {a.bids.length} bids
                </option>
              ))}
            </select>
          </label>

          {auction && <AuctionFacts auction={auction} />}

          <div className="mt-4 grid gap-3 sm:grid-cols-2">
            <AmountInput label="Quantity (upside claims)" value={amount} onChange={setAmount} placeholder="0.0" />
            <AmountInput label={`Your premium bid (${quote.symbol})`} value={premium} onChange={setPremium} placeholder="0.00" />
          </div>
          <div className="mt-4 flex flex-wrap gap-2">
            <Button
              disabled={!isConnected || !auction || rawAmount === 0n || rawPremium === 0n}
              disabledReason={!isConnected ? "Connect a wallet to bid." : "Set a quantity and a premium."}
              onClick={async () => {
                if (auction) await submitBid(auction, rawAmount, rawPremium);
              }}
            >
              PLACE BID
            </Button>
            {wire && (
              <Button
                disabled={!isConnected || !iWon}
                disabledReason={iWon ? undefined : "Only the exclusive winner can settle during the window."}
                onClick={async () => {
                  const h = await settle(wire, BigInt(winner!.amount), BigInt(winner!.premium));
                  if (h) setTx(h);
                }}
              >
                Settle & receive upside
              </Button>
            )}
          </div>
          {wire && capUsd > 0 && (
            <div className="mt-4">
              <PayoffPreview cap={capUsd} quantity={qty} symbol={asset?.symbol ?? "COIN"} spot={null} />
            </div>
          )}
          <p className="text-dim mt-2 text-[0.78rem] leading-5">
            The upside claim can expire worthless. Maximum loss is the premium you pay.
            {tx && (
              <>
                {" "}Settled:{" "}
                <a href={txExplorer(tx)} target="_blank" rel="noreferrer" className="underline underline-offset-4">
                  {tx.slice(0, 10)}…{tx.slice(-8)}
                </a>
              </>
            )}
          </p>
        </>
      )}
      <TxStatus state={state} />
    </Panel>
  );
}

function AuctionFacts({ auction }: { auction: AuctionView }) {
  const { auction: live } = useAuction(auction.id);
  const a = live ?? auction;
  const quote = DEPLOYMENT.quote!;
  const best = a.bids.length
    ? [...a.bids].sort((x, y) => (BigInt(y.premium) > BigInt(x.premium) ? 1 : -1))[0]
    : null;
  return (
    <div className="border-line bg-panel-2 mt-4 rounded-sm border p-4">
      <div className="flex items-center justify-between gap-3">
        <AuctionStatusBadge status={a.winner ? "Winner" : "LIVE"} />
        <span className="text-muted text-[0.8125rem]">{a.bids.length} {a.bids.length === 1 ? "bid" : "bids"}</span>
      </div>
      {best && (
        <div className="mt-2 font-mono text-lg tabular-nums">
          {fromRaw(BigInt(best.premium), quote.decimals, 2)} {quote.symbol}
          <span className="text-dim ml-2 text-[0.75rem]">best premium</span>
        </div>
      )}
      {a.winner && (
        <p className="text-dim mt-1 font-mono text-[0.78rem]">
          Winner {a.winner.bidder.slice(0, 6)}…{a.winner.bidder.slice(-4)} · exclusive settlement window
        </p>
      )}
    </div>
  );
}
