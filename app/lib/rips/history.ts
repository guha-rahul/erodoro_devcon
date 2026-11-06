import { parseAbiItem, decodeFunctionData, formatUnits, type Address } from "viem";
import { publicClient } from "../chain";
import { BUILD_CHAIN_ID, DEPLOYMENT } from "../deployment";
import { MarketRipPoolAbi } from "../abis";
import type { RipFill } from "./model";

const event = parseAbiItem("event RipPurchased(address indexed buyer, uint256 indexed batchId, uint256 indexed positionId, address claims, uint256 claimId, uint256 units, uint256 usdcPaid, bytes32 quoteRef)");
type RawPurchase = { positionId: bigint; units: bigint; cost: bigint; at: number; hash: `0x${string}`; kind: "rip" | "buy" };
const caches = new Map<string, { through: bigint; rows: RawPurchase[] }>();
const scans = new Map<string, Promise<RawPurchase[]>>();

/** Incrementally scan real logs. Costs and holdings still come from contract getters. */
export async function loadHistory(pool: Address, owner: Address) {
  // Defaults to the committed Sepolia v4 pool's deploy block (see deployment.ts).
  // The deploy-block override, like the pool override, belongs to the build's chain only.
  const configured = (DEPLOYMENT.chainId === BUILD_CHAIN_ID ? process.env.NEXT_PUBLIC_RIP_DEPLOY_BLOCK : undefined)
    ?? (DEPLOYMENT.chainId === 84532 && !(BUILD_CHAIN_ID === 84532 && process.env.NEXT_PUBLIC_RIP_POOL_ADDRESS) ? "53089693" : undefined);
  if (!configured || !/^\d+$/.test(configured)) return [];
  const key = `${DEPLOYMENT.chainId}:${pool}:${owner}`.toLowerCase();
  const pending = scans.get(key);
  if (pending) return pending;
  const scan = scanHistory(key, pool, owner, BigInt(configured));
  scans.set(key, scan);
  try { return await scan; } finally { if (scans.get(key) === scan) scans.delete(key); }
}

async function scanHistory(key: string, pool: Address, owner: Address, start: bigint) {
  const cached = caches.get(key) ?? { through: start - 1n, rows: [] };
  const head = await publicClient.getBlockNumber();
  let cursor = cached.through + 1n;
  // Bound each refresh, so long histories never stall wallet balances or the UI.
  for (let page = 0; cursor <= head && page < 20; page++) {
    // The public Base Sepolia endpoint limits eth_getLogs to 200 blocks.
    const end = cursor + 199n < head ? cursor + 199n : head;
    const logs = await publicClient.getLogs({ address: pool, event, args: { buyer: owner }, fromBlock: cursor, toBlock: end });
    const found = await Promise.all(logs.map(async log => {
      if (!log.transactionHash || log.blockNumber === null || log.args.positionId === undefined || log.args.units === undefined || log.args.usdcPaid === undefined) return null;
      const [block, tx] = await Promise.all([publicClient.getBlock({ blockNumber: log.blockNumber }), publicClient.getTransaction({ hash: log.transactionHash })]);
      let kind: "rip" | "buy" = "buy";
      try { const input = decodeFunctionData({ abi: MarketRipPoolAbi, data: tx.input }); if (input.functionName === "ripUp" || input.functionName === "ripPack" || input.functionName === "rip") kind = "rip"; } catch { /* Label as purchase if mode cannot be decoded. */ }
      return { positionId: log.args.positionId, units: log.args.units, cost: log.args.usdcPaid, at: Number(block.timestamp) * 1000, hash: log.transactionHash, kind };
    }));
    cached.rows.push(...found.filter((p): p is RawPurchase => p !== null));
    cached.through = end; caches.set(key, cached); cursor = end + 1n;
  }
  return cached.rows;
}
export function fillsFor(rows: RawPurchase[], positionId: bigint, unitDecimals: number): RipFill[] {
  return rows.filter(r => r.positionId === positionId).map(r => ({ kind: r.kind, qty: Number(formatUnits(r.units, unitDecimals)), paid: Number(formatUnits(r.cost, 6)), at: r.at, signature: r.hash }));
}
