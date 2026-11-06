import test from "node:test";
import assert from "node:assert/strict";
import { replaySnapshot } from "./reward-replay.mjs";
const a = `0x${"11".repeat(20)}`, b = `0x${"22".repeat(20)}`;
function snapshot() {
  return { schema: "erodoro-accounting-input/v1", chainId: "84532", vault: a, rfq: b, start: "100", end: "200", fromBlock: "10", toBlock: "20", toBlockHash: `0x${"ab".repeat(32)}`,
    claims: [{ claimId: "2", openingBalances: [[a, "10"]], transfers: [{ block: "15", logIndex: 0, timestamp: "150", from: a, to: b, amount: "4" }] }],
    fills: [{ block: "16", logIndex: 0, timestamp: "160", maker: b, taker: a, quoteToken: a, quoteAmount: "1000000" }],
  };
}
test("snapshot replay preserves exact arithmetic and provenance", () => {
  const source = JSON.stringify(snapshot());
  const result = replaySnapshot(source);
  assert.deepEqual(result, replaySnapshot(source));
  assert.equal(result.ownership[0].rows[0].balanceSeconds, "800");
  assert.equal(result.fillVolumes.length, 2);
  assert.equal(result.pointsActive, false);
  assert.match(result.provenance, /Unverified/);
  assert.notEqual(result.inputSha256, replaySnapshot(`${source}\n`).inputSha256);
});
test("replay rejects imprecise inputs and invalid coverage", () => {
  for (const change of [
    (s) => { s.chainId = 84532; },
    (s) => { s.fills[0].block = "21"; },
    (s) => { s.fills[0].timestamp = "200"; },
    (s) => { s.claims.push(s.claims[0]); },
    (s) => { s.toBlockHash = ""; },
  ]) { const s = snapshot(); change(s); assert.throws(() => replaySnapshot(JSON.stringify(s))); }
});
test("optional loyalty has explicit policy and observation coverage", () => {
  const s = snapshot();
  assert.equal(replaySnapshot(JSON.stringify(s)).loyalty, null);
  s.loyalty = { policyId: "test-only-policy", asOf: "190", schedule: [{ id: "expiry-a", maturity: "150" }], milestones: [2], completions: [{ wallet: a, expiryId: "expiry-a" }] };
  const result = replaySnapshot(JSON.stringify(s));
  assert.equal(result.loyalty.rows[0].completedExpiries, 1);
  assert.equal(result.loyalty.rows[0].expiriesToNext, 1);
  assert.match(result.loyalty.provenance, /not verified/);
  s.loyalty.asOf = "200";
  assert.throws(() => replaySnapshot(JSON.stringify(s)), /outside/);
});
