import test from "node:test";
import assert from "node:assert/strict";
import { privateKeyToAccount } from "viem/accounts";
import { AuctionStore } from "./auction-store.mjs";
import { createAuctionRouter, INTENT_TYPES, BID_TYPES } from "./auction-routes.mjs";
import { intentHash } from "./auction.mjs";

const SELLER_KEY = "0x1111111111111111111111111111111111111111111111111111111111111111";
const BIDDER_KEY = "0x2222222222222222222222222222222222222222222222222222222222222222";
const seller = privateKeyToAccount(SELLER_KEY);
const bidder = privateKeyToAccount(BIDDER_KEY);
const CHAIN_ID = 84532;
const INTENT_ADDRESS = "0x9999999999999999999999999999999999999999";
const CLAIMS = "0x2222222222222222222222222222222222222222";
const COLLAT = "0x3333333333333333333333333333333333333333";
const QUOTE = "0x4444444444444444444444444444444444444444";
const env = { INTENT_ADDRESS, INTENT_CHAIN_ID: String(CHAIN_ID) };

function post(path, body) {
  return new Request(`https://erodoro.test${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

async function signedIntent(overrides = {}) {
  const now = Math.floor(Date.now() / 1000);
  const base = {
    seller: seller.address,
    claims: CLAIMS,
    claimId: "11",
    collateral: COLLAT,
    strike: "34000000000",
    maturity: "1900000000",
    claimAmount: "1000000000",
    quoteToken: QUOTE,
    minPremium: "50000000",
    nonce: "7",
    validFrom: String(now - 10),
    validUntil: String(now + 3600),
    allowPartial: false,
    allowRollover: false,
    ...overrides,
  };
  const message = {
    ...base,
    claimId: BigInt(base.claimId),
    strike: BigInt(base.strike),
    maturity: BigInt(base.maturity),
    claimAmount: BigInt(base.claimAmount),
    minPremium: BigInt(base.minPremium),
    nonce: BigInt(base.nonce),
    validFrom: BigInt(base.validFrom),
    validUntil: BigInt(base.validUntil),
  };
  const signature = await seller.signTypedData({
    domain: { name: "ErodoroIntent", version: "1", chainId: CHAIN_ID, verifyingContract: INTENT_ADDRESS },
    types: INTENT_TYPES,
    primaryType: "SellIntent",
    message,
  });
  return { ...base, signature };
}

async function signedBid(intentHashValue, overrides = {}) {
  const now = Math.floor(Date.now() / 1000);
  const base = {
    bidder: bidder.address,
    intentHash: intentHashValue,
    amount: "1000000000",
    premium: "60000000",
    expiry: String(now + 600),
    nonce: "1",
    ...overrides,
  };
  const signature = await bidder.signTypedData({
    domain: { name: "ErodoroAuction", version: "1", chainId: CHAIN_ID, verifyingContract: INTENT_ADDRESS },
    types: BID_TYPES,
    primaryType: "Bid",
    message: {
      bidder: base.bidder,
      intentHash: base.intentHash,
      amount: BigInt(base.amount),
      premium: BigInt(base.premium),
      expiry: BigInt(base.expiry),
      nonce: BigInt(base.nonce),
    },
  });
  return { ...base, signature };
}

test("FLOW A — register intent, bid, winner declared", async () => {
  const store = new AuctionStore({});
  const router = createAuctionRouter(store);
  const intent = await signedIntent();
  const reg = await (await router.registerIntent(post("/intents", intent), env)).json();
  assert.ok(reg.intentHash);
  const hash = reg.intentHash;
  assert.equal(reg.auction.state, "FastAuction");

  const bid = await signedBid(hash);
  const sub = await (await router.submitBid(post(`/auctions/${hash}/bids`, bid), env, hash)).json();
  assert.equal(sub.ok, true);
  assert.equal(sub.best.premium, "60000000");

  const stored = await store.getAuction(hash);
  stored.fastEndsAt = Math.floor(Date.now() / 1000) - 1;
  await store.upsertAuction(stored);
  const ticked = await (await router.tickAuction(env, hash)).json();
  assert.equal(ticked.auction.state, "SettlementPending");
  assert.equal(ticked.auction.winner.premium, "60000000");

  const result = await (await router.result(env, hash)).json();
  assert.equal(result.winner.bidder.toLowerCase(), bidder.address.toLowerCase());
});

test("FLOW C — no bids expires after the visible auction", async () => {
  const store = new AuctionStore({});
  const router = createAuctionRouter(store);
  const intent = await signedIntent({ nonce: "8" });
  const reg = await (await router.registerIntent(post("/intents", intent), env)).json();
  const hash = reg.intentHash;
  const stored = await store.getAuction(hash);
  stored.fastEndsAt = Math.floor(Date.now() / 1000) - 1; // force timeout
  await store.upsertAuction(stored);
  const ticked = await (await router.tickAuction(env, hash)).json();
  assert.equal(ticked.auction.state, "Expired");
});

test("FLOW D — seller cancels; further bids rejected", async () => {
  const store = new AuctionStore({});
  const router = createAuctionRouter(store);
  const intent = await signedIntent({ nonce: "9" });
  const reg = await (await router.registerIntent(post("/intents", intent), env)).json();
  const hash = reg.intentHash;
  const cancelled = await (
    await router.cancel(post("/intents/cancel", { intentHash: hash, seller: seller.address }), env)
  ).json();
  assert.equal(cancelled.ok, true);
  assert.equal(cancelled.requiresOnchainCancel, true);
  const bid = await signedBid(hash);
  const sub = await (await router.submitBid(post(`/auctions/${hash}/bids`, bid), env, hash)).json();
  assert.ok(sub.error);
});

test("FLOW E — low bid never becomes best", async () => {
  const store = new AuctionStore({});
  const router = createAuctionRouter(store);
  const intent = await signedIntent({ nonce: "10" });
  const reg = await (await router.registerIntent(post("/intents", intent), env)).json();
  const hash = reg.intentHash;
  const low = await signedBid(hash, { premium: "49000000", nonce: "2" });
  await router.submitBid(post(`/auctions/${hash}/bids`, low), env, hash);
  const ticked = await (await router.tickAuction(env, hash)).json();
  assert.equal(ticked.auction.winner, null);
});

test("store survives reload from file", async () => {
  const file = `/tmp/erodoro-auction-test-${Date.now()}.json`;
  const store = new AuctionStore({ file });
  const router = createAuctionRouter(store);
  const intent = await signedIntent({ nonce: "11" });
  const reg = await (await router.registerIntent(post("/intents", intent), env)).json();
  const fresh = new AuctionStore({ file });
  const loaded = await fresh.getIntent(reg.intentHash);
  assert.equal(loaded.seller.toLowerCase(), seller.address.toLowerCase());
  assert.equal(intentHash(intent), reg.intentHash);
});
