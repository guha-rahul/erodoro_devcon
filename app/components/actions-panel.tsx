"use client";

import { useState } from "react";
import { useAccount } from "wagmi";
import { useActions } from "@/lib/use-actions";
import { useRfq } from "@/lib/use-rfq";
import { quoteMatches } from "@/lib/quote-matches";
import { useSeriesBalances } from "@/lib/use-balances";
import { useNow } from "@/lib/use-now";
import { useB20, toShareEquivalent } from "@/lib/use-b20";
import { DEPLOYMENT } from "@/lib/deployment";
import { assetFor } from "@/lib/issuers";
import { fromRaw, toRaw } from "@/lib/format";
import { nId, statusOf, type Series } from "@/lib/types";
import { AmountInput, Button, Panel, TxStatus } from "./ui";

/**
 * Everything a holder can actually do with a series.
 *
 * Which actions exist depends on where the series is in its life, so the panel
 * shows one of three states rather than a grid of buttons that mostly revert.
 */
export function ActionsPanel({ series, onDone }: { series: Series; onDone: () => void }) {
  const { address, isConnected } = useAccount();
  const { state, approveAndSplit, merge, settle, redeem } = useActions();
  const preview = useRfq();
  const bal = useSeriesBalances(series.id, series.config.collateral);
  const dp = series.config.collateralDecimals;
  const symbol = assetFor(series.config.collateral)?.symbol ?? "tokens";
  const [amount, setAmount] = useState("");
  const now = useNow();
  const b20 = useB20(
    series.config.collateral,
    address,
    (DEPLOYMENT.contracts.vault as `0x${string}`) ?? undefined,
  );

  const settled = series.settlement?.settled ?? false;
  const matured = now > 0n && now >= series.config.maturity;
  const settleAt = series.config.maturity + series.config.settlementDelay;
  const settleable = !settled && now > 0n && now >= settleAt;

  const after = () => {
    bal.refetch();
    onDone();
  };

  if (!isConnected) {
    return (
      <Panel title="Actions">
        <p className="text-muted text-sm">Connect a wallet to lock collateral or redeem a claim.</p>
      </Panel>
    );
  }

  if (settled) {
    const st = series.settlement!;
    const quoteP = st.pSupplyAtSettlement === 0n ? 0n : (bal.p * st.pPool) / st.pSupplyAtSettlement;
    const quoteN = st.nSupplyAtSettlement === 0n ? 0n : (bal.n * st.nPool) / st.nSupplyAtSettlement;
    return (
      <Panel title="Redeem" subtitle="Settled — each claim redeems from its own pool">
        <Row label="Your P" value={`${fromRaw(bal.p, dp, 4)} → ${fromRaw(quoteP, dp, 4)}`} />
        <Row label="Your N" value={`${fromRaw(bal.n, dp, 4)} → ${fromRaw(quoteN, dp, 4)}`} />
        {st.shortfallObserved && (
          <p className="border-n/30 bg-n/8 text-n mt-3 rounded-sm border px-3 py-2 text-[0.82rem]">
            The vault holds less than it owes. Payouts are haircut proportionally, so what you
            receive will be below the amounts above.
          </p>
        )}
        <div className="mt-4 flex flex-wrap gap-2">
          <Button
            disabled={bal.p === 0n}
            onClick={async () => {
              await redeem(series.id, true, bal.p);
              after();
            }}
          >
            Redeem P
          </Button>
          <Button
            disabled={bal.n === 0n}
            onClick={async () => {
              await redeem(series.id, false, bal.n);
              after();
            }}
          >
            Redeem N
          </Button>
        </div>
        <TxStatus state={state} />
      </Panel>
    );
  }

  if (matured) {
    return (
      <Panel title="Settle" subtitle="Trading has stopped">
        <p className="text-muted text-sm">
          {settleable
            ? "Anyone can settle. The caller supplies a signed oracle print from inside this series' publish window and pays the oracle fee; nobody can choose the price."
            : `Settlement opens at ${new Date(Number(settleAt) * 1000).toLocaleTimeString()}.`}
        </p>
        <div className="mt-4">
          <Button
            disabled={!settleable}
            onClick={async () => {
              await settle(series.id, series.config.feedId, series.config.maturity);
              after();
            }}
          >
            Settle
          </Button>
        </div>
        <TxStatus state={state} />
      </Panel>
    );
  }

  const raw = amount ? toRaw(amount, dp) : 0n;
  const estimatedFee = raw * BigInt(series.config.feeBps) / 10_000n;
  const estimatedClaims = raw - estimatedFee;
  const previewBid = preview.quotes?.find(({ quote }) =>
    address && DEPLOYMENT.quote && DEPLOYMENT.contracts.vault && quoteMatches(quote, {
      claims: DEPLOYMENT.contracts.vault, claimId: nId(series.id), claimAmount: estimatedClaims,
      quoteToken: DEPLOYMENT.quote.token, taker: address,
    }, now, series.config.maturity),
  );
  const canSplit =
    raw > 0n && raw >= series.config.minSplitAmount && estimatedClaims > 0n && raw <= bal.collateral && !series.config.splitsPaused && b20.blockedReason === null;
  const canMerge = raw > 0n && raw <= bal.p && raw <= bal.n;

  return (
    <Panel
      tour="lock-panel"
      title="1. Deposit stock"
      subtitle={`${statusOf(series)} · you hold ${fromRaw(bal.collateral, dp, 4)} ${symbol}`}
    >
      {b20.blockedReason && (
        <p
          className="border-danger/40 bg-danger/8 text-danger mb-3 rounded-sm border px-3 py-2.5 text-[0.82rem]"
          role="alert"
        >
          {b20.blockedReason}
        </p>
      )}
      <AmountInput
        label={`Amount (${symbol} tokens)`}
        value={amount}
        onChange={setAmount}
        placeholder="0.0"
        note={`balance ${fromRaw(bal.collateral, dp, 4)} · minimum ${fromRaw(series.config.minSplitAmount, dp, dp)}`}
        onMax={() => setAmount(fromRaw(bal.collateral, dp, 8))}
      />
      <p className="text-dim mt-2 text-[0.82rem]">
        Deposit stock to create a capped stock claim and an upside claim. Then request a buyer quote in step 2.
        Depositing alone does not earn a premium. A token approval may be needed before the deposit transaction.
      </p>
      {raw > 0n && <div className="border-line mt-4 rounded-sm border p-3">
        <Row label="Deposit" value={`${fromRaw(raw, dp, dp)} ${symbol}`} />
        <Row label={`Estimated deposit fee (${series.config.feeBps} bps)`} value={`${fromRaw(estimatedFee, dp, dp)} ${symbol}`} />
        <Row label="Estimated capped stock claim" value={`${fromRaw(estimatedClaims, dp, dp)} P`} />
        <Row label="Estimated upside claim" value={`${fromRaw(estimatedClaims, dp, dp)} N`} />
        <p className="text-dim mt-2 text-xs">Estimates assume the full deposit reaches the vault. Claims use the amount received after the deposit fee. Network fees are additional.</p>
        {DEPLOYMENT.quote && DEPLOYMENT.contracts.rfq && <div className="mt-4">
          <Button tone="ghost" disabled={!canSplit} busy={preview.requesting} onClick={() => preview.request({
            claims: DEPLOYMENT.contracts.vault!, claimId: nId(series.id), claimAmount: estimatedClaims,
            quoteToken: DEPLOYMENT.quote!.token, taker: address!,
          })}>Check premium before deposit</Button>
          {previewBid ? <p className="text-p mt-2 text-sm">Current bid: {fromRaw(BigInt(previewBid.quote.quoteAmount), DEPLOYMENT.quote.decimals, 4)} {DEPLOYMENT.quote.symbol} for the estimated upside claims.</p>
            : preview.quotes !== null && !preview.requesting ? <p className="text-muted mt-2 text-sm">No current bid matches this deposit. Depositing would leave the upside unsold.</p> : null}
          {preview.note && <p className="text-muted mt-2 text-xs">{preview.note}</p>}
          <p className="text-dim mt-2 text-xs">This checks maker funding now. Deposit and sale are separate: a quote can expire or become unavailable during deposit. Request a fresh quote in step 2 before selling.</p>
        </div>}
      </div>}
      <div className="mt-4 flex flex-wrap gap-2">
        <Button
          disabled={!canSplit}
          busy={state.kind === "sending"}
          onClick={async () => {
            const hash = await approveAndSplit(series.id, series.config.collateral, raw);
            if (hash) { setAmount(""); after(); }
          }}
        >
          {series.config.splitsPaused ? "Deposits paused" : "Deposit stock"}
        </Button>
        <Button
          tone="ghost"
          disabled={!canMerge}
          busy={state.kind === "sending"}
          onClick={async () => {
            await merge(series.id, raw);
            setAmount("");
            after();
          }}
        >
          Recombine claims
        </Button>
      </div>
      <p className="text-dim mt-3 text-xs">Recombine equal amounts of both claims to withdraw before expiry. Use the same amount field; this remains available when new deposits are paused.</p>
      <Row label="Your capped stock claim" value={`${fromRaw(bal.p, dp, 4)} P`} />
      <Row label="Your upside claim" value={`${fromRaw(bal.n, dp, 4)} N`} />
      {b20.multiplier !== null && b20.multiplier !== 10n ** 18n && (
        <p className="text-dim mt-2 text-[0.78rem]">
          Your {fromRaw(bal.collateral, dp, 4)} {symbol} tokens represent {fromRaw(toShareEquivalent(bal.collateral, b20.multiplier), dp, 4)} share equivalents at the current multiplier. Enter token amounts above.
        </p>
      )}
      <TxStatus state={state} />
    </Panel>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="border-line-soft mt-2 flex items-baseline justify-between gap-4 border-t pt-2 text-[0.875rem]">
      <span className="text-dim">{label}</span>
      <span className="font-mono tabular-nums">{value}</span>
    </div>
  );
}
