import { encodeAbiParameters, parseAbi, parseAbiParameters, type Address, type Hex } from "viem";

/**
 * Rips resale on Uniswap v4 (Base Sepolia). Each position's upside claim is wrapped 1:1 as an ERC-20
 * (ClaimWrapper) and pooled against test USDC. The pool's hook (RipsResaleHook) lets only World ID verified
 * humans swap. Swaps call Universal Router directly, with quotes from V4Quoter.
 */
export type ResalePool = {
  /** RipsResaleHook, shared by every resale pool. */
  hook: Address;
  claimId: string;
  seriesId: string;
  wrapper: Address;
  currency0: Address;
  currency1: Address;
  /** House quote at listing: raw claim units per 1 USDC. */
  unitsPerDollar: string;
};
export type ResaleSide = "sell" | "buy";

const FEE = 3000;
const TICK_SPACING = 60;
const POOL_KEY = [
  { name: "currency0", type: "address" },
  { name: "currency1", type: "address" },
  { name: "fee", type: "uint24" },
  { name: "tickSpacing", type: "int24" },
  { name: "hooks", type: "address" },
] as const;
// Universal Router 2.0's single-pool exact-input swap.
const EXACT_IN_SINGLE = [{
  type: "tuple",
  components: [
    { name: "poolKey", type: "tuple", components: POOL_KEY },
    { name: "zeroForOne", type: "bool" },
    { name: "amountIn", type: "uint128" },
    { name: "amountOutMinimum", type: "uint128" },
    { name: "hookData", type: "bytes" },
  ],
}] as const;

export const universalRouterAbi = parseAbi(["function execute(bytes commands, bytes[] inputs, uint256 deadline) payable"]);
export const permit2Abi = parseAbi([
  "function approve(address token, address spender, uint160 amount, uint48 expiration)",
  "function allowance(address owner, address token, address spender) view returns (uint160 amount, uint48 expiration, uint48 nonce)",
]);
export const v4QuoterAbi = parseAbi([
  "struct PoolKey { address currency0; address currency1; uint24 fee; int24 tickSpacing; address hooks; }",
  "struct QuoteExactSingleParams { PoolKey poolKey; bool zeroForOne; uint128 exactAmount; bytes hookData; }",
  "function quoteExactInputSingle(QuoteExactSingleParams params) returns (uint256 amountOut, uint256 gasEstimate)",
]);

export function poolKey(p: ResalePool) {
  return { currency0: p.currency0, currency1: p.currency1, fee: FEE, tickSpacing: TICK_SPACING, hooks: p.hook };
}

/** Selling the claim pays in the wrapped claim; buying pays in USDC. */
export function zeroForOne(p: ResalePool, side: ResaleSide) {
  const tokenIn = side === "sell" ? p.wrapper : (p.currency0 === p.wrapper ? p.currency1 : p.currency0);
  return tokenIn.toLowerCase() === p.currency0.toLowerCase();
}

export function buildSwap(p: ResalePool, side: ResaleSide, amountIn: bigint, minOut: bigint): { commands: Hex; inputs: Hex[] } {
  const key = poolKey(p);
  const usdc = p.currency0 === p.wrapper ? p.currency1 : p.currency0;
  const [currencyIn, currencyOut] = side === "sell" ? [p.wrapper, usdc] : [usdc, p.wrapper];
  const swap = encodeAbiParameters(EXACT_IN_SINGLE, [{ poolKey: key, zeroForOne: zeroForOne(p, side), amountIn, amountOutMinimum: minOut, hookData: "0x" }]);
  const settleAll = encodeAbiParameters(parseAbiParameters("address, uint256"), [currencyIn, amountIn]);
  const takeAll = encodeAbiParameters(parseAbiParameters("address, uint256"), [currencyOut, minOut]);
  // V4_SWAP with SWAP_EXACT_IN_SINGLE, SETTLE_ALL, TAKE_ALL
  const input = encodeAbiParameters(parseAbiParameters("bytes, bytes[]"), ["0x060c0f", [swap, settleAll, takeAll]]);
  return { commands: "0x10", inputs: [input] };
}
