import type { PublicClient } from "viem";
import type { Hex } from "./types";

/**
 * Transaction finality on Base.
 *
 * The stages mirror what a user actually waits for, and are derived from
 * canonical block inclusion — never from Flashblocks, which are planned for
 * deprecation. Each stage has one sentence of copy and a single "is another
 * submit allowed" answer, so the UI cannot jump from "submitted" to "done".
 */

export type FinalityState = "submitted" | "preconfirmed" | "included" | "confirmed" | "finalized" | "reverted";

/** Confirmations before a transaction is treated as safe to act on. */
export const CONFIRMATION_DEPTH = 1;

export type TxStatusSnapshot = {
  hash: Hex;
  submittedAt: number;
  /** The RPC reports the hash in its pending pool (not a Base preconfirmation). */
  seenInMempool?: boolean;
  receipt?: { blockNumber: bigint; status: "success" | "reverted" };
  latestBlock?: bigint;
  /** The node's canonical `finalized` block tag. */
  finalizedBlock?: bigint;
};

/** The chain reads the status needs. One implementation, swappable in tests. */
export interface StatusProvider {
  latestBlock(): Promise<bigint>;
  finalizedBlock(): Promise<bigint>;
  receipt(hash: Hex): Promise<{ blockNumber: bigint; status: "success" | "reverted" } | null>;
  pending(hash: Hex): Promise<boolean>;
}

/**
 * Classify a snapshot. Order matters: a revert is terminal, then finality is
 * walked from the strongest signal down.
 */
export function classifyFinality(snapshot: TxStatusSnapshot): FinalityState {
  const { receipt, latestBlock, finalizedBlock } = snapshot;
  if (receipt?.status === "reverted") return "reverted";
  if (!receipt) {
    return snapshot.seenInMempool ? "preconfirmed" : "submitted";
  }
  if (finalizedBlock !== undefined && finalizedBlock >= receipt.blockNumber) return "finalized";
  if (latestBlock !== undefined) {
    const confirmations = latestBlock >= receipt.blockNumber ? latestBlock - receipt.blockNumber + 1n : 0n;
    if (confirmations >= BigInt(CONFIRMATION_DEPTH) + 1n) return "confirmed";
  }
  return "included";
}

export type FinalityCopy = {
  label: string;
  tone: "pending" | "ok" | "danger";
  /** False once another submit would duplicate the transaction. */
  canResubmit: boolean;
};

export function finalityCopy(state: FinalityState): FinalityCopy {
  switch (state) {
    case "submitted":
      return { label: "Submitted to the network…", tone: "pending", canResubmit: false };
    case "preconfirmed":
      return { label: "Seen by the network…", tone: "pending", canResubmit: false };
    case "included":
      return { label: "Included in a block…", tone: "pending", canResubmit: false };
    case "confirmed":
      return { label: "Confirmed.", tone: "pending", canResubmit: false };
    case "finalized":
      return { label: "Finalized.", tone: "ok", canResubmit: false };
    case "reverted":
      return { label: "The transaction reverted.", tone: "danger", canResubmit: true };
  }
}

/**
 * Read the canonical chain for one hash. Uses standard RPC only: the `finalized`
 * block tag, the receipt's block, and the pending pool. Nothing here depends on
 * Flashblocks or any preconfirmation feed.
 */
export function createChainStatusProvider(client: PublicClient): StatusProvider {
  return {
    latestBlock: () => client.getBlockNumber(),
    finalizedBlock: async () => {
      try {
        const block = await client.getBlock({ blockTag: "finalized" });
        return block.number ?? 0n;
      } catch {
        return 0n;
      }
    },
    receipt: async (hash) => {
      try {
        const receipt = await client.getTransactionReceipt({ hash });
        if (!receipt) return null;
        return { blockNumber: receipt.blockNumber, status: receipt.status };
      } catch {
        return null;
      }
    },
    pending: async (hash) => {
      const tx = await client.getTransaction({ hash }).catch(() => null);
      return Boolean(tx) && tx?.blockNumber === null;
    },
  };
}

/** One snapshot from a provider. `null` fields mean "not known yet". */
export async function readSnapshot(
  provider: StatusProvider,
  hash: Hex,
  submittedAt: number,
): Promise<TxStatusSnapshot> {
  const [receipt, latestBlock, finalizedBlock, pending] = await Promise.all([
    provider.receipt(hash),
    provider.latestBlock().catch(() => undefined),
    provider.finalizedBlock().catch(() => undefined),
    provider.pending(hash).catch(() => false),
  ]);
  return { hash, submittedAt, receipt: receipt ?? undefined, latestBlock, finalizedBlock, seenInMempool: pending };
}
