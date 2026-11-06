import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import ts from "typescript";
import * as viem from "viem";

let fetchImpl = (...args) => globalThis.fetch(...args);
const load = (file, imports) => {
  const exports = {};
  vm.runInNewContext(ts.transpileModule(fs.readFileSync(new URL(file, import.meta.url), "utf8"), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText, { exports, require: (name) => { if (!(name in imports)) throw new Error(`Unexpected import ${name}`); return imports[name]; }, Date, console, URL, fetch: (...args) => fetchImpl(...args) });
  return exports;
};

const stock = load("../lib/stock-swap.ts", { viem });
const noBatch = { canBatchAtomically: async () => false, sendAtomicBatch: async () => { throw new Error("batch not expected"); } };
const zero = load("../lib/zeroex-swap.ts", { viem, "wagmi/actions": {}, "./wagmi": { wagmiConfig: {} }, "./swap-api": { SWAP_API: "" }, "./stock-swap": stock, "./batching": noBatch });
const USDC = zero.USDC;
const token = "0x1111111111111111111111111111111111111111";
const taker = "0x2222222222222222222222222222222222222222";
const ALLOWANCE = "0x0000000000001fF3684f28c67538d4D072C22734";

// --- Amount parsing -------------------------------------------------------
assert.equal(zero.parseSwapAmount("1.0000001", 6), 0n);
for (const value of ["-1", "1e6", "NaN", "", "0", "1.2.3", "Infinity"]) assert.equal(zero.parseSwapAmount(value, 6), 0n);
assert.equal(zero.parseSwapAmount("0.00000001", 8), 1n);
assert.equal(zero.parseSwapAmount("2", 0), 2n);
assert.equal(zero.parseSwapAmount("2.1", 0), 0n);
assert.equal(zero.parseSwapAmount("2", 999), 0n);
assert.equal(zero.parseSwapAmount("9".repeat(100), 18), 0n);

// --- Roles are derived from the USDC address, not a label ------------------
const buy = zero.rolesFor("buy", token);
assert.equal(buy.sellToken, USDC);
assert.equal(buy.buyToken, token);
const sell = zero.rolesFor("sell", token);
assert.equal(sell.sellToken, token);
assert.equal(sell.buyToken, USDC);

// --- A quote is refused unless it carries a spender and calldata -----------
const request = { side: "buy", token, sellAmount: 5000000n, taker, slippageBps: 50 };
const payload = (over = {}) => ({
  liquidityAvailable: true,
  sellToken: USDC,
  buyToken: token,
  sellAmount: "5000000",
  buyAmount: "123456",
  minBuyAmount: "122000",
  allowanceTarget: ALLOWANCE,
  transaction: { to: ALLOWANCE, data: "0xdeadbeef" },
  ...over,
});
const withFetch = async (body, status = 200) => {
  fetchImpl = async () => ({ ok: status >= 200 && status < 300, status, json: async () => body });
  try {
    return await zero.fetchZeroExQuote(request, "price");
  } finally {
    fetchImpl = (...args) => globalThis.fetch(...args);
  }
};
assert.equal((await withFetch(payload())).buyAmount, 123456n);
await assert.rejects(() => withFetch(payload({ allowanceTarget: undefined })), /approval target/);
await assert.rejects(() => withFetch(payload({ transaction: { to: ALLOWANCE, data: "0x" } })), /executable transaction/);
await assert.rejects(() => withFetch(payload({ liquidityAvailable: false })), /No liquidity/);
await assert.rejects(() => withFetch({ error: "insufficient liquidity" }, 400), /insufficient liquidity/);

// --- Execution: exact approval to the returned spender, separate swap ------
let wallet, allowance, balance, receipt, active, expireDuringQuote, changeDuringRead, batchEnabled;
let sends = [], simulations = [], batches = [], quoteCalls = 0;
const actions = {
  getAccount: () => wallet,
  simulateContract: async (_, req) => { simulations.push(req); if (expireDuringQuote) wallet = { address: taker, chainId: 84532 }; return { request: req }; },
  writeContract: async (_, req) => { sends.push(req); return `0x${"ab".repeat(32)}`; },
  sendTransaction: async (_, req) => { sends.push(req); return `0x${"ab".repeat(32)}`; },
};
const batching = {
  canBatchAtomically: async () => batchEnabled,
  sendAtomicBatch: async (_, opts) => { batches.push(opts.calls); return `0x${"cd".repeat(32)}`; },
};
const zeroExec = load("../lib/zeroex-swap.ts", { viem, "wagmi/actions": actions, "./wagmi": { wagmiConfig: {} }, "./swap-api": { SWAP_API: "" }, "./stock-swap": stock, "./batching": batching });
const client = {
  getChainId: async () => 8453,
  multicall: async () => {
    if (changeDuringRead) wallet = { address: token, chainId: 8453 };
    return [balance, allowance];
  },
  call: async () => { if (actions.simulateContract) await actions.simulateContract(); return { data: "0x" }; },
  waitForTransactionReceipt: async () => ({ status: receipt }),
};
const quote = (over = {}) => ({
  buyAmount: 123456n, sellAmount: 5000000n, minBuyAmount: 122000n,
  buyToken: token, sellToken: USDC, allowanceTarget: ALLOWANCE,
  transaction: { to: ALLOWANCE, data: "0xdeadbeef" }, issues: {}, liquidityAvailable: true,
  ...over,
});
const reset = () => { wallet = { address: taker, chainId: 8453 }; allowance = 0n; balance = 10000000n; receipt = "success"; active = true; expireDuringQuote = false; changeDuringRead = false; batchEnabled = false; sends = []; simulations = []; batches = []; };
const run = (overrides = {}) => zeroExec.executeZeroExSwap({ client, account: taker, quote: quote(), isActive: () => active, progress: () => {}, ...overrides });

reset();
assert.equal((await run()).kind, "approved");
assert.equal(sends.length, 1);
assert.equal(sends[0].functionName, "approve");
assert.equal(sends[0].args[0], ALLOWANCE, "approve the returned allowance target, nothing else");
assert.equal(sends[0].args[1], 5000000n, "approve exactly the amount being swapped");
assert.equal(sends[0].chainId, 8453);
assert.equal(batches.length, 0, "no batch is sent to a wallet that does not support one");

reset(); allowance = 10000000n;
assert.equal((await run()).kind, "swapped");
assert.equal(sends[0].to, ALLOWANCE, "swap targets the 0x transaction target");
assert.equal(sends[0].data, "0xdeadbeef", "swap sends the returned calldata unchanged");

reset(); wallet.chainId = 84532; await assert.rejects(run, /Switch to Base/); assert.equal(sends.length, 0);
reset(); balance = 0n; await assert.rejects(run, /Insufficient/); assert.equal(sends.length, 0);
reset(); active = false; await assert.rejects(run, /changed/); assert.equal(sends.length, 0);
reset(); changeDuringRead = true; await assert.rejects(run, /changed/); assert.equal(sends.length, 0);
reset(); expireDuringQuote = true; await assert.rejects(run, /Switch to Base/); assert.equal(sends.length, 0);
reset(); receipt = "reverted"; await assert.rejects(run, /reverted/);
reset(); allowance = 10000000n;
const originalCall = client.call;
client.call = async () => { throw new Error("transfer policy blocked"); };
await assert.rejects(run, /policy blocked/); assert.equal(sends.length, 0);
client.call = originalCall;

// --- EIP-5792: approve and swap arrive as one atomic batch ------------------
reset(); batchEnabled = true;
assert.equal((await run()).kind, "swapped");
assert.equal(batches.length, 1, "one batch for approve + swap");
assert.equal(batches[0].length, 2);
assert.equal(batches[0][0].to, USDC, "the approval targets the sell token");
assert.equal(batches[0][0].data.slice(0, 10), viem.encodeFunctionData({ abi: viem.erc20Abi, functionName: "approve", args: [ALLOWANCE, 5000000n] }).slice(0, 10));
assert.equal(batches[0][1].to, ALLOWANCE, "the second call is the returned swap");
assert.equal(batches[0][1].data, "0xdeadbeef");
assert.equal(sends.length, 0, "no separate approval is sent");
assert.equal(simulations.length, 0, "the wallet, not the client, sequences the batch");

// A batch wallet that already has allowance still swaps without a batch.
reset(); batchEnabled = true; allowance = 10000000n;
assert.equal((await run()).kind, "swapped");
assert.equal(batches.length, 0);

// --- The executor refuses a quote without a spender before it ever signs ---
reset();
await assert.rejects(() => run({ quote: quote({ allowanceTarget: undefined }) }), /approval target/);
assert.equal(sends.length, 0);
assert.equal(batches.length, 0);

void quoteCalls;
console.log("0x swap safety checks passed: amount parsing, USDC role derivation, quote validation, exact approval to the returned allowance target, EIP-5792 approve+swap batching, separate swap with returned calldata, chain/account/expiry guards, simulation, and reverted receipts.");
