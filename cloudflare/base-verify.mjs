/**
 * Base Verify — selective use.
 *
 * A verified trait is only accepted for the purposes it declares. The two
 * Sybil/one-person traits below are usable for reward-once and faucet
 * anti-Sybil; they are **not** evidence of trading eligibility or jurisdiction,
 * so a request that asks for those purposes is refused rather than silently
 * reinterpreted. That refusal is the whole point of this module.
 *
 * The attestation is an EIP-712 message signed by the configured Base Verify
 * verifier. The subject is stable, so `nullifierFor` gives one claim key per
 * (trait, subject) without storing the trait value anywhere.
 */

import { encodePacked, keccak256, recoverTypedDataAddress } from "viem";

export const TRAIT_TYPES = {
  TraitAttestation: [
    { name: "subject", type: "address" },
    { name: "trait", type: "string" },
    { name: "value", type: "string" },
    { name: "issuedAt", type: "uint256" },
    { name: "expiresAt", type: "uint256" },
    { name: "nonce", type: "bytes32" },
  ],
};

export const PURPOSES = ["sybil-resistance", "reward-once", "trading-eligibility", "kyc"];

/**
 * Supported traits and the purposes each may serve. A trait that does not list
 * a purpose must never be used for it.
 */
export const TRAIT_POLICIES = {
  "base-verified-account": {
    label: "Base Verified Account",
    purposes: ["sybil-resistance", "reward-once"],
  },
  "coinbase-verified": {
    label: "Coinbase Verified",
    purposes: ["sybil-resistance", "reward-once"],
  },
};

const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const UINT = /^(0|[1-9][0-9]*)$/;

/** Whether a trait is allowed to serve a purpose. Unknown traits allow nothing. */
export function traitAllowed(trait, purpose) {
  if (!PURPOSES.includes(purpose)) return false;
  const policy = TRAIT_POLICIES[trait];
  return Boolean(policy && policy.purposes.includes(purpose));
}

/** One stable claim key per trait and subject. */
export function nullifierFor(trait, subject) {
  return keccak256(encodePacked(["string", "address"], [trait, subject]));
}

/**
 * Validate an attestation for a specific purpose. Returns a sentence on the
 * first problem, or null when it is valid.
 */
export function validateTraitRequest(body, now = Math.floor(Date.now() / 1000)) {
  if (!body || typeof body !== "object") return "Malformed attestation.";
  if (!ADDRESS.test(body.verifier ?? "")) return "verifier must be an address.";
  if (!ADDRESS.test(body.message?.subject ?? "")) return "subject must be an address.";
  if (typeof body.message?.trait !== "string" || !TRAIT_POLICIES[body.message.trait]) {
    return "Unsupported trait.";
  }
  if (!UINT.test(String(body.message?.issuedAt ?? "")) || !UINT.test(String(body.message?.expiresAt ?? ""))) {
    return "issuedAt and expiresAt must be unix seconds.";
  }
  if (!UINT.test(String(body.message?.nonce ?? "")) && !/^0x[0-9a-fA-F]{64}$/.test(body.message?.nonce ?? "")) {
    return "nonce must be 32 bytes.";
  }
  if (typeof body.signature !== "string" || !/^0x[0-9a-fA-F]+$/.test(body.signature)) {
    return "signature is missing.";
  }
  const issuedAt = Number(body.message.issuedAt);
  const expiresAt = Number(body.message.expiresAt);
  if (issuedAt > now) return "The attestation is not valid yet.";
  if (expiresAt <= now) return "The attestation has expired.";
  if (!traitAllowed(body.message.trait, body.purpose)) {
    return `The ${body.message.trait} trait cannot be used for ${body.purpose ?? "that purpose"}.`;
  }
  return null;
}

/**
 * Verify a signed attestation. Returns `{ ok, nullifier }` or `{ ok: false,
 * error }`; it never throws on bad input.
 */
export async function verifyTraitAttestation(body, options = {}) {
  const now = options.now ?? Math.floor(Date.now() / 1000);
  const invalid = validateTraitRequest(body, now);
  if (invalid) return { ok: false, error: invalid };

  let recovered;
  try {
    recovered = await recoverTypedDataAddress({
      domain: {
        name: "Erodoro Base Verify",
        version: "1",
        chainId: options.chainId ?? 8453,
        verifyingContract: body.verifier,
      },
      types: TRAIT_TYPES,
      primaryType: "TraitAttestation",
      message: {
        subject: body.message.subject,
        trait: body.message.trait,
        value: String(body.message.value ?? ""),
        issuedAt: BigInt(body.message.issuedAt),
        expiresAt: BigInt(body.message.expiresAt),
        nonce: body.message.nonce,
      },
      signature: body.signature,
    });
  } catch {
    return { ok: false, error: "The attestation signature is malformed." };
  }

  if (recovered.toLowerCase() !== body.verifier.toLowerCase()) {
    return { ok: false, error: "The attestation was not signed by the verifier." };
  }

  return {
    ok: true,
    trait: body.message.trait,
    purpose: body.purpose,
    nullifier: nullifierFor(body.message.trait, body.message.subject),
  };
}

/**
 * Handle a verification request for the Worker. `env.VERIFY_ALLOW_KYC` must be
 * exactly "1" before any trait may serve trading-eligibility or KYC, so the
 * default deployment cannot silently repurpose a Sybil trait.
 */
export async function handleVerify(request, env = {}, deps = {}) {
  if (request.method !== "POST") return { status: 405, body: { error: "Use POST." } };

  let body;
  try {
    body = await request.json();
  } catch {
    return { status: 400, body: { error: "Expected JSON." } };
  }

  if ((body.purpose === "kyc" || body.purpose === "trading-eligibility") && env.VERIFY_ALLOW_KYC !== "1") {
    return { status: 403, body: { error: "This trait cannot be used for eligibility or KYC.", verified: false } };
  }

  const result = await verifyTraitAttestation(body, { now: deps.now, chainId: deps.chainId });
  if (!result.ok) return { status: 403, body: { error: result.error, verified: false } };
  return { status: 200, body: { verified: true, trait: result.trait, purpose: result.purpose, nullifier: result.nullifier } };
}
