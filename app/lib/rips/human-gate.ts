import { formatUnits, zeroAddress, type Address } from "viem";
import { HumanRegistryAbi } from "../abis/HumanRegistry";
import { MarketRipPoolAbi } from "../abis/MarketRipPool";
import { publicClient } from "../chain";
import { NOT_VERIFIED_MESSAGE } from "./human-errors";

/**
 * Why the World ID gate would refuse a purchase costing `costRaw` USDC, or null if it wouldn't (or the pool has no
 * gate). Checked before any approval, so the buyer learns their exact allowance instead of a failed transaction.
 */
export async function humanGateRefusal(pool: Address, buyer: Address, costRaw: bigint): Promise<string | null> {
  const gate = await publicClient.readContract({ address: pool, abi: MarketRipPoolAbi, functionName: "humanGate" }).catch(() => zeroAddress);
  if (gate === zeroAddress) return null;
  const [verified, batchId] = await Promise.all([
    publicClient.readContract({ address: gate, abi: HumanRegistryAbi, functionName: "isVerified", args: [buyer] }),
    publicClient.readContract({ address: pool, abi: MarketRipPoolAbi, functionName: "activeBatchId" }),
  ]);
  if (!verified) return NOT_VERIFIED_MESSAGE;
  const remaining = await publicClient.readContract({ address: gate, abi: HumanRegistryAbi, functionName: "remainingSpend", args: [buyer, pool, batchId] });
  if (remaining >= costRaw) return null;
  const rips = remaining / 1_000_000n;
  if (rips === 0n) return "You've used your allowance for this batch. Nothing was charged.";
  return `You have $${formatUnits(remaining, 6)} left this batch. Choose ${rips} Rip${rips === 1n ? "" : "s"} or fewer.`;
}
