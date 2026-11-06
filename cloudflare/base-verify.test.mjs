import test from "node:test";
import assert from "node:assert/strict";
import { privateKeyToAccount } from "viem/accounts";
import {
  handleVerify,
  nullifierFor,
  traitAllowed,
  validateTraitRequest,
  verifyTraitAttestation,
} from "./base-verify.mjs";

const verifier = privateKeyToAccount(`0x${"11".repeat(32)}`);
const other = privateKeyToAccount(`0x${"22".repeat(32)}`);
const subject = "0x1111111111111111111111111111111111111111";
const NOW = 1_700_000_000;
const NONCE = `0x${"ab".repeat(32)}`;

const message = (over = {}) => ({
  subject,
  trait: "base-verified-account",
  value: "true",
  issuedAt: NOW - 60,
  expiresAt: NOW + 3600,
  nonce: NONCE,
  ...over,
});

const attestation = async (purpose, over = {}, signer = verifier) => {
  const msg = message(over);
  const signature = await signer.signTypedData({
    domain: { name: "Erodoro Base Verify", version: "1", chainId: 8453, verifyingContract: verifier.address },
    types: {
      TraitAttestation: [
        { name: "subject", type: "address" },
        { name: "trait", type: "string" },
        { name: "value", type: "string" },
        { name: "issuedAt", type: "uint256" },
        { name: "expiresAt", type: "uint256" },
        { name: "nonce", type: "bytes32" },
      ],
    },
    primaryType: "TraitAttestation",
    message: {
      subject: msg.subject,
      trait: msg.trait,
      value: msg.value,
      issuedAt: BigInt(msg.issuedAt),
      expiresAt: BigInt(msg.expiresAt),
      nonce: msg.nonce,
    },
  });
  return { verifier: verifier.address, purpose, message: msg, signature };
};

test("a trait only serves the purposes it declares", () => {
  assert.equal(traitAllowed("base-verified-account", "sybil-resistance"), true);
  assert.equal(traitAllowed("base-verified-account", "reward-once"), true);
  assert.equal(traitAllowed("base-verified-account", "trading-eligibility"), false);
  assert.equal(traitAllowed("base-verified-account", "kyc"), false);
  assert.equal(traitAllowed("unknown-trait", "reward-once"), false);
  assert.equal(traitAllowed("base-verified-account", "not-a-purpose"), false);
});

test("nullifiers are stable per trait and subject", () => {
  assert.equal(nullifierFor("base-verified-account", subject), nullifierFor("base-verified-account", subject));
  assert.notEqual(nullifierFor("base-verified-account", subject), nullifierFor("coinbase-verified", subject));
  assert.match(nullifierFor("base-verified-account", subject), /^0x[0-9a-f]{64}$/);
});

test("request validation rejects unknown, expired and malformed attestations", () => {
  const base = { verifier: verifier.address, purpose: "reward-once", message: message(), signature: "0xdead" };
  assert.equal(validateTraitRequest(base, NOW), null);
  assert.match(validateTraitRequest({ ...base, message: message({ trait: "sneaky-trait" }) }, NOW), /Unsupported trait/);
  assert.match(validateTraitRequest({ ...base, message: message({ expiresAt: NOW - 1 }) }, NOW), /expired/);
  assert.match(validateTraitRequest({ ...base, message: message({ issuedAt: NOW + 60 }) }, NOW), /not valid yet/);
  assert.match(validateTraitRequest({ ...base, purpose: "kyc" }, NOW), /cannot be used/);
  assert.match(validateTraitRequest({ ...base, verifier: "nope" }, NOW), /verifier/);
  assert.match(validateTraitRequest({ ...base, signature: "" }, NOW), /signature/);
});

test("a valid attestation verifies and a forged one does not", async () => {
  const good = await attestation("reward-once");
  const verified = await verifyTraitAttestation(good, { now: NOW });
  assert.equal(verified.ok, true);
  assert.equal(verified.trait, "base-verified-account");
  assert.equal(verified.nullifier, nullifierFor("base-verified-account", subject));

  const forged = await attestation("reward-once", {}, other);
  const refused = await verifyTraitAttestation(forged, { now: NOW });
  assert.equal(refused.ok, false);
  assert.match(refused.error, /not signed by the verifier/);
});

test("the Worker route refuses KYC uses and only returns a nullifier when valid", async () => {
  const post = (payload) =>
    new Request("https://example.test/api/verify/trait", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
    });

  const good = await attestation("reward-once");
  const ok = await handleVerify(post(good), {}, { now: NOW, chainId: 8453 });
  assert.equal(ok.status, 200);
  assert.equal(ok.body.verified, true);
  assert.equal(ok.body.trait, "base-verified-account");

  // A Sybil trait may never be repurposed for eligibility, even if someone asks.
  const kycish = await attestation("kyc");
  const refused = await handleVerify(post(kycish), {}, { now: NOW, chainId: 8453 });
  assert.equal(refused.status, 403);
  assert.equal(refused.body.verified, false);

  // Explicit opt-in still cannot make a Sybil trait serve KYC.
  const stillRefused = await handleVerify(post(kycish), { VERIFY_ALLOW_KYC: "1" }, { now: NOW, chainId: 8453 });
  assert.equal(stillRefused.status, 403);

  const wrongMethod = await handleVerify(new Request("https://example.test/api/verify/trait"), {});
  assert.equal(wrongMethod.status, 405);
});
