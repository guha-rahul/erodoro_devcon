"use client";

import { useCallback, useState } from "react";
import { useAccount, useWriteContract, useConfig } from "wagmi";
import { waitForTransactionReceipt, readContract } from "wagmi/actions";
import { encodeFunctionData, erc20Abi } from "viem";
import { ErodoroVaultAbi, IB20AssetAbi, IPolicyRegistryAbi } from "./abis";
import { PAUSE_TRANSFER, POLICY_REGISTRY } from "./use-b20";
import { canBatchAtomically, sendAtomicBatch } from "./batching";
import { DEPLOYMENT } from "./deployment";
import { REQUIRED_CHAIN_ID } from "./wagmi";
import { fetchPrint } from "./hermes";
import { rpcChainMismatch } from "./chain";
import type { Address, Hex } from "./types";
import type { SendState as TxState } from "./tx";

export type { TxState };

/**
 * The write paths.
 *
 * Every action goes through `run`, which enforces one rule the UI must never
 * skip: **the wallet has to be on the right chain before it signs.** A
 * transaction sent to the wrong network is gone, and no amount of error
 * handling afterwards recovers it.
 */
export function useActions() {
  const { address, chainId } = useAccount();
  const config = useConfig();
  const { writeContractAsync } = useWriteContract();
  const [state, setState] = useState<TxState>({ kind: "idle" });

  const vault = DEPLOYMENT.contracts.vault as Address;

  const run = useCallback(
    async (fn: () => Promise<Hex>) => {
      if (!address) {
        setState({ kind: "error", message: "Connect a wallet first." });
        return null;
      }
      if (chainId !== REQUIRED_CHAIN_ID) {
        setState({ kind: "error", message: `Switch to ${DEPLOYMENT.chainName} before signing.` });
        return null;
      }
      // The wallet being on the right chain is not enough: the endpoint the app
      // reads from is configured separately and can disagree with this build.
      const rpcMismatch = await rpcChainMismatch();
      if (rpcMismatch) {
        setState({ kind: "error", message: rpcMismatch });
        return null;
      }
      try {
        setState({ kind: "sending", phase: "approval" });
        const hash = await fn();
        setState({ kind: "sending", phase: "confirming", hash });
        await waitForTransactionReceipt(config, { hash });
        setState({ kind: "ok", hash });
        return hash;
      } catch (e: unknown) {
        const message = e instanceof Error ? e.message : "Transaction failed.";
        // A user closing the wallet is a cancellation, not a failure.
        const cancelled = /user rejected|denied|cancell?ed/i.test(message);
        setState(cancelled ? { kind: "cancelled", message: "Rejected in the wallet." } : { kind: "error", message });
        return null;
      }
    },
    [address, chainId, config],
  );

  /**
   * The B20 gate, checked before an approval is requested.
   *
   * A pause or a policy denial stops the transfer inside the token, so an
   * `approve()` that succeeds proves nothing. Returns a sentence to show, or
   * null when the transfer may proceed. Tokens that do not implement the B20
   * surface fail the staticcall and are treated as un-gated, which is accurate:
   * this check exists to explain a B20 revert, not to invent one.
   */
  const transferGate = useCallback(
    async (collateral: Address, to: Address): Promise<string | null> => {
      if (!address) return null;
      try {
        const paused = (await readContract(config, {
          address: collateral,
          abi: IB20AssetAbi,
          functionName: "isPaused",
          args: [PAUSE_TRANSFER],
        })) as boolean;
        if (paused) {
          return "The issuer has paused transfers of this token. Nothing can be locked or redeemed until that is lifted.";
        }

        const [senderScope, receiverScope] = (await Promise.all([
          readContract(config, { address: collateral, abi: IB20AssetAbi, functionName: "TRANSFER_SENDER_POLICY" }),
          readContract(config, { address: collateral, abi: IB20AssetAbi, functionName: "TRANSFER_RECEIVER_POLICY" }),
        ])) as [Hex, Hex];

        const scopeCheck = async (scope: Hex, who: Address, message: string): Promise<string | null> => {
          if (!scope || /^0x0+$/.test(scope)) return null;
          const policy = (await readContract(config, {
            address: collateral,
            abi: IB20AssetAbi,
            functionName: "policyId",
            args: [scope],
          })) as bigint;
          if (policy === 0n) return null;
          const allowed = (await readContract(config, {
            address: POLICY_REGISTRY,
            abi: IPolicyRegistryAbi,
            functionName: "isAuthorized",
            args: [policy, who],
          })) as boolean;
          return allowed ? null : message;
        };

        return (
          (await scopeCheck(
            senderScope,
            address,
            "The issuer's transfer policy does not authorise your address to send this token.",
          )) ??
          (await scopeCheck(
            receiverScope,
            to,
            "The issuer's transfer policy does not authorise the vault to receive this token.",
          ))
        );
      } catch {
        return null;
      }
    },
    [address, config],
  );

  /** Approve only what is being locked, not an unlimited allowance. */
  const approveAndSplit = useCallback(
    async (seriesId: bigint, collateral: Address, amount: bigint) => {
      if (!address) {
        setState({ kind: "error", message: "Connect a wallet first." });
        return null;
      }
      // The issuer's pause and policies are a different gate from the
      // allowance. Check them first so a doomed transfer fails with a sentence
      // instead of an approve that succeeds and a split that reverts.
      const blocked = await transferGate(collateral, vault);
      if (blocked) {
        setState({ kind: "error", message: blocked });
        return null;
      }
      const allowance = await readContract(config, {
        address: collateral,
        abi: erc20Abi,
        functionName: "allowance",
        args: [address, vault],
      });
      if (allowance < amount) {
        // An EIP-5792 wallet files the approval and the split as one
        // confirmation. A wallet without it keeps the two-step flow.
        if (await canBatchAtomically(config, address, REQUIRED_CHAIN_ID)) {
          setState({ kind: "sending", phase: "approval" });
          return run(() =>
            sendAtomicBatch(config, {
              account: address,
              chainId: REQUIRED_CHAIN_ID,
              calls: [
                {
                  to: collateral,
                  data: encodeFunctionData({ abi: erc20Abi, functionName: "approve", args: [vault, amount] }),
                },
                {
                  to: vault,
                  data: encodeFunctionData({ abi: ErodoroVaultAbi, functionName: "split", args: [seriesId, amount] }),
                },
              ],
            }),
          );
        }
        setState({ kind: "sending", phase: "preparing" });
        const ok = await run(() =>
          writeContractAsync({ address: collateral, abi: erc20Abi, functionName: "approve", args: [vault, amount] }),
        );
        if (!ok) return null;
      }
      return run(() =>
        writeContractAsync({ address: vault, abi: ErodoroVaultAbi, functionName: "split", args: [seriesId, amount] }),
      );
    },
    [address, config, run, vault, writeContractAsync, transferGate],
  );

  const merge = useCallback(
    (seriesId: bigint, amount: bigint) =>
      run(() =>
        writeContractAsync({ address: vault, abi: ErodoroVaultAbi, functionName: "merge", args: [seriesId, amount] }),
      ),
    [run, vault, writeContractAsync],
  );

  /**
   * Settle. Fetches a signed print, pays the oracle fee, and submits.
   *
   * The fee is the part with no counterpart in the design this was ported from,
   * where settlement cost the caller nothing. It is surfaced before signing.
   */
  const settle = useCallback(
    async (seriesId: bigint, feedId: Hex, maturity: bigint) => {
      setState({ kind: "sending", phase: "preparing" });
      let update: Hex;
      try {
        update = (await fetchPrint(feedId, maturity)).update;
      } catch (e) {
        setState({ kind: "error", message: e instanceof Error ? e.message : "Could not fetch a price." });
        return null;
      }
      const fee = await readContract(config, {
        address: DEPLOYMENT.external.pyth,
        abi: [
          {
            type: "function",
            name: "getUpdateFee",
            stateMutability: "view",
            inputs: [{ name: "updateData", type: "bytes[]" }],
            outputs: [{ name: "feeAmount", type: "uint256" }],
          },
        ] as const,
        functionName: "getUpdateFee",
        args: [[update]],
      });
      return run(() =>
        writeContractAsync({
          address: vault,
          abi: ErodoroVaultAbi,
          functionName: "settle",
          args: [seriesId, [update]],
          value: fee,
        }),
      );
    },
    [config, run, vault, writeContractAsync],
  );

  const redeem = useCallback(
    async (seriesId: bigint, isP: boolean, amount: bigint) => {
      // Redemption is one of the sponsored actions. An EIP-5792 wallet can send
      // it as a single-call bundle so the Worker's allowlist sees the selector
      // and can pay the gas. A wallet without batching still redeems, user-paid.
      if (address && chainId === REQUIRED_CHAIN_ID && (await canBatchAtomically(config, address, REQUIRED_CHAIN_ID))) {
        setState({ kind: "sending", phase: "approval" });
        return run(() =>
          sendAtomicBatch(config, {
            account: address,
            chainId: REQUIRED_CHAIN_ID,
            sponsor: true,
            calls: [
              {
                to: vault,
                data: encodeFunctionData({
                  abi: ErodoroVaultAbi,
                  functionName: "redeem",
                  args: [seriesId, isP, amount],
                }),
              },
            ],
          }),
        );
      }
      return run(() =>
        writeContractAsync({
          address: vault,
          abi: ErodoroVaultAbi,
          functionName: "redeem",
          args: [seriesId, isP, amount],
        }),
      );
    },
    [address, chainId, config, run, vault, writeContractAsync],
  );

  return { state, reset: () => setState({ kind: "idle" }), approveAndSplit, merge, settle, redeem };
}
