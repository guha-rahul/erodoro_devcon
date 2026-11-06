import test from "node:test";
import assert from "node:assert/strict";
import {
  requiredPremium,
  seriesKey,
  groupIntentsBySeries,
  dutchReserve,
  isBidAcceptable,
  selectWinner,
  createAuction,
  advanceAuction,
  declareWinner,
  coversFullSize,
  configFromEnv,
  validateIntentShape,
  AUCTION_DEFAULTS,
} from "./auction.mjs";

const SELLER = "0x1111111111111111111111111111111111111111";
const CLAIMS = "0x2222222222222222222222222222222222222222";
const COLLAT = "0x3333333333333333333333333333333333333333";
const QUOTE = "0x4444444444444444444444444444444444444444";

function intent(overrides = {}) {
  return {
    seller: SELLER,
    claims: CLAIMS,
    claimId: "11",
    collateral: COLLAT,
    strike: "34000000000",
    maturity: "1900000000",
    claimAmount: "1000000000",
    quoteToken: QUOTE,
    minPremium: "50000000",
    nonce: "7",
    validFrom: "1000",
    validUntil: "2000000000",
    allowPartial: false,
    allowRollover: false,
    filledAmount: "0",
    signature: `0x${"11".repeat(65)}`,
    ...overrides,
  };
}

function bid(overrides = {}) {
  return {
    bidder: "0x5555555555555555555555555555555555555555",
    intentHash: `0x${"ab".repeat(32)}`,
    amount: "1000000000",
    premium: "50000000",
    expiry: "2000000000",
    receivedAt: 100,
    ...overrides,
  };
}

test("floor pro-rates upward with ceiling division", () => {
  assert.equal(requiredPremium("50000000", "1000000000", "333333333"), "16666667");
  assert.equal(requiredPremium("50000000", "1000000000", "1000000000"), "50000000");
});

test("series key groups compatible intents", () => {
  const a = intent({ nonce: "1" });
  const b = intent({ nonce: "2" });
  const c = intent({ nonce: "3", strike: "35000000000" });
  const groups = groupIntentsBySeries([a, b, c]);
  assert.equal(groups.size, 2);
  assert.equal(groups.get(seriesKey(a)).length, 2);
});

test("dutch reserve decays linearly and never falls below floor", () => {
  const start = "65000000";
  const floor = "40000000";
  assert.equal(dutchReserve({ startPremium: start, floor, elapsedSeconds: 0, durationSeconds: 600 }), start);
  assert.equal(dutchReserve({ startPremium: start, floor, elapsedSeconds: 600, durationSeconds: 600 }), floor);
  assert.equal(dutchReserve({ startPremium: start, floor, elapsedSeconds: 9999, durationSeconds: 600 }), floor);
  const mid = BigInt(dutchReserve({ startPremium: start, floor, elapsedSeconds: 300, durationSeconds: 600 }));
  assert.equal(mid, 52500000n);
});

test("bids below floor are rejected; overfill rejected", () => {
  const i = intent();
  assert.equal(isBidAcceptable(bid({ premium: "49000000" }), i, 5000), false); // FLOW E
  assert.equal(isBidAcceptable(bid(), i, 5000), true);
  assert.equal(isBidAcceptable(bid({ amount: "1000000001" }), i, 5000), false);
  assert.equal(isBidAcceptable(bid({ expiry: "4000" }), i, 4999), false);
});

test("best premium wins; ties break by earlier receipt", () => {
  const i = intent();
  const low = bid({ premium: "51000000", receivedAt: 1, bidder: "0x6666666666666666666666666666666666666666" });
  const high = bid({ premium: "60000000", receivedAt: 99 });
  assert.equal(selectWinner([low, high], i, 5000), high);
  const tieA = bid({ premium: "60000000", receivedAt: 5, bidder: "0x6666666666666666666666666666666666666666" });
  const tieB = bid({ premium: "60000000", receivedAt: 9 });
  assert.equal(selectWinner([tieB, tieA], i, 5000), tieA);
});

test("fast auction expires unless the seller opted into rollover", () => {
  const config = configFromEnv({});
  assert.equal(config.FAST_AUCTION_SECONDS, 600);
  assert.ok(config.FAST_AUCTION_SECONDS >= 20 && config.FAST_AUCTION_SECONDS <= 1800);
  assert.ok(config.DISCOVERY_AUCTION_SECONDS >= 480 && config.DISCOVERY_AUCTION_SECONDS <= 900);
  const i = intent();
  const a = createAuction(i, 1000, config, "fast");
  assert.equal(a.state, "FastAuction");
  advanceAuction(a, i, 1000 + config.FAST_AUCTION_SECONDS + 1, config);
  assert.equal(a.state, "Expired");
  assert.equal(a.rolloverEligible, false);
});

test("empty auctions open another round when the seller enabled rollover", () => {
  const config = configFromEnv({});
  const i = intent({ allowRollover: true });
  const a = createAuction(i, 1000, config, "fast");
  const firstEnd = a.fastEndsAt;
  advanceAuction(a, i, firstEnd + 1, config);
  assert.equal(a.state, "FastAuction");
  assert.equal(a.round, 2);
  assert.equal(a.fastEndsAt, firstEnd + 1 + config.FAST_AUCTION_SECONDS);
  assert.equal(a.rolloverEligible, true);
  assert.deepEqual(a.bids, []);
});

test("rollover stops when the seller intent is no longer valid", () => {
  const config = configFromEnv({});
  const i = intent({ allowRollover: true, validUntil: "1500" });
  const a = createAuction(i, 1000, config, "fast");
  advanceAuction(a, i, 1600, config);
  assert.equal(a.state, "Expired");
  assert.equal(a.rolloverEligible, false);
});

test("early close signal on acceptable full-size bid", () => {
  const i = intent();
  const a = createAuction(i, 1000, configFromEnv({}), "fast");
  a.bids.push(bid({ receivedAt: 1001 }));
  advanceAuction(a, i, 1002, configFromEnv({}));
  assert.equal(a.state, "BidReceived");
  assert.ok(coversFullSize(bid(), i, "0"));
});

test("winner exclusivity blocks a second winner; lapse releases", () => {
  const config = configFromEnv({});
  const i = intent();
  const a = createAuction(i, 1000, config, "fast");
  a.bids.push(bid({ premium: "60000000", receivedAt: 1001 }));
  a.bids.push(
    bid({ premium: "55000000", receivedAt: 1002, bidder: "0x6666666666666666666666666666666666666666" }),
  );
  const first = declareWinner(a, i, 1003, config);
  assert.equal(first.ok, true);
  assert.equal(a.state, "SettlementPending");
  const second = declareWinner(a, i, 1004, config);
  assert.equal(second.ok, false); // FLOW J guard: no double winner
  advanceAuction(a, i, first.exclusiveUntil + 1, config); // winner missed window
  assert.equal(a.winner, null);
  const retry = declareWinner(a, i, first.exclusiveUntil + 2, config);
  assert.equal(retry.ok, true); // next valid bid can settle
});

test("intent shape validation rejects P claims and bad windows", () => {
  assert.ok(validateIntentShape(intent()) === null);
  assert.ok(validateIntentShape(intent({ claimId: "10" })) !== null);
  assert.ok(validateIntentShape(intent({ validFrom: "9", validUntil: "8" })) !== null);
});

test("config clamps to the mandated ranges", () => {
  const c = configFromEnv({ FAST_AUCTION_SECONDS: "5", DISCOVERY_AUCTION_SECONDS: "99999" });
  assert.equal(c.FAST_AUCTION_SECONDS, 20);
  assert.equal(c.DISCOVERY_AUCTION_SECONDS, 900);
  assert.equal(AUCTION_DEFAULTS.DISCOVERY_AUCTION_MAX_SECONDS, 900);
});
