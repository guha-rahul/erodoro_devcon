import { createPublicClient, http } from "viem";
import { base, baseSepolia } from "viem/chains";
import { ACTIVE_CHAIN_ID, BASE_SEPOLIA, rpcUrlFor } from "./deployment";

/**
 * The read client.
 *
 * Reads go straight to a public RPC for now. That is fine for a handful of
 * series and will not stay fine — the markets table costs several calls per
 * series, and a public endpoint rate-limits. Routing reads through the Worker
 * with a private key is tracked in `todo.md`.
 */
export const CHAIN = ACTIVE_CHAIN_ID === base.id ? base : baseSepolia;

/**
 * Reads go through the app's own `/rpc/<chain>` route in the browser, so the endpoint
 * key stays server-side and the rate limit is ours to manage. During the build
 * there is no origin to call, so it falls back to a direct endpoint. In `pnpm
 * dev` the Worker shim runs on a separate port (see `SWAP_API`), so the
 * browser must use an absolute URL there; in production the Worker serves the
 * app and `/rpc` from the same origin.
 */
const RPC_URL = rpcUrlFor(ACTIVE_CHAIN_ID);

// Public Base endpoints allow ~25 requests/second and count each batched call.
// Multicall3 folds concurrent contract reads into one eth_call; smaller JSON-RPC
// batches keep the remaining calls (blocks, logs, receipts) under that limit.
export const publicClient = createPublicClient({
  chain: CHAIN,
  batch: { multicall: true },
  transport: http(RPC_URL, { batch: { batchSize: 10 } }),
});

export const CHAIN_ID = ACTIVE_CHAIN_ID || BASE_SEPOLIA.chainId;

/**
 * Check that the read endpoint serves the chain this build was compiled for.
 *
 * `ACTIVE_CHAIN_ID` is baked in at build time, but whatever answers `/rpc` is
 * Worker configuration (`PUBLIC_RPC_URL`), and the two are set in different
 * places. A mainnet build served by a Worker still pointed at Sepolia renders
 * testnet state while the wallet signs against mainnet, and nothing else in the
 * app compares them. Resolves to a message on mismatch, or null when they
 * agree.
 */
let rpcChainCheck: Promise<string | null> | null = null;

export function rpcChainMismatch(): Promise<string | null> {
  rpcChainCheck ??= publicClient
    .getChainId()
    .then((served) =>
      served === CHAIN_ID
        ? null
        : `The data endpoint is serving chain ${served}, but this build expects ${CHAIN_ID} (${CHAIN.name}). Refusing to sign while reads and signatures disagree.`,
    )
    .catch(() => {
      // An unreachable endpoint is surfaced by the reads themselves. Do not
      // cache a transient failure as an all-clear.
      rpcChainCheck = null;
      return null;
    });
  return rpcChainCheck;
}
