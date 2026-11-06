import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import ts from "typescript";

/**
 * Megapot integration checks.
 *
 * Two layers, both real: the pure ticket math (what a premium buys) and the
 * purchase state machine (approve when short, then buy; refuse anything that
 * is not Base mainnet). The hook talks to a wallet and a chain, so it is
 * transpiled and run against stubbed react/wagmi modules rather than a chain.
 */
function compile(relative) {
  const source = fs.readFileSync(new URL(relative, import.meta.url), "utf8");
  return ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
}

const ZERO32 = `0x${"00".repeat(32)}`;
const account = `0x${"11".repeat(20)}`;
const USDC = `0x${"22".repeat(20)}`;
const BUYER = `0x${"33".repeat(20)}`;

// --- pure ticket math and address table ---
{
  const exports = {};
  vm.runInNewContext(compile("../lib/megapot.ts"), {
    exports,
    process: { env: {} },
    require(name) {
      if (name === "viem") return { parseAbi: (abi) => abi, stringToHex: () => ZERO32 };
      return {};
    },
  });
  assert.equal(exports.MEGAPOT_CHAIN_ID, 8453);
  assert.equal(exports.megapotFor(8453).usdc, "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913");
  assert.equal(exports.megapotFor(8453).randomTicketBuyer, "0xb9560b43b91dE2c1DaF5dfbb76b2CFcDaFc13aBd");
  assert.equal(exports.megapotFor(84532).chainId, 84532);
  assert.equal(exports.megapotFor(1), null);

  // Integer division: a premium short of a whole ticket buys none.
  assert.equal(exports.ticketsForBudget(0n, 1_000_000n), 0n);
  assert.equal(exports.ticketsForBudget(999_999n, 1_000_000n), 0n);
  assert.equal(exports.ticketsForBudget(1_000_000n, 1_000_000n), 1n);
  assert.equal(exports.ticketsForBudget(3_500_000n, 1_000_000n), 3n);
  // Capped at the immediate-purchase limit.
  assert.equal(exports.ticketsForBudget(500_000_000n, 1_000_000n), 10n);
  // A zero price is never a free ticket.
  assert.equal(exports.ticketsForBudget(1_000n, 0n), 0n);

  // No referrer configured -> no referral attribution sent.
  const referral = exports.referralArguments();
  assert.equal(referral.referrers.length, 0);
  assert.equal(referral.split.length, 0);
}

// --- purchase state machine ---
async function buy(options = {}) {
  const writes = [];
  const states = [];
  const reverted = new Set(options.reverted ?? []);
  const exports = {};
  vm.runInNewContext(compile("../lib/use-megapot.ts"), {
    exports,
    process: { env: {} },
    require(name) {
      if (name === "react") {
        return {
          useCallback: (fn) => fn,
          useEffect: () => {},
          useState: (initial) => [initial, (value) => states.push(value)],
        };
      }
      if (name === "wagmi") {
        return {
          useAccount: () => ({
            address: options.address === null ? undefined : account,
            chainId: options.chainId ?? 8453,
          }),
          useConfig: () => ({}),
          useWriteContract: () => ({
            writeContractAsync: async (call) => {
              writes.push(call.functionName);
              return `${call.functionName}-hash`;
            },
          }),
        };
      }
      if (name === "wagmi/actions") {
        return {
          readContract: async (_, { functionName }) =>
            functionName === "allowance" ? (options.allowance ?? 0n) : 0n,
          waitForTransactionReceipt: async (_, { hash }) => ({
            status: reverted.has(hash) ? "reverted" : "success",
          }),
        };
      }
      if (name === "viem") return { erc20Abi: [] };
      if (name === "./megapot") {
        return {
          MEGAPOT_CHAIN_ID: 8453,
          MegapotJackpotAbi: [],
          MegapotRandomBuyerAbi: [],
          MEGAPOT_SOURCE: ZERO32,
          megapotFor: () => ({
            chainId: 8453,
            usdc: USDC,
            jackpot: `0x${"44".repeat(20)}`,
            randomTicketBuyer: BUYER,
            lpManager: `0x${"55".repeat(20)}`,
          }),
          referralArguments: () => ({ referrers: [], split: [] }),
        };
      }
      if (name === "./tx") return {};
      return {};
    },
  });
  const result = await exports.useMegapotTickets().buy(options.count ?? 2n, options.cost ?? 2_000_000n);
  return { result, writes, last: states.at(-1) };
}

const covered = await buy({ allowance: 10_000_000n });
assert.equal(covered.result, "buyTickets-hash");
assert.deepEqual(covered.writes, ["buyTickets"], "an existing allowance skips the approve");
assert.equal(covered.last.kind, "ok");

const approveThenBuy = await buy({ allowance: 0n });
assert.deepEqual(approveThenBuy.writes, ["approve", "buyTickets"]);
assert.equal(approveThenBuy.last.kind, "ok");

const wrongChain = await buy({ chainId: 84532 });
assert.equal(wrongChain.result, null);
assert.deepEqual(wrongChain.writes, [], "no wallet prompt off Base mainnet");
assert.equal(wrongChain.last.kind, "error");
assert.match(wrongChain.last.message, /Base mainnet/);

const noWallet = await buy({ address: null });
assert.equal(noWallet.result, null);
assert.deepEqual(noWallet.writes, []);
assert.equal(noWallet.last.kind, "error");

const noBudget = await buy({ count: 0n, cost: 0n });
assert.equal(noBudget.result, null);
assert.deepEqual(noBudget.writes, []);
assert.equal(noBudget.last.kind, "error");

const buyReverted = await buy({ allowance: 10_000_000n, reverted: ["buyTickets-hash"] });
assert.equal(buyReverted.result, null);
assert.equal(buyReverted.last.kind, "error");
assert.match(buyReverted.last.message, /reverted/i);

const approvalReverted = await buy({ allowance: 0n, reverted: ["approve-hash"] });
assert.equal(approvalReverted.result, null);
assert.deepEqual(approvalReverted.writes, ["approve"], "a reverted approval never reaches the buy");
assert.equal(approvalReverted.last.kind, "error");

console.log(
  "Megapot checks passed: address table, premium->tickets math, approve-when-short, mainnet guard, reverted approve/buy.",
);
