import type { Hex } from "./types";
import { publicClient } from "./chain";
import { DEPLOYMENT } from "./deployment";
import { SWAP_API } from "./swap-api";

// Browser reads use the same-origin Worker proxy. Hermes does not consistently
// allow browser CORS from custom Worker domains, while settlement callers still
// need the exact signed bytes returned by the upstream service. In `pnpm dev`
// the Worker runs on a separate port, so prefix with SWAP_API there.
const HERMES = process.env.NEXT_PUBLIC_HERMES_URL ?? `${SWAP_API}/hermes`;

export type PythPrint = {
  update: Hex;
  publishTime: number;
  price: bigint;
  conf: bigint;
  expo: number;
};

/**
 * Fetch a signed price update.
 *
 * The bytes are signed by Pyth's publishers and verified through guardian
 * signatures inside Pyth's own contract when settlement submits them. Nothing
 * here is trusted — if Hermes returns junk, the on-chain verification rejects
 * it and the transaction reverts rather than settling against a made-up price.
 */
export async function fetchPrint(feedId: Hex, minPublishTime?: bigint): Promise<PythPrint> {
  const id = feedId.replace(/^0x/, "");
  const selector = minPublishTime === undefined ? "latest" : minPublishTime.toString();
  const res = await fetch(`${HERMES}/v2/updates/price/${selector}?ids[]=${id}&encoding=hex`);
  if (!res.ok) throw new Error(`Hermes returned ${res.status}`);
  const body = await res.json();
  const parsed = body?.parsed?.[0]?.price;
  const previous = body?.parsed?.[0]?.metadata?.prev_publish_time;
  const data = body?.binary?.data?.[0];
  if (!parsed || !data) throw new Error("Hermes returned no usable print.");
  if (
    minPublishTime !== undefined &&
    (previous === undefined || BigInt(previous) >= minPublishTime || BigInt(parsed.publish_time) < minPublishTime)
  ) {
    throw new Error("Hermes did not return the first print at or after maturity.");
  }
  return {
    update: `0x${data}`,
    publishTime: Number(parsed.publish_time),
    price: BigInt(parsed.price),
    conf: BigInt(parsed.conf),
    expo: Number(parsed.expo),
  };
}

const PYTH_READ_ABI = [
  {
    type: "function",
    name: "getPriceUnsafe",
    stateMutability: "view",
    inputs: [{ name: "id", type: "bytes32" }],
    outputs: [
      {
        name: "price",
        type: "tuple",
        components: [
          { name: "price", type: "int64" },
          { name: "conf", type: "uint64" },
          { name: "expo", type: "int32" },
          { name: "publishTime", type: "uint64" },
        ],
      },
    ],
  },
] as const;

/**
 * Display prices can fall back to Pyth's latest onchain value when Hermes is
 * unavailable. The empty update is intentional: settlement still calls
 * `fetchPrint` and therefore still requires fresh, signed Hermes bytes.
 */
export async function fetchReference(feedId: Hex): Promise<PythPrint> {
  const price = await publicClient.readContract({
    address: DEPLOYMENT.external.pyth,
    abi: PYTH_READ_ABI,
    functionName: "getPriceUnsafe",
    args: [feedId],
  });
  return {
    update: "0x",
    publishTime: Number(price.publishTime),
    price: price.price,
    conf: price.conf,
    expo: price.expo,
  };
}

/** Human-readable price from a print, in dollars. */
export function printToUsd(p: PythPrint): number {
  return Number(p.price) * 10 ** p.expo;
}

/** Confidence as basis points of price — what the series' policy gates on. */
export function confBps(p: PythPrint): number {
  return p.price === 0n ? 0 : Number((p.conf * 10_000n) / p.price);
}
