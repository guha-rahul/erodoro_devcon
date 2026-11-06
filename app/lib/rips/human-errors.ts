import { BaseError, decodeErrorResult, parseAbi, type Hex } from "viem";

/**
 * Refusals from the World ID gate, explained.
 *
 * The Rips pool asks HumanRegistry before every sale, and the Uniswap resale hook asks it before every swap.
 * Their errors are not in the pool's or the router's ABI, so without this the user sees "execution reverted".
 */
const HUMAN_ERRORS = parseAbi([
  "error NotVerified(address buyer)",
  "error HumanCapReached(address buyer, uint256 remaining)",
  "error NotVerifiedHuman(address user)",
  // Uniswap v4's PoolManager wraps a hook's revert in this.
  "error WrappedError(address target, bytes4 selector, bytes reason, bytes details)",
]);

export const NOT_VERIFIED_MESSAGE = "Verify with World ID first. Nothing was charged.";

function decoded(cause: unknown) {
  if (!(cause instanceof BaseError)) return null;
  const hexes: Hex[] = [];
  cause.walk((e) => {
    for (const value of [(e as { data?: unknown }).data, (e as { raw?: unknown }).raw]) {
      if (typeof value === "string" && /^0x[0-9a-fA-F]{8,}$/.test(value)) hexes.push(value as Hex);
    }
    return false;
  });
  for (let data of hexes) {
    try {
      let error = decodeErrorResult({ abi: HUMAN_ERRORS, data });
      while (error.errorName === "WrappedError") {
        data = error.args[2] as Hex;
        error = decodeErrorResult({ abi: HUMAN_ERRORS, data });
      }
      return error;
    } catch { /* Not a World ID gate error. */ }
  }
  return null;
}

/** A plain sentence when the World ID gate refused, else null. */
export function humanRevertMessage(cause: unknown): string | null {
  const text = cause instanceof Error ? cause.message : String(cause);
  const error = decoded(cause);
  const name = error?.errorName ?? /\b(NotVerifiedHuman|NotVerified|HumanCapReached)\b/.exec(text)?.[1];
  if (name === "NotVerified" || name === "NotVerifiedHuman")
    return NOT_VERIFIED_MESSAGE;
  // The error's remaining amount is measured partway through a multi-pack purchase that then reverts in full,
  // so point at the allowance shown above instead of quoting it.
  if (name === "HumanCapReached")
    return "Over your per-person limit for this batch. Nothing was charged.";
  return null;
}
