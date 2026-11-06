"use client";

import { useState } from "react";
import { useAccount } from "wagmi";
import { fromRaw } from "@/lib/format";
import { MEGAPOT_CHAIN_ID, ticketsForBudget, USDC_DECIMALS } from "@/lib/megapot";
import { useMegapotDrawing, useMegapotTickets } from "@/lib/use-megapot";
import { Button, TxStatus } from "../ui";

/**
 * "You sold the upside. Take the premium to the jackpot."
 *
 * The budget is the premium the seller actually earned, read on-chain by the
 * caller — never a number typed here. The seller picks how many of the tickets
 * that premium covers; the app reads Megapot's live ticket price to say how
 * many that is, so the two can never drift apart.
 *
 * Mainnet-only: Megapot's live protocol and Erodoro's real USDC premium both
 * live on Base mainnet. On any other network the panel explains that instead of
 * offering a button that would revert.
 */
export function InvestPremiumPanel({
  premium,
  symbol,
  compact = false,
}: {
  premium: bigint;
  symbol: string;
  compact?: boolean;
}) {
  const { isConnected, chainId } = useAccount();
  const drawing = useMegapotDrawing();
  const { state, reset, buy } = useMegapotTickets();
  const [open, setOpen] = useState(!compact);
  const [chosen, setChosen] = useState<bigint | null>(null);

  const onMainnet = chainId === MEGAPOT_CHAIN_ID;
  const maxTickets = drawing ? ticketsForBudget(premium, drawing.ticketPrice) : 0n;
  const count = chosen !== null && chosen <= maxTickets ? chosen : maxTickets;
  const cost = drawing ? count * drawing.ticketPrice : 0n;
  const premiumText = `${fromRaw(premium, USDC_DECIMALS, 2)} ${symbol}`;

  if (compact && !open) {
    return (
      <Button
        size="sm"
        onClick={() => {
          reset();
          setOpen(true);
        }}
      >
        Play Megapot
      </Button>
    );
  }

  return (
    <div className="border-line bg-panel-2 rounded-sm border p-4">
      <div className="flex items-start justify-between gap-3">
        <h3 className="text-base font-medium">Put your premium to work</h3>
        {compact && (
          <button type="button" onClick={() => setOpen(false)} className="text-dim hover:text-text text-xs">
            Close
          </button>
        )}
      </div>
      <p className="text-muted mt-1 text-sm leading-6">
        Turn the {premiumText} you earned selling upside into Megapot jackpot tickets on Base. You
        keep the capped position either way — this only spends the premium.
      </p>

      {!drawing ? (
        <p className="text-dim mt-3 text-sm">Reading the current Megapot drawing…</p>
      ) : maxTickets === 0n ? (
        <p className="text-dim mt-3 text-sm">
          Your premium is below one ticket ({fromRaw(drawing.ticketPrice, USDC_DECIMALS, 2)} USDC).
          Nothing to buy yet.
        </p>
      ) : (
        <>
          <dl className="mt-3 grid gap-1.5 text-[0.875rem]">
            <Row label="Ticket price" value={`${fromRaw(drawing.ticketPrice, USDC_DECIMALS, 2)} USDC`} />
            <Row label="Current prize pool" value={`${fromRaw(drawing.prizePool, USDC_DECIMALS, 0)} USDC`} />
          </dl>

          <div className="mt-3">
            <span className="text-dim text-[0.72rem] tracking-[0.08em] uppercase">
              Tickets ({String(maxTickets)} max)
            </span>
            <div className="mt-1.5 flex flex-wrap gap-1" role="group" aria-label="Number of tickets">
              {Array.from({ length: Number(maxTickets) }, (_, i) => BigInt(i + 1)).map((n) => (
                <button
                  key={String(n)}
                  type="button"
                  aria-pressed={count === n}
                  onClick={() => {
                    reset();
                    setChosen(n);
                  }}
                  className={`min-w-8 rounded-sm border px-2 py-1 font-mono text-[0.82rem] tabular-nums transition-colors ${
                    count === n ? "border-accent text-text" : "border-line text-muted hover:text-text"
                  }`}
                >
                  {String(n)}
                </button>
              ))}
            </div>
          </div>

          <p className="text-dim mt-2 text-[0.78rem] tabular-nums">
            Spends {fromRaw(cost, USDC_DECIMALS, 2)} USDC · {String(count)} random ticket
            {count === 1n ? "" : "s"}
          </p>

          <div className="mt-3">
            {onMainnet ? (
              <Button
                full
                busy={state.kind === "sending"}
                disabled={!isConnected || count === 0n}
                disabledReason={!isConnected ? "Connect a wallet to buy tickets." : undefined}
                onClick={() => buy(count, cost)}
              >
                Buy {String(count)} ticket{count === 1n ? "" : "s"}
              </Button>
            ) : (
              <p className="text-n text-[0.82rem] leading-6">
                Megapot runs on Base mainnet. Switch your wallet to Base mainnet to buy tickets with
                real USDC.
              </p>
            )}
          </div>
          <TxStatus state={state} />
          {state.kind === "ok" && (
            <p className="text-dim mt-2 text-[0.78rem]">
              Tickets are NFTs in your wallet — see them on megapot.io.
            </p>
          )}
        </>
      )}
    </div>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="border-line-soft flex items-baseline justify-between gap-4 border-t pt-1.5 first:border-0 first:pt-0">
      <dt className="text-dim">{label}</dt>
      <dd className="font-mono tabular-nums">{value}</dd>
    </div>
  );
}
