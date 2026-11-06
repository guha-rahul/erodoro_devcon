import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import ts from "typescript";

let snapshot = { data: [{ status: "success", result: 5n }, { status: "success", result: 2n }], isLoading: false };
let requested;
const exports = {};
const source = fs.readFileSync(new URL("../lib/use-balances.ts", import.meta.url), "utf8");
vm.runInNewContext(ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText, {
  exports,
  require(name) {
    if (name === "wagmi") return {
      useAccount: () => ({ address: `0x${"11".repeat(20)}`, chainId: 8453 }),
      useReadContracts: (options) => { requested = options; return snapshot; },
    };
    if (name === "./deployment") return { DEPLOYMENT: { chainId: 84532, contracts: { vault: `0x${"22".repeat(20)}` } } };
    if (name === "./wagmi") return { REQUIRED_CHAIN_ID: 84532 };
    if (name === "./types") return { pId: (id) => id * 2n, nId: (id) => id * 2n + 1n };
    return {};
  },
});
const read = () => exports.usePortfolioBalances([{ id: 1n }]);
assert.equal(read().rows[0].p, 5n);
assert.ok(requested.contracts.every((contract) => contract.chainId === 84532));
snapshot = { data: [{ status: "success", result: 5n }, { status: "failure" }], isLoading: false };
assert.match(read().error, /could not be read/);
assert.equal(read().rows.length, 0);
snapshot = { data: [], isLoading: false };
assert.ok(read().error);
snapshot = { isLoading: false, error: { message: "RPC unavailable" } };
assert.equal(read().error, "RPC unavailable");
snapshot = { isLoading: true };
assert.equal(read().loading, true);
assert.equal(read().error, null);
snapshot = { data: [{ status: "success", result: 0n }, { status: "success", result: 0n }], isLoading: false };
assert.equal(read().error, null);
assert.equal(read().rows[0].p, 0n);
console.log("Portfolio balance checks passed: deployment chain, partial failure, incomplete response, RPC error, loading, and true zero balances.");
