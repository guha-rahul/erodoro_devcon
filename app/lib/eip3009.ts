"use client";

import { parseSignature, type Address, type Hex } from "viem";
import { signTypedData } from "wagmi/actions";
import { wagmiConfig } from "./wagmi";

/**
 * EIP-3009 authorizations for auction bids.
 *
 * The bidder signs an exact-amount `ReceiveWithAuthorization` for the quote
 * token; the auction house captures it and escrows the funds in the same
 * transaction. Because EIP-3009 does not reserve the signer's balance, a
 * signature on its own is never money — the app must submit it, and the
 * contract records a bid only when the transfer is included and succeeds.
 *
 * Every attempt uses a fresh random nonce and a short validity window, so a
 * leaked or replayed authorization cannot outlive the auction it was signed for.
 */

export const RECEIVE_AUTHORIZATION_TYPES = {
  ReceiveWithAuthorization: [
    { name: "from", type: "address" },
    { name: "to", type: "address" },
    { name: "value", type: "uint256" },
    { name: "validAfter", type: "uint256" },
    { name: "validBefore", type: "uint256" },
    { name: "nonce", type: "bytes32" },
  ],
} as const;

/** USDC signs EIP-3009 with domain version "2"; the test stand-in mirrors it. */
export const EIP3009_VERSION = "2";
export const AUTHORIZATION_SKEW_SECONDS = 60;
export const AUTHORIZATION_WINDOW_SECONDS = 300;

/** 32 random bytes. A nonce must never repeat across attempts. */
export function randomAuthorizationNonce(): Hex {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return `0x${Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("")}` as Hex;
}

/**
 * A bounded window around `nowSeconds`: a little slack for clock drift, and a
 * short life so an unused authorization cannot be replayed later.
 */
export function authorizationWindow(
  nowSeconds: number,
  skew = AUTHORIZATION_SKEW_SECONDS,
  window = AUTHORIZATION_WINDOW_SECONDS,
): { validAfter: bigint; validBefore: bigint } {
  return {
    validAfter: BigInt(Math.max(0, Math.floor(nowSeconds - skew))),
    validBefore: BigInt(Math.floor(nowSeconds + window)),
  };
}

export type AuthorizationSignature = {
  validAfter: bigint;
  validBefore: bigint;
  nonce: Hex;
  v: number;
  r: Hex;
  s: Hex;
};

export async function signReceiveAuthorization(options: {
  token: Address;
  /** The token's EIP-712 name, read from `name()` on the token. */
  tokenName: string;
  chainId: number;
  from: Address;
  to: Address;
  value: bigint;
  validAfter: bigint;
  validBefore: bigint;
  nonce: Hex;
}): Promise<AuthorizationSignature> {
  const signature = await signTypedData(wagmiConfig, {
    domain: {
      name: options.tokenName,
      version: EIP3009_VERSION,
      chainId: options.chainId,
      verifyingContract: options.token,
    },
    types: RECEIVE_AUTHORIZATION_TYPES,
    primaryType: "ReceiveWithAuthorization",
    message: {
      from: options.from,
      to: options.to,
      value: options.value,
      validAfter: options.validAfter,
      validBefore: options.validBefore,
      nonce: options.nonce,
    },
  });
  const parsed = parseSignature(signature);
  // Normalise the v value: viem reports `yParity` for 64-byte signatures.
  const v = Number(parsed.v ?? BigInt(parsed.yParity + 27));
  return {
    validAfter: options.validAfter,
    validBefore: options.validBefore,
    nonce: options.nonce,
    v,
    r: parsed.r,
    s: parsed.s,
  };
}
