import test from "node:test";
import assert from "node:assert/strict";
import { indexFills } from "./index-rfq.mjs";
const rfq = `0x${"11".repeat(20)}`;
const hash = `0x${"ab".repeat(32)}`;
const scope = { chainId: 84532, rfq, fromBlock: 100n, toBlock: 2200n };
function rpc() {
  const ranges = [];
  return { ranges, getChainId: async () => 84532,
    getBlock: async ({ blockNumber }) => ({ hash, timestamp: blockNumber * 2n }),
    getContractEvents: async ({ fromBlock, toBlock }) => { ranges.push([fromBlock, toBlock]); return fromBlock === 100n ? [{ removed: false, blockNumber: 101n, blockHash: hash, transactionHash: hash, logIndex: 0, args: { maker: rfq, taker: rfq, claimId: 3n, claimAmount: 10n, quoteToken: rfq, quoteAmount: 7n, nonce: 1n } }] : []; },
  };
}
test("bounded scan resumes without recounting previous fills", async () => {
  const client = rpc();
  const first = await indexFills(client, scope);
  assert.deepEqual(client.ranges, [[100n, 2099n], [2100n, 2200n]]);
  assert.equal(first.events[0].quoteAmount, "7");
  client.ranges.length = 0;
  const next = await indexFills(client, { ...scope, toBlock: 2300n }, first);
  assert.deepEqual(client.ranges, [[2201n, 2300n]]);
  assert.equal(next.events.length, 1);
});
test("rejects wrong chain, mismatched scope, and changed checkpoints", async () => {
  const client = rpc();
  const index = await indexFills(client, scope);
  await assert.rejects(indexFills({ ...client, getChainId: async () => 1 }, scope), /chain/);
  await assert.rejects(indexFills(client, { ...scope, fromBlock: 99n }, index), /scope/);
  await assert.rejects(indexFills({ ...client, getBlock: async () => ({ hash: "changed" }) }, scope, index), /Checkpoint/);
});
test("rejects a log whose block hash no longer matches", async () => {
  const client = rpc();
  await assert.rejects(indexFills({ ...client, getBlock: async ({ blockNumber }) => ({ hash: blockNumber === 101n ? "changed" : hash, timestamp: 1n }) }, scope), /Log block/);
});
