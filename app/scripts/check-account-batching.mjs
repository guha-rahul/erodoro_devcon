import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import ts from "typescript";

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
      fetch: (...args) => sponsorFetch(...args),
    },
  );
  return exports;
};

let sponsorFetch = async () => ({ ok: false, status: 503, json: async () => ({}) });

// --- Capability parsing -----------------------------------------------------
let capabilities = {};
let sent = [];
let statusResult = { status: "success", receipts: [{ transactionHash: `0x${"ab".repeat(32)}` }] };
const actions = {
  getCapabilities: async () => capabilities,
  sendCalls: async (_, options) => {
    sent.push(options);
    return { id: "0x1" };
  },
  waitForCallsStatus: async () => statusResult,
};
const batching = load("../lib/batching.ts", {
  "wagmi/actions": actions,
  "./paymaster": load("../lib/paymaster.ts", { "./swap-api": { SWAP_API: "" } }),
  "./builder-code": { builderCodeSuffix: () => null },
});

assert.equal(batching.atomicBatchSupported({ 8453: { atomic: { status: "supported" } } }, 8453), true);
assert.equal(batching.atomicBatchSupported({ 8453: { atomic: { status: "ready" } } }, 8453), true);
assert.equal(batching.atomicBatchSupported({ 8453: { atomic: { status: "unsupported" } } }, 8453), false);
assert.equal(batching.atomicBatchSupported({ "8453": { atomic: { status: "supported" } } }, 8453), true);
assert.equal(batching.atomicBatchSupported({ 84532: { atomic: { status: "supported" } } }, 8453), false);
assert.equal(batching.atomicBatchSupported({}, 8453), false);
assert.equal(batching.atomicBatchSupported(null, 8453), false);
assert.equal(batching.atomicBatchSupported({ 8453: {} }, 8453), false);

// --- A capability read that throws is "do not batch", never a crash ---------
assert.equal(await batching.canBatchAtomically({}, "0x11", 8453), false);
capabilities = { 8453: { atomic: { status: "supported" } } };
assert.equal(await batching.canBatchAtomically({}, "0x11", 8453), true);
actions.getCapabilities = async () => {
  throw new Error("wallet_getCapabilities unsupported");
};
assert.equal(await batching.canBatchAtomically({}, "0x11", 8453), false);

// --- The batch is forced atomic and waits for a receipt ---------------------
sent = [];
const calls = [
  { to: `0x${"22".repeat(20)}`, data: "0xdeadbeef" },
  { to: `0x${"33".repeat(20)}`, data: "0xcafe", value: 1n },
];
const hash = await batching.sendAtomicBatch({}, { account: `0x${"11".repeat(20)}`, chainId: 8453, calls });
assert.equal(hash, `0x${"ab".repeat(32)}`);
assert.equal(sent.length, 1);
assert.equal(sent[0].forceAtomic, true, "the wallet must not fall back to sequential execution");
assert.equal(sent[0].calls.length, 2);
assert.equal(sent[0].chainId, 8453);

// A failed bundle never reports a hash.
statusResult = { status: "failure", receipts: [] };
await assert.rejects(
  () => batching.sendAtomicBatch({}, { account: `0x${"11".repeat(20)}`, chainId: 8453, calls }),
  /batched transaction failed/,
);

// --- Sponsorship is attached only when the Worker approves, never assumed ----
statusResult = { status: "success", receipts: [{ transactionHash: `0x${"ab".repeat(32)}` }] };
sent = [];
sponsorFetch = async () => ({ ok: true, status: 200, json: async () => ({ sponsored: true, paymasterService: { url: "https://pm.test/rpc" } }) });
await batching.sendAtomicBatch({}, { account: `0x${"11".repeat(20)}`, chainId: 8453, calls, sponsor: true });
assert.equal(sent[0].capabilities.paymasterService.url, "https://pm.test/rpc");

sent = [];
sponsorFetch = async () => ({ ok: false, status: 403, json: async () => ({ error: "not sponsored", sponsored: false }) });
await batching.sendAtomicBatch({}, { account: `0x${"11".repeat(20)}`, chainId: 8453, calls, sponsor: true });
assert.equal(sent[0].capabilities, undefined, "a refused sponsorship still sends, user-paid");
assert.equal(sent[0].forceAtomic, true);

sent = [];
sponsorFetch = async () => {
  throw new Error("paymaster offline");
};
await batching.sendAtomicBatch({}, { account: `0x${"11".repeat(20)}`, chainId: 8453, calls, sponsor: true });
assert.equal(sent[0].capabilities, undefined, "an unreachable paymaster never blocks the send");

// --- Spend permissions are offered only on the Base Account connector -------
const spend = load("../lib/spend-permission.ts", {});
assert.equal(spend.isBaseAccountConnector({ id: "baseAccount" }), true);
assert.equal(spend.isBaseAccountConnector({ id: "injected" }), false);
assert.equal(spend.isBaseAccountConnector(undefined), false);

console.log("Base Account batching checks passed: EIP-5792 capability parsing, safe fallback on unsupported/erroring capabilities, forced-atomic batch send, failure reporting, and Base Account-only spend permissions.");
