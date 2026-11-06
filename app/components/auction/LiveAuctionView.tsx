"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { useAccount } from "wagmi";
import { useAuction, useBidder, useIntent, type SellIntentWire } from "@/lib/use-intent";
import { DEPLOYMENT, txExplorer } from "@/lib/deployment";
import { assetFor } from "@/lib/issuers";
import { formatDate, fromRaw, toRaw } from "@/lib/format";
import type { Series } from "@/lib/types";
import { useNow } from "@/lib/use-now";
import { AmountInput, Button, TxStatus } from "../ui";
import { InvestPremiumPanel } from "../megapot/InvestPremiumPanel";
import { AuctionStatusBadge, auctionDisplayState } from "./AuctionStatusBadge";
import { AuctionCountdown } from "./AuctionCountdown";
import { AuctionTimeline } from "./AuctionTimeline";
import { BestPremiumCard } from "./BestPremiumCard";
import { BidList } from "./BidList";
import { PayoffPreview } from "./Summary";

/**
 * Screens 2+3 — the live auction room and its result.
 *
 * Paradigm-style: hero best premium, countdown, compact bid list, timeline.
 * Both roles share the room: the seller sees Cancel, the buyer sees the bid
 * form and, when winning, Settle. Terminal states render the CoW-style
 * completion view (or the no-bid recovery view) instead of the room.
 */
export function LiveAuctionView({ series, auctionHash }: { series: Series; auctionHash: `0x${string}` }) {
  const { address } = useAccount();
  const { auction, intent } = useAuction(auctionHash);
  const roomRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!auction || !intent || window.location.hash !== "#live-auction") return;
    requestAnimationFrame(() => roomRef.current?.scrollIntoView({ block: "start" }));
  }, [auction, intent]);

  if (!auction || !intent) {
    return <p className="text-muted py-6 text-sm">Loading auction…</p>;
  }

  const terminal = ["Filled", "Settled", "Cancelled", "Expired", "Failed"].includes(auction.state);
  if (terminal) {
    return <AuctionResult series={series} intent={intent} auctionId={auctionHash} />;
  }

  const asset = assetFor(series.config.collateral);
  const quote = DEPLOYMENT.quote!;
  const isSeller = address && intent.seller.toLowerCase() === address.toLowerCase();
  const capUsd = Number(intent.strike) / 10 ** series.config.priceDecimals;
  const bids = auction.bids ?? [];
  const best = bids.length
    ? [...bids].sort((a, b) => {
        const left = BigInt(b.premium) * BigInt(a.amount);
        const right = BigInt(a.premium) * BigInt(b.amount);
        return left === right ? 0 : left > right ? 1 : -1;
      })[0]
    : null;
  const claimUnit = 10n ** BigInt(series.config.collateralDecimals);
  const floorPerShare = (BigInt(intent.minPremium) * claimUnit + BigInt(intent.claimAmount) - 1n)
    / BigInt(intent.claimAmount);
  const bestPerShare = best
    ? (BigInt(best.premium) * claimUnit + BigInt(best.amount) - 1n) / BigInt(best.amount)
    : null;
  const endsAt = auction.path === "discovery" ? auction.discoveryEndsAt : auction.fastEndsAt;

  return (
    <div ref={roomRef} id="live-auction" className="scroll-mt-48 grid gap-6 lg:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]">
      <div className="border-line bg-panel rounded-md border p-4 sm:p-6">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h2 className="text-xl font-medium">
            {asset?.symbol ?? "Stock"} Upside Auction
          </h2>
          <AuctionStatusBadge status={auction.winner ? "Winner" : "LIVE"} />
        </div>
        <dl className="border-line-soft mt-5 grid gap-4 border-b pb-5 text-sm sm:grid-cols-3">
          <div><dt className="text-dim">Upside claims</dt><dd className="mt-1 font-mono">{fromRaw(BigInt(intent.claimAmount) - BigInt(auction.filledAmount ?? "0"), series.config.collateralDecimals, series.config.collateralDecimals)} {asset?.symbol}</dd></div>
          <div><dt className="text-dim">Upside above</dt><dd className="mt-1 font-mono">${capUsd.toFixed(2)}</dd></div>
          <div><dt className="text-dim">Expires</dt><dd className="mt-1">{formatDate(series.config.maturity)}</dd></div>
        </dl>

        <div className="mt-6">
          <BestPremiumCard
            best={bestPerShare}
            floor={floorPerShare}
            bidders={new Set(bids.map((b) => b.bidder.toLowerCase())).size}
            decimals={quote.decimals}
          />
        </div>

        <div className="mt-6 flex flex-wrap items-end justify-between gap-4">
          <AuctionCountdown endsAt={endsAt} />
          {auction.round && auction.round > 1 && <p className="text-dim text-sm">Round {auction.round} · restarted automatically</p>}
        </div>

        {isSeller && <div className="mt-6">
          <AuctionTimeline state={auction.state} />
        </div>}

        <div className="mt-6">
          <h3 className="text-dim text-[0.75rem] tracking-[0.1em] uppercase">Current bids</h3>
          <div className="mt-2">
            <BidList bids={bids} decimals={quote.decimals} claimDecimals={series.config.collateralDecimals} />
          </div>
        </div>
      </div>

      <aside className="grid content-start gap-4">
        {isSeller ? <SellerCard intent={intent} /> : <BuyerCard key={`${auctionHash}:${address}`} series={series} auctionId={auctionHash} capUsd={capUsd} />}
      </aside>
    </div>
  );
}

function SellerCard({ intent }: { intent: SellIntentWire }) {
  const { state, cancel } = useIntent();
  const [done, setDone] = useState(false);
  if (done) {
    return (
      <div className="border-line bg-panel rounded-md border p-4">
        <p className="text-sm">Auction cancelled. Your upside claims never moved.</p>
        <Link href="/earn" className="text-accent-ink mt-2 inline-block text-sm underline underline-offset-4">
          Run auction again
        </Link>
      </div>
    );
  }
  return (
    <div className="border-line bg-panel rounded-md border p-4">
      <h3 className="text-base font-medium">Your auction</h3>
      <p className="text-muted mt-1 text-sm leading-6">
        Bidders compete above your minimum. Nothing moves until a winner settles on-chain.
      </p>
      <div className="mt-3">
        <Button
          busy={state.kind === "sending"}
          onClick={async () => {
            const tx = await cancel(intent);
            if (tx) setDone(true);
          }}
        >
          Cancel auction
        </Button>
      </div>
      <p className="text-dim mt-2 text-[0.78rem]">Cancellation is an on-chain transaction — the only kind that guarantees no further fill.</p>
      <TxStatus state={state} />
    </div>
  );
}

function BuyerCard({ series, auctionId, capUsd }: { series: Series; auctionId: `0x${string}`; capUsd: number }) {
  const { address, isConnected } = useAccount();
  const { auction, intent } = useAuction(auctionId);
  const { state, purchaseStep, submitBid, settle } = useBidder();
  const [premium, setPremium] = useState("");
  const [amount, setAmount] = useState("");
  const [action, setAction] = useState<"settle" | "bid" | null>(null);
  const [bidSent, setBidSent] = useState(false);
  const [purchase, setPurchase] = useState<{ amount: bigint; premium: bigint } | null>(null);
  const now = useNow();
  const quote = DEPLOYMENT.quote!;
  const dp = series.config.collateralDecimals;
  const asset = assetFor(series.config.collateral);

  if (!auction || !intent) return null;
  const winner = auction.winner;
  const iWon = winner && address && winner.bidder.toLowerCase() === address.toLowerCase();
  const remaining = BigInt(intent.claimAmount) - BigInt(auction.filledAmount ?? "0");
  const qtyRaw = intent.allowPartial ? parseAmount(amount, dp) : remaining;
  const premiumPerShareRaw = parseAmount(premium, quote.decimals);
  const unit = 10n ** BigInt(dp);
  const minimumPerShare = (BigInt(intent.minPremium) * unit + BigInt(intent.claimAmount) - 1n)
    / BigInt(intent.claimAmount);
  const premRaw = premiumPerShareRaw > 0n && qtyRaw > 0n
    ? (premiumPerShareRaw * qtyRaw + unit - 1n) / unit
    : 0n;
  const qty = Number(winner?.amount ?? remaining) / 10 ** dp;
  const spot = null; // spot line lives in PayoffPreview via cap context; chain spot shown on market header.
  const busy = state.kind === "sending";
  const endsAt = auction.path === "discovery" ? auction.discoveryEndsAt : auction.fastEndsAt;
  const ended = now > 0n && now >= BigInt(endsAt);
  const unavailable = now === 0n || now < BigInt(intent.validFrom) || now >= BigInt(intent.validUntil) || now >= BigInt(intent.maturity);
  const minimum = qtyRaw > 0n ? (BigInt(intent.minPremium) * qtyRaw + BigInt(intent.claimAmount) - 1n) / BigInt(intent.claimAmount) : 0n;
  const bidError = !isConnected ? "Connect a wallet to bid."
    : ended || unavailable ? "Bidding has closed."
    : qtyRaw <= 0n ? "Enter a valid quantity."
    : premiumPerShareRaw <= 0n ? "Enter your maximum premium."
    : qtyRaw > remaining ? "Quantity exceeds the available upside."
    : !intent.allowPartial && qtyRaw !== remaining ? "This auction sells the full quantity together."
    : premRaw < minimum ? "Your bid must meet the seller’s minimum." : null;
  async function completePurchase(quantity: bigint, total: bigint) {
    setAction("settle");
    setPurchase({ amount: quantity, premium: total });
    await settle(intent!, quantity, total);
  }

  if (action === "settle" && state.kind === "ok" && purchase) {
    return (
      <div className="border-line bg-panel rounded-md border p-4 sm:p-6" role="status">
        <p className="text-accent-ink text-sm">✓ Purchase complete</p>
        <h3 className="mt-2 text-xl font-medium">Your upside is secured.</h3>
        <PurchaseProgress step="complete" />
        <dl className="mt-5 grid gap-3 text-sm">
          <Row label="You paid" value={`${fromRaw(purchase.premium, quote.decimals, quote.decimals)} ${quote.symbol}`} />
          <Row label="Claims received" value={`${fromRaw(purchase.amount, dp, dp)} ${asset?.symbol} upside`} />
        </dl>
        <Link href={positionHref(series)} className="bg-text text-bg mt-5 block rounded-sm px-4 py-3 text-center text-sm font-medium">View position →</Link>
        <a href={txExplorer(state.hash)} target="_blank" rel="noreferrer" className="text-muted mt-3 block text-center text-sm underline underline-offset-4">View transaction</a>
      </div>
    );
  }

  return (
    <div className="border-line bg-panel rounded-md border p-4 sm:p-6">
      <h3 className="text-base font-medium">Bid on {asset?.symbol ?? ""} upside</h3>
      {!winner && remaining > 0n && (
        <fieldset disabled={busy || ended || unavailable} className="mt-4 grid min-w-0 gap-4 disabled:opacity-60">
          <div className="border-line bg-panel-2 rounded-sm border p-4">
            <div className="flex items-end justify-between gap-3">
              <div>
                <p className="text-dim text-[0.7rem] tracking-[0.08em] uppercase">Seller minimum</p>
                <p className="mt-1 font-mono text-xl">{fromRaw(minimumPerShare, quote.decimals, quote.decimals)} {quote.symbol} / share</p>
              </div>
              <p className="text-dim text-right text-xs">{fromRaw(remaining, dp, dp)} {asset?.symbol}<br />available</p>
            </div>
          </div>
          <p className="text-muted text-sm leading-6">Enter the most you are willing to pay per share. The highest valid bid wins when the timer ends.</p>
            {intent.allowPartial && <AmountInput label={`Quantity (max ${fromRaw(remaining, dp, dp)})`} value={amount} onChange={(value) => { setAmount(value); setBidSent(false); }} placeholder="0.0" />}
            <AmountInput label={`Your maximum premium per share (${quote.symbol})`} value={premium} onChange={(value) => { setPremium(value); setBidSent(false); }} placeholder={fromRaw(minimumPerShare, quote.decimals, quote.decimals)} />
            <p className="text-dim text-[0.78rem]">
              Maximum total if you win: {fromRaw(premRaw, quote.decimals, quote.decimals)} {quote.symbol}
            </p>
            <Button
              full
              tone="primary"
              busy={busy && action === "bid"}
              disabled={busy || Boolean(bidError)}
              disabledReason={bidError ?? undefined}
              onClick={async () => { setAction("bid"); setBidSent(false); setBidSent(await submitBid(auction, qtyRaw, premRaw)); }}
            >
              Place bid
            </Button>
            {bidError && <p className="text-dim text-xs">{bidError}</p>}
            {bidSent && <p role="status" className="text-accent-ink text-sm">Bid submitted. You only pay if you win and complete settlement.</p>}
        </fieldset>
      )}
      {winner && (
        <div className="mt-3 rounded-sm border border-line bg-panel-2 p-4">
          <p className="font-medium">{iWon ? "You won this upside" : "Buyer found"}</p>
          <p className="text-muted mt-1 text-sm">
            {iWon ? "Complete payment to receive the claim." : "The winning buyer is completing settlement."}
          </p>
          {iWon && (
            <div className="mt-3">
          <Button
            full
            tone="primary"
            busy={busy}
            disabled={unavailable}
            onClick={() => completePurchase(BigInt(winner.amount), BigInt(winner.premium))}
          >
                Complete purchase — {fromRaw(BigInt(winner.premium), quote.decimals, quote.decimals)} {quote.symbol}
          </Button>
            </div>
          )}
        </div>
      )}
      {action === "settle" && <PurchaseProgress step={purchaseStep} />}
      {action === "settle" && busy && <p role="status" className="text-muted mt-3 text-sm">{purchaseStep === "approval"
        ? state.phase === "confirming" ? "Waiting for payment approval to confirm…" : "Checking payment approval. Approve in your wallet if prompted."
        : state.phase === "confirming" ? "Purchase submitted. Waiting for on-chain confirmation…" : "Confirm the purchase in your wallet when prompted."}</p>}
      {state.kind !== "sending" && <TxStatus state={state} />}
      {action === "bid" && busy && <p role="status" className="text-muted mt-3 text-sm">Sign your bid in the wallet. No payment is taken yet.</p>}
      <details className="border-line mt-4 rounded-sm border">
        <summary className="text-muted hover:text-text cursor-pointer px-4 py-3 text-sm">See payoff examples</summary>
        <div className="border-line-soft border-t p-3">
          <PayoffPreview cap={capUsd} quantity={qty} symbol={asset?.symbol ?? "COIN"} spot={spot} />
          <p className="text-dim mt-2 text-[0.78rem]">Maximum loss: the premium you pay.</p>
        </div>
      </details>
    </div>
  );
}

function parseAmount(value: string, decimals: number): bigint {
  if (!/^\d*\.?\d*$/.test(value) || !/\d/.test(value) || (value.split(".")[1]?.length ?? 0) > decimals) return 0n;
  return toRaw(value, decimals);
}

function positionHref(series: Series) {
  return `/app?market=${series.id.toString(16).padStart(64, "0")}&position=1`;
}

function PurchaseProgress({ step }: { step: "approval" | "purchase" | "complete" }) {
  const active = ["approval", "purchase", "complete"].indexOf(step);
  return (
    <ol aria-label="Purchase progress" className="border-line mt-5 grid grid-cols-3 gap-2 border-t pt-4 text-xs">
      {["Approve", "Confirm purchase", "Complete"].map((label, index) => (
        <li key={label} aria-current={index === active ? "step" : undefined} className={index <= active ? "text-accent-ink" : "text-dim"}>
          <span aria-hidden className="mb-2 block font-mono">{index < active || step === "complete" ? "✓" : `0${index + 1}`}</span>
          {label}
        </li>
      ))}
    </ol>
  );
}

/** Screen 3 — filled and ended variants. */
function AuctionResult({ series, intent, auctionId }: { series: Series; intent: SellIntentWire; auctionId: `0x${string}` }) {
  const { auction } = useAuction(auctionId);
  const { address } = useAccount();
  const quote = DEPLOYMENT.quote!;
  const asset = assetFor(series.config.collateral);
  const capUsd = Number(intent.strike) / 10 ** series.config.priceDecimals;
  const state = auction?.state ?? "Expired";
  const filled = state === "Filled" || state === "Settled";
  const premium = auction?.winningPremium ? BigInt(auction.winningPremium) : null;
  const isSeller = Boolean(address && intent.seller.toLowerCase() === address.toLowerCase());
  const isBuyer = Boolean(address && auction?.buyer?.toLowerCase() === address.toLowerCase());

  if (!filled) {
    const bids = auction?.bids?.length ?? 0;
    return (
      <div className="border-line bg-panel rounded-md border p-6 text-center sm:p-10">
        <AuctionStatusBadge status={auctionDisplayState(state)} />
        <h2 className="font-display mt-3 text-3xl">Auction {state === "Cancelled" ? "cancelled" : "ended"}</h2>
        <p className="text-muted mx-auto mt-2 max-w-[52ch] text-sm leading-6">
          {bids === 0
            ? `No bids met your ${fromRaw(BigInt(intent.minPremium), quote.decimals, 2)} ${quote.symbol} minimum. Your upside claims never moved.`
            : `The auction closed with ${bids} ${bids === 1 ? "bid" : "bids"} below an executable outcome. Nothing settled.`}
        </p>
        <div className="mt-5 flex flex-wrap justify-center gap-2">
          <Link href="/earn" className="bg-text text-bg hover:bg-accent rounded-sm px-4 py-2 text-sm font-medium transition-colors">
            Run auction again
          </Link>
          <Link href="/earn" className="border-line hover:border-text rounded-sm border px-4 py-2 text-sm transition-colors">
            Edit minimum premium
          </Link>
        </div>
      </div>
    );
  }

  return (
    <div className="border-line bg-panel rounded-md border p-6 sm:p-10">
      <div className="text-center">
        <div className="bg-accent/15 text-accent-ink mx-auto grid size-14 place-items-center rounded-full text-2xl" aria-hidden>
          ✓
        </div>
        <AuctionStatusBadge status="Filled" />
        <h2 className="font-display mt-3 text-3xl">{isSeller ? "Premium earned" : isBuyer ? "Upside secured" : "Auction complete"}</h2>
        <p className="text-muted mx-auto mt-2 max-w-md text-sm">
          {isSeller ? "The winning buyer paid the premium and received your upside." : isBuyer ? "The upside claim is now in your portfolio." : "This upside purchase has settled on-chain."}
        </p>
        <div className="text-dim mt-5 text-[0.75rem] tracking-[0.12em] uppercase">
          {isSeller ? "You received" : isBuyer ? "You paid" : "Premium paid"}
        </div>
        <div className="font-display text-5xl tabular-nums">
          {premium !== null ? fromRaw(premium, quote.decimals, quote.decimals) : "—"}{" "}
          <span className="text-2xl">{quote.symbol}</span>
        </div>
      </div>
      <dl className="mx-auto mt-8 grid max-w-xl gap-2 text-sm">
        <Row label={isSeller ? "You sold" : isBuyer ? "You bought" : "Position"} value={`${asset?.symbol} upside above $${capUsd.toFixed(2)}`} />
        <Row label={isBuyer && !intent.allowPartial ? "Claims received" : "Total filled"} value={`${fromRaw(BigInt(auction?.filledAmount ?? "0"), series.config.collateralDecimals, series.config.collateralDecimals)} ${asset?.symbol} upside`} />
        <Row label="Expiry" value={formatDate(series.config.maturity)} />
        <Row
          label={isSeller ? "You retain" : "Upside claim"}
          value={isSeller ? `${asset?.symbol} capped at $${capUsd.toFixed(2)}` : `Pays above $${capUsd.toFixed(2)}`}
        />
        {auction?.settlementTx && <Row label="Transaction" value={auction.settlementTx} href={txExplorer(auction.settlementTx)} />}
      </dl>
      <div className="mx-auto mt-5 w-fit rounded-full border border-accent/40 bg-accent/10 px-3 py-1 text-[0.72rem] font-medium tracking-[0.08em] text-accent-ink uppercase">
        Milestone · {isSeller ? "Upside sold" : isBuyer ? "Upside purchased" : "Purchase settled"}
      </div>
      <div className="mt-6 flex flex-wrap justify-center gap-2">
        {(isSeller || isBuyer) && <Link href={positionHref(series)} className="bg-text text-bg hover:bg-accent rounded-sm px-4 py-2 text-sm font-medium transition-colors">
          View position
        </Link>}
        {auction?.settlementTx && (
          <a href={txExplorer(auction.settlementTx)} target="_blank" rel="noreferrer" className="border-line hover:border-text rounded-sm border px-4 py-2 text-sm transition-colors">
            View transaction
          </a>
        )}
      </div>
      {isSeller && premium !== null && premium > 0n && (
        <div className="mx-auto mt-6 max-w-xl text-left">
          <InvestPremiumPanel premium={premium} symbol={quote.symbol} />
        </div>
      )}
    </div>
  );
}

function Row({ label, value, href }: { label: string; value: string; href?: string }) {
  return (
    <div className="border-line-soft flex items-start justify-between gap-4 border-t pt-2 first:border-0 first:pt-0">
      <dt className="text-dim shrink-0">{label}</dt>
      <dd className="text-right font-mono tabular-nums">
        {href ? (
          <a href={href} target="_blank" rel="noreferrer" className="underline underline-offset-4">
            {value.slice(0, 10)}…{value.slice(-8)}
          </a>
        ) : (
          value
        )}
      </dd>
    </div>
  );
}
