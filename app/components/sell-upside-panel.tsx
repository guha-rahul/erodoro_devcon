"use client";

import { useState } from "react";
import { useAccount } from "wagmi";
import { useRfq, type SignedQuote } from "@/lib/use-rfq";
import { useSeriesBalances } from "@/lib/use-balances";
import { DEPLOYMENT } from "@/lib/deployment";
import { formatDate, fromRaw, shortAddress, timeUntil, toRaw } from "@/lib/format";
import { assetFor } from "@/lib/issuers";
import { effectiveStrikeUsd, useCollateralMultipliers } from "@/lib/use-market-rows";
import { useNow } from "@/lib/use-now";
import { quoteMatches } from "@/lib/quote-matches";
import { nId, type Series } from "@/lib/types";
import { AmountInput, Button, Panel, TxStatus } from "./ui";

/**
 * Sell the upside: ask for prices, take the best one.
 *
 * The screen leads with what the seller receives, not with the instrument they
 * are giving up. `N`, claim ids and signatures are all mechanism — the number
 * that decides anything is the premium.
 */
export function SellUpsidePanel({ series, onDone }: { series: Series; onDone: () => void }) {
  const { address, isConnected } = useAccount();
  const { quotes: receivedQuotes, requesting, note, state, request, sell } = useRfq();
  const bal = useSeriesBalances(series.id, series.config.collateral);
  const [amount, setAmount] = useState("");
  const now = useNow();
  const multipliers = useCollateralMultipliers([series]);
  const sellPrice = effectiveStrikeUsd(series, multipliers.multiplierFor(series));

  const quote = DEPLOYMENT.quote;
  const asset = assetFor(series.config.collateral);
  const dp = series.config.collateralDecimals;
  const raw = amount ? toRaw(amount, dp) : 0n;
  const canAsk = isConnected && raw > 0n && raw <= bal.n && Boolean(quote);
  const quotes = receivedQuotes?.filter(({ quote: bid }) =>
    isConnected && address && quote && DEPLOYMENT.contracts.vault && raw <= bal.n &&
    quoteMatches(bid, { claims: DEPLOYMENT.contracts.vault, claimId: nId(series.id),
      claimAmount: raw, quoteToken: quote.token, taker: address }, now, series.config.maturity),
  );
  const best = quotes?.[0] ?? null;

  if (!quote || !DEPLOYMENT.contracts.rfq) {
    return (
      <Panel title="Sell upside">
        <p className="text-muted text-sm">Not available on this network yet.</p>
      </Panel>
    );
  }

  return (
    <Panel title="2. Sell upside" subtitle={`You hold ${fromRaw(bal.n, dp, 4)} upside claims to sell`}>
      <AmountInput
        label="Amount"
        value={amount}
        onChange={setAmount}
        placeholder="0.0"
        note={`max ${fromRaw(bal.n, dp, 4)}`}
        onMax={() => setAmount(fromRaw(bal.n, dp, 8))}
      />

      <div className="mt-4">
        <Button
          busy={requesting}
          disabled={!canAsk}
          onClick={() =>
            request({
              claims: DEPLOYMENT.contracts.vault!,
              claimId: nId(series.id),
              claimAmount: raw,
              quoteToken: quote.token,
              taker: address!,
            })
          }
        >
          {requesting ? "Asking market makers…" : "Get quotes"}
        </Button>
      </div>

      {note && <p className="text-muted mt-4 text-[0.875rem] leading-6">{note}</p>}
      {receivedQuotes && receivedQuotes.length > 0 && !best && (
        <p role="status" className="text-muted mt-4 text-sm">
          No current quote matches this wallet, amount, and market. Request a new quote before selling.
        </p>
      )}

      {quotes && quotes.length > 0 && (
        <>
          <div className="border-line-soft mt-5 border-t pt-4">
            <div className="text-dim text-[0.8125rem] tracking-[0.1em] uppercase">You receive</div>
            <div className="font-display mt-1 text-3xl tracking-[-0.04em]">
              {fromRaw(BigInt(best!.quote.quoteAmount), quote.decimals, 2)} {quote.symbol}
            </div>
            <p className="text-dim mt-1 text-[0.8125rem]">
              Best of {quotes.length} {quotes.length === 1 ? "quote" : "quotes"}. Firm until it
              expires; nobody else is obliged to match it.
            </p>
          </div>

          <ul className="mt-4 divide-y divide-[var(--color-line-soft)]">
            {quotes.map((q) => (
              <QuoteRow
                key={`${q.quote.maker}:${q.quote.nonce}`}
                signed={q}
                decimals={quote.decimals}
                symbol={quote.symbol}
                isBest={q === best}
              />
            ))}
          </ul>

          <div className="border-line bg-panel-2 mt-5 rounded-sm border p-4">
            <p className="text-[0.75rem] tracking-[0.1em] uppercase">Review your sale</p>
            <dl className="mt-3 grid gap-2 text-[0.85rem]">
              <ReviewRow
                label="You sell"
                value={`${fromRaw(BigInt(best!.quote.claimAmount), dp, 4)} ${asset?.symbol ?? "stock"} upside claims`}
              />
              <ReviewRow label="Adjusted sell price" value={sellPrice === null ? "Unavailable" : `$${sellPrice.toFixed(2)}`} />
              <ReviewRow
                label="You receive now"
                value={`${fromRaw(BigInt(best!.quote.quoteAmount), quote.decimals, 2)} ${quote.symbol}`}
                tone="positive"
              />
              <ReviewRow label="You retain" value={`${fromRaw(bal.p, dp, 4)} capped stock claim in this wallet`} />
              <ReviewRow label="Expiry" value={formatDate(series.config.maturity)} />
              <ReviewRow label="Quote expires" value={timeUntil(BigInt(best!.quote.expiry))} />
              <ReviewRow label="Settlement source" value={`Series oracle ${shortAddress(series.config.oracle, 4)}`} />
              <ReviewRow label="RFQ protocol fee" value="None; Base network fee applies" />
            </dl>
          </div>

          <div className="mt-5">
            <Button
              full
              busy={state.kind === "sending"}
              disabled={sellPrice === null}
              disabledReason={sellPrice === null ? "The adjusted sell price must be available before review." : undefined}
              onClick={async () => {
                const hash = await sell(best!);
                if (hash) {
                  await bal.refetch();
                  onDone();
                }
              }}
            >
              Sell upside
            </Button>
          </div>
          <p className="text-dim mt-2 text-[0.78rem]">
            One transaction: the upside claim goes to the market maker and the payment comes to
            you, or neither moves. You keep the capped claim either way.
          </p>
        </>
      )}

      <TxStatus state={state} />
    </Panel>
  );
}

function ReviewRow({ label, value, tone }: { label: string; value: string; tone?: "positive" }) {
  return (
    <div className="border-line-soft flex items-start justify-between gap-4 border-t pt-2 first:border-0 first:pt-0">
      <dt className="text-dim shrink-0">{label}</dt>
      <dd className={`text-right ${tone === "positive" ? "text-p" : ""}`}>{value}</dd>
    </div>
  );
}

function QuoteRow({
  signed,
  decimals,
  symbol,
  isBest,
}: {
  signed: SignedQuote;
  decimals: number;
  symbol: string;
  isBest: boolean;
}) {
  return (
    <li className="flex items-center justify-between gap-4 py-2.5 text-[0.875rem]">
      <span className="text-muted font-mono">
        {signed.makerName ?? `${signed.quote.maker.slice(0, 6)}…${signed.quote.maker.slice(-4)}`}
      </span>
      <span className={`font-mono tabular-nums ${isBest ? "text-p font-medium" : "text-muted"}`}>
        {fromRaw(BigInt(signed.quote.quoteAmount), decimals, 2)} {symbol}
        {isBest && <span className="ml-2 text-[0.72rem] tracking-[0.08em] uppercase">best</span>}
      </span>
    </li>
  );
}
