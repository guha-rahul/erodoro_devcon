"use client";

import Link from "next/link";
import { encodeFunctionData, erc20Abi } from "viem";
import { useAccount, useConfig, useReadContract, useReadContracts, useWriteContract } from "wagmi";
import { waitForTransactionReceipt } from "wagmi/actions";
import { useState } from "react";
import { TestFaucetAbi } from "@/lib/abis";
import { canBatchAtomically, sendAtomicBatch } from "@/lib/batching";
import { useDeployment } from "@/lib/use-app-network";
import { REQUIRED_CHAIN_ID } from "@/lib/wagmi";
import { assetFor } from "@/lib/issuers";
import { fromRaw } from "@/lib/format";
import { useNow } from "@/lib/use-now";
import type { Address } from "@/lib/types";
import { Button, EmptyState, Panel } from "./ui";
import { IssuerSandbox } from "./issuer-sandbox";

/**
 * Get something to try the product with.
 *
 * A test network is only usable by whoever holds the mint role, which is one
 * address, which is nobody. This is the step that turns "deployed" into
 * "anyone can try it".
 *
 * What it hands out is a **real B20 asset**, not a simplified stand-in — the
 * multiplier, the pause flag and the transfer policies are the parts most
 * likely to be wrong, and a simplified token would let all three go untested by
 * the people trying it.
 */
export function FaucetScreen() {
  const { address, isConnected } = useAccount();
  const config = useConfig();
  const { writeContractAsync } = useWriteContract();
  const now = useNow();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Render from the hydration-safe deployment: a switched network must not change the first render.
  const { deployment, isTestnet } = useDeployment();
  const faucet = deployment.contracts.faucet as Address | null;
  const quote = deployment.quote;

  const info = useReadContracts({
    contracts: faucet
      ? [
          { address: faucet, abi: TestFaucetAbi, functionName: "stock" },
          { address: faucet, abi: TestFaucetAbi, functionName: "stockAmount" },
          { address: faucet, abi: TestFaucetAbi, functionName: "quoteAmount" },
        ]
      : [],
    query: { enabled: Boolean(faucet) },
  });

  const stock = info.data?.[0]?.result as Address | undefined;
  const stockAmount = (info.data?.[1]?.result as bigint | undefined) ?? 0n;
  const quoteAmount = (info.data?.[2]?.result as bigint | undefined) ?? 0n;
  const asset = stock ? assetFor(stock) : null;

  const claimableAt = useReadContract({
    address: faucet ?? undefined,
    abi: TestFaucetAbi,
    functionName: "claimableAt",
    args: address ? [address] : undefined,
    query: { enabled: Boolean(faucet && address), refetchInterval: 15_000 },
  });

  const balances = useReadContracts({
    contracts:
      address && stock && quote
        ? [
            { address: stock, abi: erc20Abi, functionName: "balanceOf" as const, args: [address] },
            { address: quote.token, abi: erc20Abi, functionName: "balanceOf" as const, args: [address] },
          ]
        : [],
    query: { enabled: Boolean(address && stock && quote), refetchInterval: 15_000 },
  });

  if (!isTestnet || !faucet) {
    return (
      <EmptyState
        title="No faucet here"
        body="Test assets exist only on a test network. On mainnet you bring your own tokenized stock."
        action={
          <Link href="/earn" className="underline underline-offset-4">
            Go to Earn
          </Link>
        }
      />
    );
  }

  const nextAt = (claimableAt.data as bigint | undefined) ?? 0n;
  const waiting = nextAt !== 0n && now > 0n && now < nextAt;
  const stockBal = (balances.data?.[0]?.result as bigint | undefined) ?? 0n;
  const quoteBal = (balances.data?.[1]?.result as bigint | undefined) ?? 0n;

  return (
    <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_20rem]">
      <Panel tour="faucet-claim" title="Get test assets" subtitle="Everything you need to try the whole flow">
        <ul className="grid gap-3">
          <Item
            label={asset?.symbol ?? "Test stock"}
            amount={asset ? fromRaw(stockAmount, asset.decimals, 2) : "—"}
            body="Stands in for a tokenized stock. A real B20 asset, so the multiplier and issuer controls behave the way the live article does."
          />
          <Item
            label={quote?.symbol ?? "Test USD"}
            amount={quote ? fromRaw(quoteAmount, quote.decimals, 2) : "—"}
            body="What upside is bought and sold for. You need it only if you want to buy a claim rather than sell one."
          />
        </ul>

        <div className="mt-5">
          {!isConnected ? (
            <Button disabled disabledReason="Connect a wallet to claim.">
              Connect a wallet to claim
            </Button>
          ) : (
            <Button
              busy={busy}
              disabled={waiting}
              onClick={async () => {
                setBusy(true);
                setError(null);
                try {
                  if (!address) throw new Error("Connect a wallet to claim.");
                  // The claim is a sponsored action. An EIP-5792 wallet sends it
                  // as a single-call bundle so the Worker's allowlist can pay the
                  // gas; every other wallet claims normally.
                  const hash = (await canBatchAtomically(config, address, REQUIRED_CHAIN_ID))
                    ? await sendAtomicBatch(config, {
                        account: address,
                        chainId: REQUIRED_CHAIN_ID,
                        sponsor: true,
                        calls: [
                          {
                            to: faucet,
                            data: encodeFunctionData({ abi: TestFaucetAbi, functionName: "claim" }),
                          },
                        ],
                      })
                    : await writeContractAsync({
                        address: faucet,
                        abi: TestFaucetAbi,
                        functionName: "claim",
                      });
                  await waitForTransactionReceipt(config, { hash });
                  void claimableAt.refetch();
                  void balances.refetch();
                } catch (e) {
                  setError(e instanceof Error ? e.message : "The claim failed.");
                } finally {
                  setBusy(false);
                }
              }}
            >
              {waiting ? `Next claim at ${new Date(Number(nextAt) * 1000).toLocaleTimeString()}` : "Claim test assets"}
            </Button>
          )}
        </div>
        {error && (
          <p className="border-danger/40 bg-danger/8 text-danger mt-3 rounded-sm border px-3 py-2 text-[0.82rem]">
            {error}
          </p>
        )}

        <p className="text-dim mt-4 text-[0.78rem] leading-5">
          These are not securities and have no value. They exist so the flow can be exercised on a
          test network.
        </p>
      </Panel>

      <div className="grid content-start gap-6">
        <Panel title="Your balance">
          <dl className="grid gap-2 text-[0.875rem]">
            <Row label={asset?.symbol ?? "Stock"} value={asset ? fromRaw(stockBal, asset.decimals, 4) : "—"} />
            <Row label={quote?.symbol ?? "USD"} value={quote ? fromRaw(quoteBal, quote.decimals, 2) : "—"} />
          </dl>
          {stockBal > 0n && (
            <Link
              href="/earn"
              className="bg-text hover:bg-accent text-bg mt-4 inline-flex rounded-sm px-4 py-2 text-[0.8125rem] font-medium transition-colors"
            >
              Start earning →
            </Link>
          )}
        </Panel>
        <IssuerSandbox />
        <Panel title="What next">
          <ol className="text-muted grid gap-2 text-[0.875rem] leading-6">
            <li>1 · Claim the test stock above.</li>
            <li>2 · Pick a market and lock some of it.</li>
            <li>3 · Sell the upside for a premium.</li>
            <li>4 · After expiry, settle and redeem.</li>
          </ol>
        </Panel>
      </div>
    </div>
  );
}

function Item({ label, amount, body }: { label: string; amount: string; body: string }) {
  return (
    <li className="border-line rounded-sm border p-4">
      <div className="flex items-baseline justify-between gap-4">
        <span className="font-medium">{label}</span>
        <span className="font-mono text-sm tabular-nums">{amount}</span>
      </div>
      <p className="text-muted mt-2 text-[0.875rem] leading-6">{body}</p>
    </li>
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
