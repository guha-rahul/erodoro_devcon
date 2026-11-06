"use client";

import { encodeAbiParameters, encodeFunctionData, encodePacked, erc20Abi, parseAbi, zeroAddress, type Address, type PublicClient } from "viem";
import { SWAP_CHAIN, USDC } from "./stock-swap";
import type { ZeroExQuote } from "./zeroex-swap";

/**
 * Stock swaps routed straight through Aerodrome's Slipstream pools on Base.
 *
 * 0x refuses the largest Coinbase stock tokens ("not authorized for trade due
 * to legal restrictions"); their USDC liquidity sits in Aerodrome pools from
 * the third Slipstream factory. Addresses are Aerodrome's own, from
 * velodrome-finance/sugar-sdk (sugar/config.py, Base) and sugar
 * deployments/base.env. The encoding follows that SDK: a mixed-route path whose
 * tick spacing carries the factory bitmask, executed as one V3_SWAP_EXACT_IN
 * command on Aerodrome's Universal Router.
 *
 * The result has the same shape as a 0x quote, so the screen and
 * `executeZeroExSwap` (exact-amount approval, simulation, atomic batching) are
 * unchanged: the approval target is Aerodrome's swapper, the transaction its
 * `execute` call.
 */
export const AERODROME = {
  factory: "0xf8f2eB4940CFE7d13603DDDD87f123820Fc061Ef" as Address,
  factoryBitmask: 0x080000,
  quoter: "0xCd2A7D98e82D6107eac1828ce8DeAA6acB65b555" as Address,
  swapper: "0xcAF22ce31298CF2BF1D152862F80216478ad7c67" as Address,
};
const TICK_SPACINGS = [1, 10, 50, 100, 200, 2000] as const;
const V3_SWAP_EXACT_IN = "0x00";
const DEADLINE_SECONDS = 600n;

const FACTORY_ABI = parseAbi(["function getPool(address,address,int24) view returns (address)"]);
const POOL_ABI = parseAbi(["function fee() view returns (uint24)"]);
const QUOTER_ABI = parseAbi(["function quoteExactInput(bytes path, uint256 amountIn) returns (uint256 amountOut, uint160[] sqrtPriceX96AfterList, uint32[] initializedTicksCrossedList, uint256 gasEstimate)"]);
const SWAPPER_ABI = parseAbi(["function execute(bytes commands, bytes[] inputs, uint256 deadline) payable"]);

export type AerodromePool = { address: Address; tickSpacing: number; feePips: number; usdcDepth: bigint };

const pools = new Map<string, Promise<AerodromePool | null>>();

/** The stock's deepest USDC pool in Aerodrome's current Slipstream factory, or null. */
export function findPool(client: PublicClient, token: Address): Promise<AerodromePool | null> {
  const key = token.toLowerCase();
  const hit = pools.get(key);
  if (hit) return hit;
  const found = (async () => {
    const addresses = await client.multicall({ allowFailure: true, contracts: TICK_SPACINGS.map((ts) => ({ address: AERODROME.factory, abi: FACTORY_ABI, functionName: "getPool", args: [USDC, token, ts] } as const)) });
    const candidates = TICK_SPACINGS.map((ts, i) => ({ ts, pool: addresses[i].status === "success" ? addresses[i].result as Address : zeroAddress })).filter((c) => c.pool !== zeroAddress);
    if (!candidates.length) return null;
    const depth = await client.multicall({ allowFailure: false, contracts: candidates.map((c) => ({ address: USDC, abi: erc20Abi, functionName: "balanceOf", args: [c.pool] } as const)) }) as bigint[];
    const best = candidates.map((c, i) => ({ ...c, depth: depth[i] })).sort((a, b) => (b.depth > a.depth ? 1 : b.depth < a.depth ? -1 : 0))[0];
    const feePips = await client.readContract({ address: best.pool, abi: POOL_ABI, functionName: "fee" });
    return { address: best.pool, tickSpacing: best.ts, feePips, usdcDepth: best.depth };
  })().catch((error) => { pools.delete(key); throw error; });
  pools.set(key, found);
  return found;
}

const pathFor = (tokenIn: Address, tickSpacing: number, tokenOut: Address) =>
  encodePacked(["address", "uint24", "address"], [tokenIn, tickSpacing | AERODROME.factoryBitmask, tokenOut]);

export type AerodromeQuote = ZeroExQuote & { pool: AerodromePool };

/**
 * An executable quote: the quoter's exact output for this amount, a minimum
 * after slippage, and Aerodrome swapper calldata that pays `taker` directly.
 * Built fresh before every signature, so its deadline and minimum are current.
 */
export async function fetchAerodromeQuote(client: PublicClient, request: { side: "buy" | "sell"; token: Address; sellAmount: bigint; taker: Address; slippageBps: number }): Promise<AerodromeQuote> {
  if ((await client.getChainId()) !== SWAP_CHAIN) throw new Error("Read provider is not Base mainnet");
  const pool = await findPool(client, request.token);
  if (!pool) throw new Error("No Aerodrome pool for this stock yet.");
  const [sellToken, buyToken] = request.side === "buy" ? [USDC, request.token] : [request.token, USDC];
  const path = pathFor(sellToken, pool.tickSpacing, buyToken);
  let buyAmount: bigint;
  try {
    const { result } = await client.simulateContract({ address: AERODROME.quoter, abi: QUOTER_ABI, functionName: "quoteExactInput", args: [path, request.sellAmount] });
    buyAmount = result[0];
  } catch {
    throw new Error("Aerodrome cannot fill this amount. Try a smaller trade.");
  }
  if (buyAmount === 0n) throw new Error("Aerodrome cannot fill this amount. Try a smaller trade.");
  const minBuyAmount = buyAmount * BigInt(10_000 - request.slippageBps) / 10_000n;
  const recipient = request.taker === zeroAddress ? AERODROME.swapper : request.taker;
  const input = encodeAbiParameters(
    [{ type: "address" }, { type: "uint256" }, { type: "uint256" }, { type: "bytes" }, { type: "bool" }, { type: "bool" }],
    [recipient, request.sellAmount, minBuyAmount, path, true, false],
  );
  const now = (await client.getBlock()).timestamp;
  const data = encodeFunctionData({ abi: SWAPPER_ABI, functionName: "execute", args: [V3_SWAP_EXACT_IN, [input], now + DEADLINE_SECONDS] });
  const [balance, allowance] = request.taker === zeroAddress ? [undefined, undefined] : await client.multicall({ allowFailure: false, contracts: [
    { address: sellToken, abi: erc20Abi, functionName: "balanceOf", args: [request.taker] },
    { address: sellToken, abi: erc20Abi, functionName: "allowance", args: [request.taker, AERODROME.swapper] },
  ] }) as [bigint, bigint];
  return {
    buyAmount, sellAmount: request.sellAmount, minBuyAmount, buyToken, sellToken,
    allowanceTarget: AERODROME.swapper,
    transaction: { to: AERODROME.swapper, data },
    issues: {
      ...(allowance !== undefined && allowance < request.sellAmount ? { allowance: { spender: AERODROME.swapper, actual: allowance.toString(), expected: request.sellAmount.toString() } } : {}),
      ...(balance !== undefined && balance < request.sellAmount ? { balance: { token: sellToken, actual: balance.toString(), expected: request.sellAmount.toString() } } : {}),
    },
    liquidityAvailable: true,
    pool,
  };
}
