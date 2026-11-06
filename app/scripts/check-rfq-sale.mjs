import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import ts from "typescript";
import * as viem from "viem";
const source = fs.readFileSync(new URL("../lib/use-rfq.ts", import.meta.url), "utf8");
const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
const account = `0x${"11".repeat(20)}`;
const signed = { signature: "0x00", quote: { maker: account, taker: account, claims: account, claimId: "3", claimAmount: "1", quoteToken: account, quoteAmount: "1", expiry: "9999999999", nonce: "1" } };
async function scenario(options = {}) {
  const writes = [], states = [];
  let checks = 0;
  const exports = {};
  vm.runInNewContext(compiled, { exports, require(name) {
    if (name === "react") return { useCallback: (fn) => fn, useState: (initial) => [initial, (value) => states.push(value)] };
    if (name === "wagmi") return { useAccount: () => ({ address: account, chainId: 84532 }), useConfig: () => ({}), useWriteContract: () => ({ writeContractAsync: async (call) => { writes.push(call.functionName); return call.functionName; } }) };
    if (name === "wagmi/actions") return {
      getAccount: () => ({ address: account, chainId: options.changedChain ? 8453 : 84532 }),
      readContract: async (_, { functionName }) => functionName === "isOperator" ? Boolean(options.operator) : [++checks === 1 || !options.expired, "Expired quote"],
      waitForTransactionReceipt: async (_, { hash }) => ({ status: (hash === "setOperator" && options.approvalReverted) || (hash === "fill" && options.fillReverted) ? "reverted" : "success" }),
    };
    if (name === "./deployment") return { DEPLOYMENT: { contracts: { rfq: account, vault: account } } };
    if (name === "./wagmi") return { REQUIRED_CHAIN_ID: 84532 };
    if (name === "viem") return { ...viem, encodeFunctionData: () => "0x" };
    if (name === "./batching") return { canBatchAtomically: async () => Boolean(options.batch), sendAtomicBatch: async () => "batched" };
    return {};
  } });
  const result = await exports.useRfq().sell(signed);
  return { result, writes, states, checks };
}
const success = await scenario();
assert.deepEqual(success.writes, ["setOperator", "fill"]);
assert.equal(success.checks, 2);
assert.equal(success.states.at(-1).kind, "ok");
for (const options of [{ expired: true }, { approvalReverted: true }, { changedChain: true }]) {
  const result = await scenario(options);
  assert.equal(result.result, null);
  assert.deepEqual(result.writes, ["setOperator"]);
  assert.equal(result.states.at(-1).kind, "error");
}
const reverted = await scenario({ operator: true, fillReverted: true });
assert.equal(reverted.result, null);
assert.equal(reverted.states.at(-1).kind, "error");
const batched = await scenario({ batch: true });
assert.equal(batched.result, "batched");
assert.deepEqual(batched.writes, [], "an EIP-5792 wallet sends setOperator + fill as one batch");
assert.equal(batched.states.at(-1).kind, "ok");
console.log("RFQ sale checks passed: approval recheck, expired quote, reverted approval/fill, network change, EIP-5792 batching, successful fill.");
