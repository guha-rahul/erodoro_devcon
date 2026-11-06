"use client";

import { useCallback, useState } from "react";
import { useAccount, useConfig, useWriteContract } from "wagmi";
import { encodeFunctionData } from "viem";
import { getAccount, readContract, waitForTransactionReceipt } from "wagmi/actions";
import { ErodoroRFQAbi, ErodoroVaultAbi } from "./abis";
import { canBatchAtomically, sendAtomicBatch } from "./batching";
import { DEPLOYMENT } from "./deployment";
import { SWAP_API } from "./swap-api";
import { REQUIRED_CHAIN_ID } from "./wagmi";
import type { Address, Hex } from "./types";
import type { SendState } from "./tx";

/** A firm price from one market maker, good until it expires. */
export type Quote = {
  maker: Address;
  taker: Address;
  claims: Address;
  claimId: string;
  claimAmount: string;
  quoteToken: Address;
  quoteAmount: string;
  expiry: string;
  nonce: string;
};

export type SignedQuote = { quote: Quote; signature: Hex; makerName?: string };

/**
 * Quotes cross the wire as strings, because JSON has no integer wide enough to
 * carry a `uint256` without silently rounding it. The contract wants bigints,
 * so the conversion happens once, here, on the way in.
 */
function toOnchain(q: Quote) {
  return {
    maker: q.maker,
    taker: q.taker,
    claims: q.claims,
    claimId: BigInt(q.claimId),
    claimAmount: BigInt(q.claimAmount),
    quoteToken: q.quoteToken,
    quoteAmount: BigInt(q.quoteAmount),
    expiry: BigInt(q.expiry),
    nonce: BigInt(q.nonce),
  } as const;
}

export type QuoteRequest = {
  claims: Address;
  claimId: bigint;
  claimAmount: bigint;
  quoteToken: Address;
  taker: Address;
};

/**
 * Ask market makers for a price, then sell into the best one.
 *
 * Nothing rests on chain, so there is no empty book to stare at and no pool to
 * seed. A seller who wants a price asks for one, which is the only model that
 * serves the *first* seller — the hard case for this product.
 *
 * The maker signs off-chain and never sends a transaction. The seller submits
 * their signature, and the claim and the payment move in the same call or
 * neither does.
 */
export function useRfq() {
  const { address, chainId } = useAccount();
  const config = useConfig();
  const { writeContractAsync } = useWriteContract();
  const [quotes, setQuotes] = useState<SignedQuote[] | null>(null);
  const [requesting, setRequesting] = useState(false);
  const [state, setState] = useState<SendState>({ kind: "idle" });
  const [note, setNote] = useState<string | null>(null);

  const rfq = DEPLOYMENT.contracts.rfq as Address | null;
  const vault = DEPLOYMENT.contracts.vault as Address;

  const request = useCallback(async (req: QuoteRequest) => {
    setRequesting(true);
    setQuotes(null);
    setNote(null);
    try {
      const res = await fetch(`${SWAP_API}/rfq`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          claims: req.claims,
          claimId: req.claimId.toString(),
          claimAmount: req.claimAmount.toString(),
          quoteToken: req.quoteToken,
          taker: req.taker,
        }),
      });
      const body = await res.json().catch(() => null);
      if (!res.ok) throw new Error(body?.error ?? `Quoting service returned ${res.status}.`);
      if (!Array.isArray(body?.quotes)) throw new Error("Quoting service returned an invalid response.");
      setQuotes(body.quotes);
      setNote(body.note ?? null);
    } catch (e) {
      setNote(e instanceof Error ? e.message : "Could not reach the quoting service.");
      setQuotes([]);
    } finally {
      setRequesting(false);
    }
  }, []);

  /** Sell into a specific quote. One transaction. */
  const sell = useCallback(
    async (signed: SignedQuote) => {
      if (!address || !rfq) {
        setState({ kind: "error", message: "Connect a wallet first." });
        return null;
      }
      if (chainId !== REQUIRED_CHAIN_ID) {
        setState({ kind: "error", message: `Switch to ${DEPLOYMENT.chainName} before signing.` });
        return null;
      }
      try {
        // Refuse to open a wallet for a fill the chain already says will fail.
        const [ok, why] = (await readContract(config, {
          address: rfq,
          abi: ErodoroRFQAbi,
          functionName: "checkQuote",
          args: [toOnchain(signed.quote), signed.signature, address],
        })) as [boolean, string];
        if (!ok) {
          setState({ kind: "error", message: why || "That quote is no longer good." });
          return null;
        }

        const isOperator = (await readContract(config, {
          address: vault,
          abi: ErodoroVaultAbi,
          functionName: "isOperator",
          args: [address, rfq],
        })) as boolean;

        setState({ kind: "sending", phase: "approval" });
        if (!isOperator) {
          // An EIP-5792 wallet grants the operator and fills in one
          // confirmation. The batch is atomic, so a quote that moved during the
          // prompt reverts everything rather than leaving a live operator.
          if (await canBatchAtomically(config, address, REQUIRED_CHAIN_ID)) {
            const current = getAccount(config);
            if (current.address?.toLowerCase() !== address.toLowerCase() || current.chainId !== REQUIRED_CHAIN_ID) {
              throw new Error("Wallet or network changed. Return to the intended wallet and request a new quote.");
            }
            const hash = await sendAtomicBatch(config, {
              account: address,
              chainId: REQUIRED_CHAIN_ID,
              calls: [
                {
                  to: vault,
                  data: encodeFunctionData({ abi: ErodoroVaultAbi, functionName: "setOperator", args: [rfq, true] }),
                },
                {
                  to: rfq,
                  data: encodeFunctionData({ abi: ErodoroRFQAbi, functionName: "fill", args: [toOnchain(signed.quote), signed.signature] }),
                },
              ],
            });
            setState({ kind: "sending", phase: "confirming", hash });
            setState({ kind: "ok", hash });
            return hash;
          }

          const approve = await writeContractAsync({
            address: vault,
            abi: ErodoroVaultAbi,
            functionName: "setOperator",
            args: [rfq, true],
          });
          const approval = await waitForTransactionReceipt(config, { hash: approve });
          if (approval.status !== "success") throw new Error("Approval reverted. No upside was sold.");

          const [stillValid, reason] = await readContract(config, {
            address: rfq,
            abi: ErodoroRFQAbi,
            functionName: "checkQuote",
            args: [toOnchain(signed.quote), signed.signature, address],
          });
          if (!stillValid) throw new Error(reason || "Quote expired during approval. Request a new quote.");
        }

        const currentAccount = getAccount(config);
        if (currentAccount.address?.toLowerCase() !== address.toLowerCase() || currentAccount.chainId !== REQUIRED_CHAIN_ID) {
          throw new Error("Wallet or network changed. Return to the intended wallet and request a new quote.");
        }

        const hash = await writeContractAsync({
          address: rfq,
          abi: ErodoroRFQAbi,
          functionName: "fill",
          args: [toOnchain(signed.quote), signed.signature],
        });
        setState({ kind: "sending", phase: "confirming", hash });
        const receipt = await waitForTransactionReceipt(config, { hash });
        if (receipt.status !== "success") throw new Error("The sale reverted. No upside was sold by this transaction.");
        setState({ kind: "ok", hash });
        return hash;
      } catch (e: unknown) {
        const message = e instanceof Error ? e.message : "The sale failed.";
        const cancelled = /user rejected|denied|cancell?ed/i.test(message);
        setState(cancelled ? { kind: "cancelled", message: "Rejected in the wallet." } : { kind: "error", message });
        return null;
      }
    },
    [address, chainId, config, rfq, vault, writeContractAsync],
  );

  return { quotes, requesting, note, state, request, sell, best: quotes?.[0] ?? null };
}
