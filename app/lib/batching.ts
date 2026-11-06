import { getCapabilities, sendCalls, waitForCallsStatus } from "wagmi/actions";
import type { Config } from "wagmi";
import { builderCodeSuffix } from "./builder-code";
import { requestSponsorship } from "./paymaster";
import type { Address, Hex } from "./types";

/**
 * EIP-5792 atomic batching.
 *
 * A wallet that answers `wallet_getCapabilities` with `atomic.status` of
 * `supported` or `ready` can put an approval and the action it enables into one
 * confirmation. Everything here is capability-gated: a wallet that does not
 * support it still signs, one transaction at a time, through the existing path.
 * Nothing in this module moves a user off the wallet they chose.
 */

export type BatchCall = { to: Address; data: Hex; value?: bigint; dataSuffix?: Hex };

/**
 * Read `wallet_getCapabilities` for one chain. Unknown or unsupported both mean
 * "do not batch" — the caller falls back rather than guessing.
 */
export function atomicBatchSupported(capabilities: unknown, chainId: number): boolean {
  if (!capabilities || typeof capabilities !== "object") return false;
  const scoped =
    (capabilities as Record<string | number, unknown>)[chainId] ??
    (capabilities as Record<string, unknown>)[String(chainId)];
  if (!scoped || typeof scoped !== "object") return false;
  const atomic = (scoped as { atomic?: { status?: string } }).atomic;
  return atomic?.status === "supported" || atomic?.status === "ready";
}

/** Append the ERC-8021 attribution suffix to each call when configured. */
function attributedCalls(calls: BatchCall[]): BatchCall[] {
  const suffix = builderCodeSuffix();
  if (!suffix) return calls;
  return calls.map((call) => ({ ...call, dataSuffix: suffix }));
}

/** A single read used by the write hooks, outside React. Never throws. */
export async function canBatchAtomically(
  config: Config,
  account: Address,
  chainId: number,
): Promise<boolean> {
  try {
    const capabilities = await getCapabilities(config, { account, chainId });
    return atomicBatchSupported(capabilities, chainId);
  } catch {
    return false;
  }
}

/**
 * Send a batch and wait for it to land. `forceAtomic: true` tells the wallet to
 * reject the bundle rather than fall back to sequential execution — a partial
 * result would leave an approval with nothing attached, which is exactly the
 * state this exists to avoid.
 *
 * `sponsor` asks the Worker whether these exact calls may be gas-sponsored. A
 * refusal only means the user pays; it never blocks the transaction.
 */
export async function sendAtomicBatch(
  config: Config,
  options: { account: Address; chainId: number; calls: BatchCall[]; sponsor?: boolean },
): Promise<Hex> {
  let capabilities: { paymasterService: { url: string } } | undefined;
  if (options.sponsor) {
    const service = await requestSponsorship({
      chainId: options.chainId,
      account: options.account,
      calls: options.calls,
    });
    if (service) capabilities = { paymasterService: { url: service.url } };
  }

  const { id } = await sendCalls(config, {
    account: options.account,
    chainId: options.chainId,
    calls: attributedCalls(options.calls),
    forceAtomic: true,
    capabilities,
  });
  const { receipts, status } = await waitForCallsStatus(config, {
    id,
    timeout: 180_000,
    throwOnFailure: true,
  });
  if (status !== "success") throw new Error("The batched transaction failed. Nothing was confirmed.");
  const hash = receipts?.at(-1)?.transactionHash;
  if (!hash) throw new Error("The wallet confirmed the batch without a transaction hash.");
  return hash as Hex;
}
