import { Attribution } from "ox/erc8021";
import type { Hex } from "./types";

/**
 * ERC-8021 transaction attribution (Base Builder Codes).
 *
 * A short data suffix is appended to transaction calldata so Base can attribute
 * activity to Erodoro. The code is deployment config, not a secret: register it
 * on base.dev and set `NEXT_PUBLIC_BUILDER_CODE` (comma-separated for multiple
 * codes). When it is unset nothing is appended — an invented or malformed code
 * would misattribute traffic, so absence is the only safe default.
 */

export const BUILDER_CODE_ENV = "NEXT_PUBLIC_BUILDER_CODE";

/** Codes are lowercase identifiers; anything else is dropped, not guessed. */
export function parseBuilderCodes(value: string | undefined | null): string[] {
  if (typeof value !== "string") return [];
  return value
    .split(",")
    .map((code) => code.trim())
    .filter((code) => /^[a-z0-9_-]{1,64}$/.test(code));
}

/**
 * The suffix to append to every attributed call, or null when no code is
 * configured. Memoised because the suffix is build-time constant.
 */
export function builderCodeSuffix(value: string | undefined = process.env.NEXT_PUBLIC_BUILDER_CODE): Hex | null {
  const codes = parseBuilderCodes(value);
  if (codes.length === 0) return null;
  return Attribution.toDataSuffix({ codes }) as Hex;
}
