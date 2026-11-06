import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import ts from "typescript";
import * as viem from "viem";

let signed = [];
let signImpl = async (_config, args) => {
  signed.push(args);
  return `0x${"11".repeat(32)}${"22".repeat(32)}1b`;
};

const load = (file, imports) => {
  const exports = {};
  vm.runInNewContext(
    ts.transpileModule(fs.readFileSync(new URL(file, import.meta.url), "utf8"), {
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
    }).outputText,
    {
      exports,
      require: (name) => {
        if (!(name in imports)) throw new Error(`Unexpected import ${name}`);
        return imports[name];
      },
      Date,
      console,
      crypto: globalThis.crypto,
    },
  );
  return exports;
};

const eip3009 = load("../lib/eip3009.ts", {
  viem,
  "wagmi/actions": { signTypedData: (...args) => signImpl(...args) },
  "./wagmi": { wagmiConfig: {} },
});

const TOKEN = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const FROM = "0x1111111111111111111111111111111111111111";
const TO = "0x2222222222222222222222222222222222222222";

// --- Nonces are 32 bytes and never repeat ----------------------------------
const nonceA = eip3009.randomAuthorizationNonce();
const nonceB = eip3009.randomAuthorizationNonce();
assert.match(nonceA, /^0x[0-9a-f]{64}$/);
assert.notEqual(nonceA, nonceB);

// --- The window is bounded and starts before "now" -------------------------
const window = eip3009.authorizationWindow(1000);
assert.equal(window.validAfter, 940n);
assert.equal(window.validBefore, 1300n);
assert.equal(eip3009.authorizationWindow(10, 60, 300).validAfter, 0n, "never negative");

// --- The signature carries the exact USDC domain and message ---------------
signed = [];
const result = await eip3009.signReceiveAuthorization({
  token: TOKEN,
  tokenName: "Test USD",
  chainId: 84532,
  from: FROM,
  to: TO,
  value: 50_000_000n,
  validAfter: 940n,
  validBefore: 1300n,
  nonce: nonceA,
});
assert.equal(signed.length, 1);
assert.equal(signed[0].domain.name, "Test USD");
assert.equal(signed[0].domain.version, eip3009.EIP3009_VERSION);
assert.equal(signed[0].domain.chainId, 84532);
assert.equal(signed[0].domain.verifyingContract, TOKEN);
assert.equal(signed[0].primaryType, "ReceiveWithAuthorization");
assert.equal(
  signed[0].types.ReceiveWithAuthorization.map((field) => `${field.name}:${field.type}`).join(","),
  "from:address,to:address,value:uint256,validAfter:uint256,validBefore:uint256,nonce:bytes32",
);
assert.equal(signed[0].message.from, FROM);
assert.equal(signed[0].message.to, TO);
assert.equal(signed[0].message.value, 50_000_000n);
assert.equal(signed[0].message.nonce, nonceA);
// Parsed for the contract's (v, r, s) argument list.
assert.equal(result.v, 27);
assert.equal(result.r, `0x${"11".repeat(32)}`);
assert.equal(result.s, `0x${"22".repeat(32)}`);
assert.equal(result.nonce, nonceA);
assert.equal(result.validBefore, 1300n);

// --- A rejected signature propagates, it is not silently swallowed ---------
signImpl = async () => {
  throw new Error("User rejected request");
};
await assert.rejects(
  () =>
    eip3009.signReceiveAuthorization({
      token: TOKEN,
      tokenName: "Test USD",
      chainId: 84532,
      from: FROM,
      to: TO,
      value: 1n,
      validAfter: 0n,
      validBefore: 1n,
      nonce: nonceB,
    }),
  /User rejected/,
);

console.log("EIP-3009 signing checks passed: fresh 32-byte nonces, bounded validity window, exact USDC ReceiveWithAuthorization domain/message, parsed v/r/s, and rejection propagation.");
