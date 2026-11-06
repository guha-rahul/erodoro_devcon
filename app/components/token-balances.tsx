"use client";

import Link from "next/link";
import { erc20Abi } from "viem";
import { useAccount, useReadContract } from "wagmi";
import { useStockBalances } from "@/lib/use-stock-balances";
import { DEPLOYMENT, IS_TESTNET } from "@/lib/deployment";
import { REQUIRED_CHAIN_ID } from "@/lib/wagmi";
import { fromRaw } from "@/lib/format";
import { toShareEquivalent } from "@/lib/use-b20";
import { Panel } from "./ui";

/**
 * What the connected wallet holds, before any of it is locked.
 *
 * Quantities are share-equivalent, not raw units: one token is not one share
 * once a corporate action has rebased it, and a raw figure would quietly
 * disagree with every broker statement the holder has.
 */
export function TokenBalances() {
  const { address, isConnected } = useAccount();
  const { rows, loading: stocksLoading } = useStockBalances();
  const quote = DEPLOYMENT.quote;
  const quoteBalance = useReadContract({
    chainId: REQUIRED_CHAIN_ID,
    address: quote?.token,
    abi: erc20Abi,
    functionName: "balanceOf",
    args: address ? [address] : undefined,
    query: {
      enabled: Boolean(address && quote?.token),
      refetchInterval: 12_000,
    },
  });

  const held = rows.filter((r) => r.balance > 0n);
  const loading = stocksLoading || (Boolean(address && quote) && quoteBalance.isLoading);
  const quoteAmount = quoteBalance.isError ? undefined : quoteBalance.data;

  return (
    <Panel title="Your tokens">
      {!isConnected ? (
        <p className="text-muted text-sm">Connect a wallet to see what you hold.</p>
      ) : loading ? (
        <div className="grid gap-2">
          {[0, 1].map((i) => (
            <div key={i} className="border-line bg-panel-2 h-9 animate-pulse rounded-sm border" />
          ))}
        </div>
      ) : (
        <>
          <dl className="grid gap-2 text-[0.875rem]">
            {held.map((r) => (
              <Row
                key={r.token}
                label={r.symbol}
                value={`${fromRaw(r.shares ?? toShareEquivalent(r.balance, r.multiplier), r.decimals, 4)} shares`}
              />
            ))}
            {quote && (
              <Row
                label={quote.symbol}
                value={typeof quoteAmount === "bigint" ? fromRaw(quoteAmount, quote.decimals, 2) : "Unavailable"}
              />
            )}
          </dl>
          {held.length === 0 && quoteAmount === 0n && IS_TESTNET && (
            <Link
              href="/faucet"
              className="bg-text hover:bg-accent text-bg mt-3 inline-flex rounded-sm px-3 py-2 text-[0.8125rem] font-medium transition-colors"
            >
              Get test assets
            </Link>
          )}
        </>
      )}
    </Panel>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="border-line-soft flex items-baseline justify-between gap-4 border-t pt-2 first:border-t-0 first:pt-0">
      <dt className="text-dim">{label}</dt>
      <dd className="font-mono tabular-nums">{value}</dd>
    </div>
  );
}
