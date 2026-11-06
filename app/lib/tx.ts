import type { Hex } from "./types";
import { explorer, txExplorer } from "./deployment";

/**
 * What a transaction is doing right now.
 *
 * The phases mirror what a wallet actually makes a user wait for: building the
 * call, approving it, and waiting for inclusion. There is no "expired" state —
 * a transaction here is replaced or dropped rather than expiring against a
 * blockhash, and a UI that claims otherwise is describing a different chain.
 */
export type SendPhase = "preparing" | "approval" | "confirming" | "submitted";

export type SendState =
  | { kind: "idle" }
  | { kind: "sending"; phase: SendPhase; hash?: Hex }
  | { kind: "ok"; hash: Hex }
  | { kind: "cancelled"; message: string }
  | { kind: "error"; message: string };

export function sendPhaseLabel(phase: SendPhase): string {
  if (phase === "preparing") return "Checking the transaction…";
  if (phase === "approval") return "Approve in your wallet…";
  if (phase === "confirming") return "Confirming…";
  return "Submitted…";
}

export function txUrl(hash: string): string {
  return txExplorer(hash);
}

export function addressUrl(address: string): string {
  return explorer(address);
}
