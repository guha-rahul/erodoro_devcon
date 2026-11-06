"use client";

import { useState } from "react";
import { useAccount } from "wagmi";
import { useIntent, useAuction, intentHashOf, intentAvailable, type SellIntentWire } from "@/lib/use-intent";
import { useSeriesBalances } from "@/lib/use-balances";
import { DEPLOYMENT, txExplorer } from "@/lib/deployment";
import { fromRaw, toRaw, timeUntil } from "@/lib/format";
import { type Series } from "@/lib/types";
import { AmountInput, Button, Panel, TxStatus } from "./ui";

/**
 * List upside for open auction: sign an intent (no gas), then watch the
 * fast/discovery competition. Works with no market maker — any buyer can bid
 * and settle on-chain at or above the signed floor.
 */
export function IntentPanel({ series, onDone }: { series: Series; onDone: () => void }) {
  const { isConnected } = useAccount();
  const { state, signAndList, cancel } = useIntent();
  const bal = useSeriesBalances(series.id, series.config.collateral);
  const [amount, setAmount] = useState("");
  const [floor, setFloor] = useState("");
  const [hours, setHours] = useState("24");
  const [allowPartial, setAllowPartial] = useState(false);
  const [allowRollover, setAllowRollover] = useState(false);
  const [hash, setHash] = useState<`0x${string}` | null>(null);
  const [wire, setWire] = useState<SellIntentWire | null>(null);
  const { auction } = useAuction(hash);

  const quote = DEPLOYMENT.quote;
  const dp = series.config.collateralDecimals;
  const raw = amount ? toRaw(amount, dp) : 0n;
  const floorRaw = floor && quote ? toRaw(floor, quote.decimals) : 0n;
  const canList = isConnected && raw > 0n && raw <= bal.n && floorRaw > 0n && Boolean(quote) && intentAvailable();

  if (!intentAvailable() || !quote) {
    return (
      <Panel title="Open auction">
        <p className="text-muted text-sm">Not available on this network yet.</p>
      </Panel>
    );
  }

  const best = auction?.bids?.length
    ? [...auction.bids].sort((a, b) => (BigInt(b.premium) > BigInt(a.premium) ? 1 : -1))[0]
    : null;

  return (
    <Panel title="3. Open auction" subtitle={`You hold ${fromRaw(bal.n, dp, 4)} upside claims to list`}>
      {!hash ? (
        <>
          <AmountInput label="Amount" value={amount} onChange={setAmount} placeholder="0.0" note={`max ${fromRaw(bal.n, dp, 4)}`} onMax={() => setAmount(fromRaw(bal.n, dp, 8))} />
          <div className="mt-3 grid gap-3 sm:grid-cols-2">
            <AmountInput label={`Minimum premium (${quote.symbol})`} value={floor} onChange={setFloor} placeholder="0.00" />
            <AmountInput label="Valid for (hours)" value={hours} onChange={setHours} placeholder="24" />
          </div>
          <label className="text-muted mt-3 flex items-center gap-2 text-sm">
            <input type="checkbox" checked={allowPartial} onChange={(e) => setAllowPartial(e.target.checked)} />
            Allow partial fills (otherwise fill-or-kill)
          </label>
          <label className="text-muted mt-2 flex items-center gap-2 text-sm">
            <input type="checkbox" checked={allowRollover} onChange={(e) => setAllowRollover(e.target.checked)} />
            Roll into the next batch if this one expires unfilled
          </label>
          <div className="mt-4">
            <Button
              busy={state.kind === "sending"}
              disabled={!canList}
              disabledReason={!isConnected ? "Connect a wallet to list." : "Set an amount within your balance and a floor above zero."}
              onClick={async () => {
                const listed = await signAndList({
                  series,
                  amount: raw,
                  floor: floorRaw,
                  validHours: Math.max(1, Number(hours) || 24),
                  allowPartial,
                  allowRollover,
                });
                if (listed) {
                  setHash(listed.hash);
                  setWire(listed.wire);
                  onDone();
                }
              }}
            >
              Sign & list (no gas)
            </Button>
          </div>
          <p className="text-dim mt-2 text-[0.78rem]">
            Signing lists your upside. Funds stay in your wallet until a buyer settles on-chain at or above your floor.
          </p>
        </>
      ) : (
        <AuctionStatus
          auctionId={hash}
          best={best}
          onCancel={
            wire
              ? async () => {
                  const tx = await cancel(wire);
                  if (tx) {
                    setHash(null);
                    setWire(null);
                  }
                }
              : undefined
          }
        />
      )}
      <TxStatus state={state} />
    </Panel>
  );
}

export function AuctionStatus({
  auctionId,
  best,
  onCancel,
}: {
  auctionId: `0x${string}`;
  best: { premium: string; bidder: string } | null;
  onCancel?: () => void;
}) {
  const { auction } = useAuction(auctionId);
  const quote = DEPLOYMENT.quote!;
  const endsAt = auction?.path === "discovery" ? auction?.discoveryEndsAt : auction?.fastEndsAt;
  return (
    <div>
      <dl className="grid gap-2 text-[0.85rem]">
        <Row label="Status" value={auction?.state ?? "Searching"} />
        <Row label="Path" value={auction?.path === "discovery" ? "Discovery auction" : "Fast auction"} />
        {endsAt ? <Row label="Closes" value={timeUntil(BigInt(endsAt))} /> : null}
        {best ? <Row label="Best bid" value={`${fromRaw(BigInt(best.premium), quote.decimals, 2)} ${quote.symbol}`} tone="positive" /> : <Row label="Best bid" value="No bids yet" />}
        {auction?.winner ? <Row label="Winner" value={`${auction.winner.bidder.slice(0, 6)}…${auction.winner.bidder.slice(-4)} (exclusive)`} /> : null}
        {auction?.settlementTx ? (
          <Row
            label="Settlement"
            value={auction.settlementTx}
            href={txExplorer(auction.settlementTx)}
          />
        ) : null}
      </dl>
      <p className="text-dim mt-3 text-[0.78rem] leading-5">
        Order states: Signed → Searching → Fast auction → Discovery auction → Bid received → Filled →
        Settlement pending → Settled. Cancelled / Expired / Failed are terminal.
      </p>
      {onCancel && auction && !["Settled", "Filled", "Cancelled", "Expired"].includes(auction.state) && (
        <div className="mt-4">
          <Button full={false} onClick={onCancel}>
            Cancel listing
          </Button>
          <p className="text-dim mt-2 text-[0.78rem]">
            Cancellation sends an on-chain transaction — only that guarantees no further fill.
          </p>
        </div>
      )}
    </div>
  );
}

function Row({ label, value, tone, href }: { label: string; value: string; tone?: "positive"; href?: string }) {
  return (
    <div className="border-line-soft flex items-start justify-between gap-4 border-t pt-2 first:border-0 first:pt-0">
      <dt className="text-dim shrink-0">{label}</dt>
      <dd className={`text-right font-mono tabular-nums ${tone === "positive" ? "text-p" : ""}`}>
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

// Re-exported so the series page can show live status right after listing.
export { intentHashOf };
export type { SellIntentWire };
