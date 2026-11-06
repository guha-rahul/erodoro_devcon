"use client";

import { useCallback, useEffect, useState } from "react";
import { useAccount, useConfig, useWriteContract } from "wagmi";
import { signTypedData, readContract, getAccount, waitForTransactionReceipt } from "wagmi/actions";
import { encodeFunctionData, erc20Abi } from "viem";
import { ErodoroIntentAbi, ErodoroVaultAbi } from "./abis";
import { canBatchAtomically, sendAtomicBatch } from "./batching";
import { DEPLOYMENT } from "./deployment";
import { SWAP_API } from "./swap-api";
import { REQUIRED_CHAIN_ID } from "./wagmi";
import { nId, type Address, type Hex, type Series } from "./types";
import type { SendState } from "./tx";

/**
 * Permissionless intent flow (no market maker required).
 *
 * The seller already holds N (split first via ActionsPanel), then signs a
 * SellIntent off-chain — no gas, no transaction per auction cycle. The
 * coordinator runs the fast/discovery competition; any buyer settles on-chain
 * via ErodoroIntent.fillIntent, which enforces the signed floor.
 */

export type SellIntentWire = {
  seller: Address;
  claims: Address;
  claimId: string;
  collateral: Address;
  strike: string;
  maturity: string;
  claimAmount: string;
  quoteToken: Address;
  minPremium: string;
  nonce: string;
  validFrom: string;
  validUntil: string;
  allowPartial: boolean;
  allowRollover: boolean;
  signature: Hex;
};

export type AuctionBid = {
  bidder: Address;
  intentHash: Hex;
  amount: string;
  premium: string;
  expiry: string;
  receivedAt: number;
};

export type AuctionView = {
  id: Hex;
  intentHash: Hex;
  path: "fast" | "discovery";
  state: string;
  createdAt: number;
  fastEndsAt: number;
  discoveryEndsAt: number;
  bids: AuctionBid[];
  winner: AuctionBid | null;
  winnerExclusiveUntil: number;
  filledAmount: string;
  settlementTx?: Hex;
  winningPremium?: string;
  buyer?: Address;
  round?: number;
  lastRolledOverAt?: number;
};

const INTENT_TYPES = {
  SellIntent: [
    { name: "seller", type: "address" },
    { name: "claims", type: "address" },
    { name: "claimId", type: "uint256" },
    { name: "collateral", type: "address" },
    { name: "strike", type: "uint256" },
    { name: "maturity", type: "uint64" },
    { name: "claimAmount", type: "uint256" },
    { name: "quoteToken", type: "address" },
    { name: "minPremium", type: "uint256" },
    { name: "nonce", type: "uint256" },
    { name: "validFrom", type: "uint256" },
    { name: "validUntil", type: "uint256" },
    { name: "allowPartial", type: "bool" },
    { name: "allowRollover", type: "bool" },
  ],
} as const;

const BID_TYPES = {
  Bid: [
    { name: "bidder", type: "address" },
    { name: "intentHash", type: "bytes32" },
    { name: "amount", type: "uint256" },
    { name: "premium", type: "uint256" },
    { name: "expiry", type: "uint256" },
    { name: "nonce", type: "uint256" },
  ],
} as const;

export function intentAvailable(): boolean {
  return DEPLOYMENT.contracts.intent !== null;
}

/** The on-chain struct shared by `checkIntent` and `fillIntent`. */
function toOnchainIntent(wire: SellIntentWire) {
  return {
    seller: wire.seller,
    claims: wire.claims,
    claimId: BigInt(wire.claimId),
    collateral: wire.collateral,
    strike: BigInt(wire.strike),
    maturity: BigInt(wire.maturity),
    claimAmount: BigInt(wire.claimAmount),
    quoteToken: wire.quoteToken,
    minPremium: BigInt(wire.minPremium),
    nonce: BigInt(wire.nonce),
    validFrom: BigInt(wire.validFrom),
    validUntil: BigInt(wire.validUntil),
    allowPartial: wire.allowPartial,
    allowRollover: wire.allowRollover,
  } as const;
}

export function useIntent() {
  const { address, chainId } = useAccount();
  const config = useConfig();
  const { writeContractAsync } = useWriteContract();
  const [state, setState] = useState<SendState>({ kind: "idle" });
  const [note, setNote] = useState<string | null>(null);

  const intent = DEPLOYMENT.contracts.intent as Address | null;
  const vault = DEPLOYMENT.contracts.vault as Address | null;
  const quote = DEPLOYMENT.quote;

  /** Sign a sell intent and register it. Costs no gas. */
  const signAndList = useCallback(
    async (args: {
      series: Series;
      amount: bigint;
      floor: bigint;
      validHours: number;
      allowPartial: boolean;
      allowRollover: boolean;
    }): Promise<{ hash: Hex; wire: SellIntentWire } | null> => {
      if (!address || !intent || !vault || !quote) {
        setState({ kind: "error", message: "Connect a wallet first." });
        return null;
      }
      if (chainId !== REQUIRED_CHAIN_ID) {
        setState({ kind: "error", message: `Switch to ${DEPLOYMENT.chainName} before signing.` });
        return null;
      }
      try {
        const approved = (await readContract(config, {
          address: vault,
          abi: ErodoroVaultAbi,
          functionName: "isOperator",
          args: [address, intent],
        })) as boolean;
        if (!approved) {
          setState({ kind: "sending", phase: "approval" });
          const approvalHash = await writeContractAsync({
            address: vault,
            abi: ErodoroVaultAbi,
            functionName: "setOperator",
            args: [intent, true],
          });
          setState({ kind: "sending", phase: "confirming", hash: approvalHash });
          const approvalReceipt = await waitForTransactionReceipt(config, { hash: approvalHash });
          if (approvalReceipt.status !== "success") throw new Error("Upside approval reverted.");
        }
        setState({ kind: "sending", phase: "preparing" });
        const now = BigInt(Math.floor(Date.now() / 1000));
        const message = {
          seller: address,
          claims: vault,
          claimId: nId(args.series.id),
          collateral: args.series.config.collateral,
          strike: args.series.config.strike,
          maturity: args.series.config.maturity,
          claimAmount: args.amount,
          quoteToken: quote.token,
          minPremium: args.floor,
          nonce: BigInt(Date.now()) * 1000n + BigInt(Math.floor(Math.random() * 1000)),
          validFrom: now - 60n,
          validUntil: now + BigInt(Math.floor(args.validHours * 3600)),
          allowPartial: args.allowPartial,
          allowRollover: args.allowRollover,
        } as const;
        const signature = await signTypedData(config, {
          domain: { name: "ErodoroIntent", version: "1", chainId: REQUIRED_CHAIN_ID, verifyingContract: intent },
          types: INTENT_TYPES,
          primaryType: "SellIntent",
          message: { ...message },
        });
        const wire: SellIntentWire = {
          seller: message.seller,
          claims: message.claims,
          claimId: message.claimId.toString(),
          collateral: message.collateral,
          strike: message.strike.toString(),
          maturity: message.maturity.toString(),
          claimAmount: message.claimAmount.toString(),
          quoteToken: message.quoteToken,
          minPremium: message.minPremium.toString(),
          nonce: message.nonce.toString(),
          validFrom: message.validFrom.toString(),
          validUntil: message.validUntil.toString(),
          allowPartial: message.allowPartial,
          allowRollover: message.allowRollover,
          signature,
        };
        const res = await fetch(`${SWAP_API}/api/intents`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(wire),
        });
        const body = await res.json().catch(() => null);
        if (!res.ok) throw new Error(body?.error ?? "The coordinator refused the intent.");
        setState({ kind: "idle" });
        setNote(null);
        return { hash: body.intentHash as Hex, wire };
      } catch (e: unknown) {
        const message = e instanceof Error ? e.message : "Signing failed.";
        const cancelled = /user rejected|denied|cancell?ed/i.test(message);
        setState(cancelled ? { kind: "cancelled", message: "Rejected in the wallet." } : { kind: "error", message });
        return null;
      }
    },
    [address, chainId, config, intent, vault, quote, writeContractAsync],
  );

  /**
   * Cancel an intent. The on-chain transaction is authoritative — the
   * coordinator is told afterwards so it stops matching. Both are needed:
   * coordinator-only cancellation would not stop a direct contract fill.
   */
  const cancel = useCallback(
    async (wire: SellIntentWire): Promise<Hex | null> => {
      if (!address || !intent) {
        setState({ kind: "error", message: "Connect a wallet first." });
        return null;
      }
      try {
        setState({ kind: "sending", phase: "approval" });
        const toOnchain = {
          seller: wire.seller,
          claims: wire.claims,
          claimId: BigInt(wire.claimId),
          collateral: wire.collateral,
          strike: BigInt(wire.strike),
          maturity: BigInt(wire.maturity),
          claimAmount: BigInt(wire.claimAmount),
          quoteToken: wire.quoteToken,
          minPremium: BigInt(wire.minPremium),
          nonce: BigInt(wire.nonce),
          validFrom: BigInt(wire.validFrom),
          validUntil: BigInt(wire.validUntil),
          allowPartial: wire.allowPartial,
          allowRollover: wire.allowRollover,
        } as const;
        const hash = await writeContractAsync({
          address: intent,
          abi: ErodoroIntentAbi,
          functionName: "cancelIntent",
          args: [toOnchain],
        });
        setState({ kind: "sending", phase: "confirming", hash });
        const receipt = await waitForTransactionReceipt(config, { hash });
        if (receipt.status !== "success") throw new Error("Cancellation reverted.");
        await fetch(`${SWAP_API}/api/intents/cancel`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ intentHash: intentHashOf(wire), seller: address }),
        }).catch(() => null);
        setState({ kind: "ok", hash });
        return hash;
      } catch (e: unknown) {
        const message = e instanceof Error ? e.message : "Cancellation failed.";
        const cancelled = /user rejected|denied|cancell?ed/i.test(message);
        setState(cancelled ? { kind: "cancelled", message: "Rejected in the wallet." } : { kind: "error", message });
        return null;
      }
    },
    [address, config, intent, writeContractAsync],
  );

  return { state, note, signAndList, cancel, intent, vault, quote };
}

/** Deterministic coordinator id (the contract digest is authoritative on-chain). */
export function intentHashOf(wire: SellIntentWire): Hex {
  const key = `${wire.seller.toLowerCase()}|${wire.claims.toLowerCase()}|${wire.claimId}|${wire.nonce}`;
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
  return `0x${out.slice(0, 64)}` as Hex;
}

/** Live auction state for one intent, polled. */
export function useAuction(intentHash: Hex | null) {
  const [auction, setAuction] = useState<AuctionView | null>(null);
  const [intent, setIntent] = useState<SellIntentWire | null>(null);
  useEffect(() => {
    if (!intentHash) return;
    let live = true;
    const load = async () => {
      try {
        // Advancing is idempotent. Keeping it beside the poll means the demo
        // does not depend on an operator running a separate auction clock.
        await fetch(`${SWAP_API}/api/auctions/${intentHash}/advance`, { method: "POST" }).catch(() => null);
        const res = await fetch(`${SWAP_API}/api/auctions/${intentHash}`);
        if (!res.ok) return;
        const body = await res.json();
        if (live) {
          setAuction(body.auction ?? null);
          setIntent(body.intent ?? null);
        }
      } catch {
        /* offline — keep last state */
      }
    };
    load();
    const timer = setInterval(load, 5000);
    return () => {
      live = false;
      clearInterval(timer);
    };
  }, [intentHash]);
  if (!intentHash) return { auction: null, intent: null };
  return { auction, intent };
}

/** Buyer flow: sign a bid, submit it, and settle a won intent on-chain. */
export function useBidder() {
  const { address, chainId } = useAccount();
  const config = useConfig();
  const { writeContractAsync } = useWriteContract();
  const [state, setState] = useState<SendState>({ kind: "idle" });
  const [purchaseStep, setPurchaseStep] = useState<"approval" | "purchase" | "complete">("approval");

  const intent = DEPLOYMENT.contracts.intent as Address | null;
  const vault = DEPLOYMENT.contracts.vault as Address | null;

  const submitBid = useCallback(
    async (auction: AuctionView, amount: bigint, premium: bigint): Promise<boolean> => {
      if (!address || !intent) {
        setState({ kind: "error", message: "Connect a wallet first." });
        return false;
      }
      if (chainId !== REQUIRED_CHAIN_ID) {
        setState({ kind: "error", message: `Switch to ${DEPLOYMENT.chainName} before signing.` });
        return false;
      }
      try {
        setState({ kind: "sending", phase: "approval" });
        const now = BigInt(Math.floor(Date.now() / 1000));
        const auctionEndsAt = auction.path === "discovery" ? auction.discoveryEndsAt : auction.fastEndsAt;
        // Keep the signed bid valid through selection and the winner's short
        // settlement window, even when an auction runs longer than 10 minutes.
        const expiry = BigInt(Math.max(Number(now + 600n), auctionEndsAt + 300));
        const nonce = BigInt(Date.now());
        const signature = await signTypedData(config, {
          domain: { name: "ErodoroAuction", version: "1", chainId: REQUIRED_CHAIN_ID, verifyingContract: intent },
          types: BID_TYPES,
          primaryType: "Bid",
          message: {
            bidder: address,
            intentHash: auction.intentHash,
            amount,
            premium,
            expiry,
            nonce,
          },
        });
        const res = await fetch(`${SWAP_API}/api/auctions/${auction.id}/bids`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            bidder: address,
            amount: amount.toString(),
            premium: premium.toString(),
            expiry: expiry.toString(),
            nonce: nonce.toString(),
            signature,
          }),
        });
        const body = await res.json().catch(() => null);
        if (!res.ok) throw new Error(body?.error ?? "The coordinator refused the bid.");
        setState({ kind: "idle" });
        return true;
      } catch (e: unknown) {
        const message = e instanceof Error ? e.message : "Bid failed.";
        const cancelled = /user rejected|denied|cancell?ed/i.test(message);
        setState(cancelled ? { kind: "cancelled", message: "Rejected in the wallet." } : { kind: "error", message });
        return false;
      }
    },
    [address, chainId, config, intent],
  );

  /** Winner settles: pays premium, receives N, in one atomic transaction. */
  const settle = useCallback(
    async (wire: SellIntentWire, amount: bigint, premium: bigint): Promise<Hex | null> => {
      if (!address || !intent || !vault) {
        setState({ kind: "error", message: "Connect a wallet first." });
        return null;
      }
      if (chainId !== REQUIRED_CHAIN_ID) {
        setState({ kind: "error", message: `Switch to ${DEPLOYMENT.chainName} before settling.` });
        return null;
      }
      const onchain = toOnchainIntent(wire);
      const report = async (hash: Hex) => {
        await fetch(`${SWAP_API}/api/settlement/report`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            intentHash: intentHashOf(wire),
            amount: amount.toString(),
            premium: premium.toString(),
            txHash: hash,
            buyer: address,
          }),
        }).catch(() => null);
      };
      const preflight = async (): Promise<boolean> => {
        const [valid, why] = (await readContract(config, {
          address: intent,
          abi: ErodoroIntentAbi,
          functionName: "checkIntent",
          args: [onchain, wire.signature, amount, premium, address],
        })) as [boolean, string];
        if (!valid) {
          setState({ kind: "error", message: why || "That fill is no longer good." });
          return false;
        }
        return true;
      };
      try {
        setPurchaseStep("approval");
        setState({ kind: "sending", phase: "approval" });
        const allowance = await readContract(config, {
          address: wire.quoteToken,
          abi: erc20Abi,
          functionName: "allowance",
          args: [address, intent],
        });

        if (allowance < premium) {
          // An EIP-5792 wallet approves and fills in one confirmation; an
          // unfunded or stale intent reverts the whole bundle, so the approval
          // can never be stranded on its own.
          if (await canBatchAtomically(config, address, REQUIRED_CHAIN_ID)) {
            setState({ kind: "sending", phase: "preparing" });
            if (!(await preflight())) return null;
            const current = getAccount(config);
            if (current.address?.toLowerCase() !== address.toLowerCase() || current.chainId !== REQUIRED_CHAIN_ID) {
              throw new Error("Wallet or network changed. Refresh the auction before settling.");
            }
            setPurchaseStep("purchase");
            setState({ kind: "sending", phase: "approval" });
            const hash = await sendAtomicBatch(config, {
              account: address,
              chainId: REQUIRED_CHAIN_ID,
              sponsor: true,
              calls: [
                {
                  to: wire.quoteToken,
                  data: encodeFunctionData({ abi: erc20Abi, functionName: "approve", args: [intent, premium] }),
                },
                {
                  to: intent,
                  data: encodeFunctionData({
                    abi: ErodoroIntentAbi,
                    functionName: "fillIntent",
                    args: [onchain, wire.signature, amount, premium],
                  }),
                },
              ],
            });
            setPurchaseStep("complete");
            setState({ kind: "ok", hash });
            await report(hash);
            return hash;
          }

          const approvalHash = await writeContractAsync({
            address: wire.quoteToken,
            abi: erc20Abi,
            functionName: "approve",
            args: [intent, premium],
          });
          setState({ kind: "sending", phase: "confirming", hash: approvalHash });
          const approvalReceipt = await waitForTransactionReceipt(config, { hash: approvalHash });
          if (approvalReceipt.status !== "success") throw new Error("Payment approval reverted.");
          setState({ kind: "sending", phase: "preparing" });
        }

        setPurchaseStep("purchase");
        setState({ kind: "sending", phase: "preparing" });
        if (!(await preflight())) return null;
        const current = getAccount(config);
        if (current.address?.toLowerCase() !== address.toLowerCase() || current.chainId !== REQUIRED_CHAIN_ID) {
          throw new Error("Wallet or network changed. Refresh the auction before settling.");
        }
        setState({ kind: "sending", phase: "approval" });
        const hash = await writeContractAsync({
          address: intent,
          abi: ErodoroIntentAbi,
          functionName: "fillIntent",
          args: [onchain, wire.signature, amount, premium],
        });
        setState({ kind: "sending", phase: "confirming", hash });
        const receipt = await waitForTransactionReceipt(config, { hash });
        if (receipt.status !== "success") throw new Error("Settlement reverted.");
        setPurchaseStep("complete");
        setState({ kind: "ok", hash });
        await report(hash);
        setState({ kind: "ok", hash });
        return hash;
      } catch (e: unknown) {
        const message = e instanceof Error ? e.message : "Settlement failed.";
        const cancelled = /user rejected|denied|cancell?ed/i.test(message);
        setState(cancelled ? { kind: "cancelled", message: "Rejected in the wallet." } : { kind: "error", message });
        return null;
      }
    },
    [address, chainId, config, intent, vault, writeContractAsync],
  );

  return { state, purchaseStep, submitBid, settle };
}
