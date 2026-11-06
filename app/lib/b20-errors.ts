import { BaseError, decodeErrorResult, parseAbi, type Hex } from "viem";

/**
 * The stock token's own refusals, explained.
 *
 * A B20 stock can refuse a transfer inside any call that moves it (deposit,
 * redeem, swap, return unsold). The outer contract's ABI does not know these
 * errors, so without this the user sees "execution reverted". Base's B20 docs
 * name the three to expect: a policy denial and the two pause paths.
 */
const B20_ERRORS = parseAbi([
  "error PolicyForbids(bytes32 policyScope, uint64 policyId)",
  "error ContractPaused(uint8 feature)",
  "error EnforcedPause()",
]);

const MESSAGES: Record<string, string> = {
  PolicyForbids: "The stock's issuer does not allow this wallet to send or receive it (its eligibility policy). Nothing moved. Check your eligibility with the issuer.",
  ContractPaused: "The stock's issuer has paused transfers of this token. Nothing moved. Try again once the issuer lifts the pause.",
  EnforcedPause: "The stock's issuer has paused transfers of this token. Nothing moved. Try again once the issuer lifts the pause.",
};

/** Revert data anywhere in a viem error chain, decoded against the B20 errors. */
function decodedName(cause: unknown): string | null {
  if (!(cause instanceof BaseError)) return null;
  const hexes: Hex[] = [];
  cause.walk((e) => {
    for (const value of [(e as { data?: unknown }).data, (e as { raw?: unknown }).raw]) {
      if (typeof value === "string" && /^0x[0-9a-fA-F]{8,}$/.test(value)) hexes.push(value as Hex);
    }
    return false;
  });
  for (const data of hexes) {
    try { return decodeErrorResult({ abi: B20_ERRORS, data }).errorName; } catch { /* Not a B20 error. */ }
  }
  return null;
}

/** A plain sentence when a B20 stock refused the transfer, else null. */
export function b20RevertMessage(cause: unknown): string | null {
  const text = cause instanceof Error ? cause.message : String(cause);
  const named = /\b(PolicyForbids|ContractPaused|EnforcedPause)\b/.exec(text)?.[1] ?? decodedName(cause);
  return named ? MESSAGES[named] : null;
}
