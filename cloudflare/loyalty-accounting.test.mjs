import test from "node:test";
import assert from "node:assert/strict";
import { loyaltyProgress } from "./loyalty-accounting.mjs";
const wallet = `0x${"ab".repeat(20)}`;
const schedule = [100n, 200n, 300n, 400n].map((maturity, i) => ({ id: String(i), maturity }));
const run = (ids, asOf = 350n) => loyaltyProgress({ schedule, asOf, completions: ids.map((expiryId) => ({ wallet, expiryId })), milestones: [2, 4] })[0];
test("distinct completed expiries advance milestones", () => {
  assert.deepEqual(run(["0", "1", "1", "2"]), { wallet, completedExpiries: 3, currentStreak: 3, longestStreak: 3, reachedMilestones: [2], nextMilestone: 4, expiriesToNext: 1 });
});
test("a missed elapsed expiry resets the current streak without deleting history", () => {
  const result = run(["0", "1"]);
  assert.equal(result.completedExpiries, 2);
  assert.equal(result.currentStreak, 0);
  assert.equal(result.longestStreak, 2);
});
test("future expiries neither advance nor break a streak", () => {
  const result = run(["0", "1", "2", "3"], 200n);
  assert.equal(result.currentStreak, 2);
  assert.equal(result.completedExpiries, 2);
});
test("unknown expiry and invalid policy inputs fail", () => {
  assert.throws(() => run(["unknown"]), /outside/);
  assert.throws(() => loyaltyProgress({ schedule: [schedule[0], schedule[0]], asOf: 200n, completions: [], milestones: [] }), /Duplicate/);
  assert.throws(() => loyaltyProgress({ schedule, asOf: 200n, completions: [], milestones: [4, 2] }), /increase/);
});
