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
    },
  );
  return exports;
};

const finality = load("../lib/finality.ts", {});
const HASH = `0x${"ab".repeat(32)}`;
const snap = (over = {}) => ({ hash: HASH, submittedAt: 0, ...over });

// --- Stage by stage, from broadcast to finality -----------------------------
assert.equal(finality.classifyFinality(snap()), "submitted");
assert.equal(finality.classifyFinality(snap({ seenInMempool: true })), "preconfirmed");
assert.equal(
  finality.classifyFinality(snap({ receipt: { blockNumber: 100n, status: "success" }, latestBlock: 100n })),
  "included",
);
assert.equal(
  finality.classifyFinality(snap({ receipt: { blockNumber: 100n, status: "success" }, latestBlock: 101n })),
  "confirmed",
);
assert.equal(
  finality.classifyFinality(snap({ receipt: { blockNumber: 100n, status: "success" }, latestBlock: 200n, finalizedBlock: 100n })),
  "finalized",
);
// Finality outranks confirmation depth.
assert.equal(
  finality.classifyFinality(snap({ receipt: { blockNumber: 100n, status: "success" }, latestBlock: 200n, finalizedBlock: 150n })),
  "finalized",
);

// --- A revert is terminal and the only stage that may be resubmitted --------
const reverted = snap({ receipt: { blockNumber: 100n, status: "reverted" }, latestBlock: 200n, finalizedBlock: 200n });
assert.equal(finality.classifyFinality(reverted), "reverted");
assert.equal(finality.finalityCopy("reverted").canResubmit, true);

// --- No sudden success: intermediate stages are pending and not resubmittable
for (const state of ["submitted", "preconfirmed", "included", "confirmed"]) {
  const copy = finality.finalityCopy(state);
  assert.equal(copy.tone, "pending", state);
  assert.equal(copy.canResubmit, false, state);
  assert.ok(copy.label.length > 0);
}
assert.equal(finality.finalityCopy("finalized").tone, "ok");
assert.equal(finality.finalityCopy("finalized").canResubmit, false);

console.log("Finality checks passed: submitted→preconfirmed→included→confirmed→finalized from canonical blocks, terminal reverts, and no stage that permits a double submit.");
