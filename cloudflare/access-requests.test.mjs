import assert from "node:assert/strict";
import test from "node:test";
import {
  AccessRequestCapacityError,
  MAX_ACCESS_REQUESTS,
  normalizeXUsername,
  storeAccessRequest,
} from "./access-requests.mjs";

test("normalizes X usernames without changing their display case", () => {
  assert.deepEqual(normalizeXUsername("@ErodoroFi"), { display: "ErodoroFi", key: "erodorofi" });
  assert.deepEqual(normalizeXUsername("user_123"), { display: "user_123", key: "user_123" });
  assert.equal(normalizeXUsername("two words"), null);
  assert.equal(normalizeXUsername("abcdefghijklmnop"), null);
});

test("stores a normalized request in D1", async () => {
  const calls = [];
  const statement = {
    bind: (...values) => { calls.push({ kind: "bind", values }); return statement; },
    run: async () => { calls.push({ kind: "run" }); return { meta: { changes: 1 } }; },
  };
  const db = {
    exec: async (sql) => calls.push({ kind: "exec", sql }),
    prepare: (sql) => { calls.push({ kind: "prepare", sql }); return statement; },
  };

  const result = await storeAccessRequest(db, "@ErodoroFi", 1234);
  assert.deepEqual(result, { display: "ErodoroFi", key: "erodorofi" });
  assert.deepEqual(calls.find((call) => call.kind === "bind")?.values, ["erodorofi", "ErodoroFi", 1234]);
  assert.match(calls.find((call) => call.kind === "prepare")?.sql, new RegExp(`< ${MAX_ACCESS_REQUESTS}`));
  assert.equal(calls.at(-1)?.kind, "run");
});

test("rejects a new username when the capacity guard inserts nothing", async () => {
  const statement = { bind: () => statement, run: async () => ({ meta: { changes: 0 } }) };
  const db = { exec: async () => {}, prepare: () => statement };
  await assert.rejects(
    () => storeAccessRequest(db, "new_user", 1234),
    (error) => error instanceof AccessRequestCapacityError,
  );
});
