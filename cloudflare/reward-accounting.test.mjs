import test from "node:test";
import assert from "node:assert/strict";
import { balanceSeconds, weightedPoints, fillVolumes } from "./reward-accounting.mjs";
const a = `0x${"11".repeat(20)}`, b = `0x${"22".repeat(20)}`, zero = `0x${"00".repeat(20)}`;
const transfer = (from, to, amount, timestamp, logIndex = 0) => ({ from, to, amount, timestamp, block: timestamp, logIndex });
const run = (transfers, openingBalances = [[a, 10n]]) => balanceSeconds({ start: 100n, end: 200n, openingBalances, transfers });
test("ownership time follows transfers and conserves total unit-seconds", () => {
  const rows = run([transfer(a, b, 4n, 150n)]);
  assert.deepEqual(rows, [{ owner: a, balance: 6n, balanceSeconds: 800n }, { owner: b, balance: 4n, balanceSeconds: 200n }]);
});
test("same-block mint and burn accrue no time", () => {
  assert.deepEqual(run([transfer(zero, a, 10n, 120n), transfer(a, zero, 10n, 120n, 1)], []), [{ owner: a, balance: 0n, balanceSeconds: 0n }]);
});
test("duplicate and self transfers cannot inflate time", () => {
  const event = transfer(a, a, 10n, 150n);
  assert.deepEqual(run([event, event]), run([]));
});
test("missing history, conflicting logs, and out-of-window inputs fail", () => {
  assert.throws(() => run([transfer(a, b, 11n, 150n)]), /Incomplete/);
  assert.throws(() => run([transfer(a, b, 1n, 150n), transfer(a, b, 2n, 150n)]), /Conflicting/);
  assert.throws(() => run([transfer(a, b, 1n, 200n)]), /outside/);
});
test("weights use exact integer arithmetic without implicit economics", () => {
  assert.equal(weightedPoints(10n ** 30n, { numerator: 3n, denominator: 4n }), 75n * 10n ** 28n);
  assert.equal(weightedPoints(1n, { numerator: 1n, denominator: 4n }), 0n);
  assert.throws(() => weightedPoints(1n, { numerator: 1n, denominator: 0n }), /Zero/);
});
test("fill inputs exclude self-fills, deduplicate, and retain token and role attribution", () => {
  const fill = { block: 1n, logIndex: 0, maker: a, taker: b, quoteToken: a, quoteAmount: 17n };
  const rows = fillVolumes([fill, fill, { ...fill, logIndex: 1, taker: a }]);
  assert.equal(rows.length, 2);
  assert.deepEqual(rows.find((row) => row.owner === a), { owner: a, token: a, role: "buyer", premium: 17n, fills: 1n });
  assert.equal(fillVolumes([fill, { ...fill, logIndex: 2, quoteToken: b }]).length, 4);
  assert.throws(() => fillVolumes([fill, { ...fill, quoteAmount: 18n }]), /Conflicting/);
});
