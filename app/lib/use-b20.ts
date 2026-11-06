"use client";

import { useReadContracts } from "wagmi";
import { IB20AssetAbi, IPolicyRegistryAbi } from "./abis";
import type { Address } from "./types";

/** The PolicyRegistry precompile. Fixed across every chain that has it. */
export const POLICY_REGISTRY: Address = "0x8453000000000000000000000000000000000002";

/** `PausableFeature` — TRANSFER is the one that stops this protocol working. */
export const PAUSE_TRANSFER = 0;

/**
 * What a B20 collateral token says about itself right now.
 *
 * Three things a plain ERC-20 has no notion of, and each one can break a
 * transaction that looked fine a block earlier:
 *
 * - **the multiplier.** One token is not one share forever. A corporate action
 *   rebases what a raw unit represents, so a share-equivalent quantity is a
 *   derived number and must be recomputed, never cached as a constant.
 * - **pause.** Transfers can be halted wholesale by the issuer.
 * - **transfer policies.** The issuer can deny an address. On the live tokens
 *   all four policy scopes are **already armed and currently permissive**, so
 *   this is one list entry away from live, not a hypothetical.
 */
export function useB20(token?: Address, account?: Address, spender?: Address) {
  const enabled = Boolean(token);

  const core = useReadContracts({
    contracts: token
      ? [
          { address: token, abi: IB20AssetAbi, functionName: "multiplier" },
          { address: token, abi: IB20AssetAbi, functionName: "isPaused", args: [PAUSE_TRANSFER] },
          { address: token, abi: IB20AssetAbi, functionName: "TRANSFER_SENDER_POLICY" },
          { address: token, abi: IB20AssetAbi, functionName: "TRANSFER_RECEIVER_POLICY" },
        ]
      : [],
    query: { enabled, refetchInterval: 30_000 },
  });

  const multiplier = (core.data?.[0]?.result as bigint | undefined) ?? null;
  const transferPaused = (core.data?.[1]?.result as boolean | undefined) ?? false;
  const senderScope = core.data?.[2]?.result as `0x${string}` | undefined;
  const receiverScope = core.data?.[3]?.result as `0x${string}` | undefined;

  const policyIds = useReadContracts({
    contracts:
      token && senderScope && receiverScope
        ? [
            { address: token, abi: IB20AssetAbi, functionName: "policyId", args: [senderScope] },
            { address: token, abi: IB20AssetAbi, functionName: "policyId", args: [receiverScope] },
          ]
        : [],
    query: { enabled: Boolean(token && senderScope && receiverScope) },
  });

  const senderPolicy = (policyIds.data?.[0]?.result as bigint | undefined) ?? 0n;
  const receiverPolicy = (policyIds.data?.[1]?.result as bigint | undefined) ?? 0n;

  // Only ask the registry about accounts that actually matter for the next
  // transfer: the person sending, and the vault receiving.
  const auth = useReadContracts({
    contracts: [
      ...(account && senderPolicy !== 0n
        ? [
            {
              address: POLICY_REGISTRY,
              abi: IPolicyRegistryAbi,
              functionName: "isAuthorized" as const,
              args: [senderPolicy, account],
            },
          ]
        : []),
      ...(spender && receiverPolicy !== 0n
        ? [
            {
              address: POLICY_REGISTRY,
              abi: IPolicyRegistryAbi,
              functionName: "isAuthorized" as const,
              args: [receiverPolicy, spender],
            },
          ]
        : []),
    ],
    query: { enabled: Boolean((account && senderPolicy !== 0n) || (spender && receiverPolicy !== 0n)) },
  });

  const senderAllowed = senderPolicy === 0n || ((auth.data?.[0]?.result as boolean | undefined) ?? true);
  const receiverAllowed =
    receiverPolicy === 0n ||
    ((auth.data?.[senderPolicy !== 0n ? 1 : 0]?.result as boolean | undefined) ?? true);

  /**
   * Whether a collateral transfer can be attempted at all.
   *
   * **An `approve()` that succeeds says nothing about this.** Allowance and
   * policy are different gates, and the policy one is checked inside the
   * transfer. Checking here is what turns a mystery revert into a sentence.
   */
  const blockedReason = transferPaused
    ? "The issuer has paused transfers of this token. Nothing can be locked or redeemed until that is lifted."
    : !senderAllowed
      ? "The issuer's transfer policy does not authorise your address to send this token."
      : !receiverAllowed
        ? "The issuer's transfer policy does not authorise the vault to receive this token."
        : null;

  return {
    multiplier,
    transferPaused,
    senderPolicy,
    receiverPolicy,
    policiesArmed: senderPolicy !== 0n || receiverPolicy !== 0n,
    blockedReason,
    loading: core.isLoading,
  };
}

/** Raw units → share-equivalent units, at the multiplier in force now. */
export function toShareEquivalent(raw: bigint, multiplier: bigint | null): bigint {
  if (multiplier === null) return raw;
  return (raw * multiplier) / 10n ** 18n;
}

/**
 * Raw units → share-equivalent units, named to match the B20 surface.
 * Identical to `toShareEquivalent`; prefer this name in new code.
 */
export const toScaledBalance = toShareEquivalent;

/**
 * Share-equivalent units → raw units, at the multiplier in force now.
 * The floor direction favours the issuer, so callers that need an exact raw
 * amount (an approval, a max quantity) must read `balanceOf`, not this.
 */
export function toRawBalance(scaled: bigint, multiplier: bigint | null): bigint {
  if (multiplier === null || multiplier === 0n) return scaled;
  return (scaled * 10n ** 18n) / multiplier;
}
