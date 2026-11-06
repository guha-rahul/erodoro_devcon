import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import ts from "typescript";
const exports = {};
const source = fs.readFileSync(new URL("../lib/quote-matches.ts", import.meta.url), "utf8");
vm.runInNewContext(ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText, { exports });
const a = `0x${"11".repeat(20)}`, b = `0x${"22".repeat(20)}`;
const request = { claims: a, quoteToken: a, taker: a, claimAmount: 10n, claimId: 3n };
const quote = { ...request, claimAmount: "10", claimId: "3", quoteAmount: "5", expiry: "101" };
assert.equal(exports.quoteMatches(quote, request, 100n, 200n), true);
assert.equal(exports.quoteMatches({ ...quote, taker: `0x${"00".repeat(20)}` }, request, 100n, 200n), true);
for (const patch of [{ taker: b }, { claims: b }, { quoteToken: b }, { claimAmount: "9" }, { claimAmount: "10x" }, { claimId: "4" }, { quoteAmount: "0" }, { expiry: "100" }, { taker: null }]) {
  assert.equal(exports.quoteMatches({ ...quote, ...patch }, request, 100n, 200n), false);
}
assert.equal(exports.quoteMatches(quote, request, 0n, 200n), false);
assert.equal(exports.quoteMatches(quote, request, 100n, 100n), false);
console.log("Quote matching checks passed: public/wallet quotes, request changes, expiry, malformed data, maturity.");
