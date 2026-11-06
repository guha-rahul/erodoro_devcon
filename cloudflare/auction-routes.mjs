/**
 * HTTP surface for the intent auction. Naming follows the existing worker:
 * /rfq and /mm/quote stay untouched; the intent flow lives under /intents
 * and /auctions.
 *
 * Endpoints:
 *   POST /intents            register a signed SellIntent (starts fast auction)
 *   GET  /intents?status=    list intents (active|all|cancelled|filled)
 *   GET  /auctions            list auctions
 *   GET  /auctions/:id        one auction + bids + derived state
 *   POST /auctions/:id/bids   submit a bid (signature verified when present)
 *   POST /auctions/:id/advance coordinator tick (declare winner / roll over)
 *   POST /intents/cancel      mark cancelled (advisory; on-chain cancel required)
 *   GET  /auctions/:id/result winner, bids, settlement status
 *   POST /settlement/report   record an on-chain fill (tx hash + amounts)
 */
import { verifyTypedData } from "viem";
import {
  configFromEnv,
  validateIntentShape,
  validateBidShape,
  createAuction,
  advanceAuction,
  declareWinner,
  intentHash,
  currentReserve,
  selectWinner,
} from "./auction.mjs";

const JSON_HEADERS = { "content-type": "application/json" };
const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: JSON_HEADERS });

export const INTENT_TYPES = {
  SellIntent: [
    { name: "seller", type: "address" },
    { name: "claims", type: "address" },
    { name: "claimId", type: "uint256" },
    { name: "collateral", type: "address" },
    { name: "strike", type: "uint256" },
    { name: "maturity", type: "uint64" },
    { name: "claimAmount", type: "uint256" },
    { name: "quoteToken", type: "address" },
    { name: "minPremium", type: "uint256" },
    { name: "nonce", type: "uint256" },
    { name: "validFrom", type: "uint256" },
    { name: "validUntil", type: "uint256" },
    { name: "allowPartial", type: "bool" },
    { name: "allowRollover", type: "bool" },
  ],
};

export const BID_TYPES = {
  Bid: [
    { name: "bidder", type: "address" },
    { name: "intentHash", type: "bytes32" },
    { name: "amount", type: "uint256" },
    { name: "premium", type: "uint256" },
    { name: "expiry", type: "uint256" },
    { name: "nonce", type: "uint256" },
  ],
};

function intentMessage(intent) {
  return {
    seller: intent.seller,
    claims: intent.claims,
    claimId: BigInt(intent.claimId),
    collateral: intent.collateral,
    strike: BigInt(intent.strike),
    maturity: BigInt(intent.maturity),
    claimAmount: BigInt(intent.claimAmount),
    quoteToken: intent.quoteToken,
    minPremium: BigInt(intent.minPremium),
    nonce: BigInt(intent.nonce),
    validFrom: BigInt(intent.validFrom),
    validUntil: BigInt(intent.validUntil),
    allowPartial: intent.allowPartial === true,
    allowRollover: intent.allowRollover === true,
  };
}

async function verifyIntentSignature(intent, env) {
  const chainId = Number(env.INTENT_CHAIN_ID ?? 84532);
  const verifyingContract = env.INTENT_ADDRESS;
  if (!/^0x[0-9a-fA-F]{40}$/.test(verifyingContract ?? "")) return { ok: false, reason: "Intent contract is not configured." };
  try {
    const ok = await verifyTypedData({
      address: intent.seller,
      domain: { name: "ErodoroIntent", version: "1", chainId, verifyingContract },
      types: INTENT_TYPES,
      primaryType: "SellIntent",
      message: intentMessage(intent),
      signature: intent.signature,
    });
    return ok ? { ok: true } : { ok: false, reason: "Signature does not match the seller." };
  } catch {
    // Contract wallets (EIP-1271) cannot verify off-chain; the intent
    // contract re-checks with SignatureChecker at settlement, which is
    // authoritative. The coordinator records but flags the bid path.
    return { ok: true, deferred: true };
  }
}

async function verifyBidSignature(bid, env) {
  if (!bid.signature) return { ok: true, unsigned: true };
  const chainId = Number(env.INTENT_CHAIN_ID ?? 84532);
  const verifyingContract = env.INTENT_ADDRESS;
  if (!/^0x[0-9a-fA-F]{40}$/.test(verifyingContract ?? "")) return { ok: false, reason: "Intent contract is not configured." };
  try {
    const ok = await verifyTypedData({
      address: bid.bidder,
      domain: { name: "ErodoroAuction", version: "1", chainId, verifyingContract },
      types: BID_TYPES,
      primaryType: "Bid",
      message: {
        bidder: bid.bidder,
        intentHash: bid.intentHash,
        amount: BigInt(bid.amount),
        premium: BigInt(bid.premium),
        expiry: BigInt(bid.expiry),
        nonce: BigInt(bid.nonce ?? "0"),
      },
      signature: bid.signature,
    });
    return ok ? { ok: true } : { ok: false, reason: "Bid signature does not match the bidder." };
  } catch {
    return { ok: false, reason: "Bid signature could not be verified." };
  }
}

export function createAuctionRouter(store) {
  async function registerIntent(request, env) {
    if (request.method !== "POST") return json({ error: "Use POST." }, 405);
    let intent;
    try {
      intent = await request.json();
    } catch {
      return json({ error: "Expected JSON." }, 400);
    }
    const invalid = validateIntentShape(intent);
    if (invalid) return json({ error: invalid }, 400);
    const sig = await verifyIntentSignature(intent, env);
    if (!sig.ok) return json({ error: sig.reason }, 400);

    const hash = intentHash(intent);
    const config = configFromEnv(env);
    try {
      const record = await store.registerIntent(hash, { ...intent, signatureVerified: !sig.deferred });
      const auction = createAuction({ ...intent, filledAmount: "0" }, Math.floor(Date.now() / 1000), config, "fast");
      auction.id = hash;
      auction.intentHash = hash;
      await store.upsertAuction(auction);
      return json({ intentHash: hash, intent: record, auction, signatureDeferred: sig.deferred ?? false });
    } catch (error) {
      return json({ error: error.message }, 409);
    }
  }

  async function listIntents(request, env, url) {
    const status = url.searchParams.get("status") ?? "active";
    return json({ intents: await store.listIntents(status) });
  }

  async function listAuctions() {
    return json({ auctions: await store.listAuctions() });
  }

  async function getAuction(id) {
    const auction = await store.getAuction(id);
    if (!auction) return json({ error: "Unknown auction." }, 404);
    const intent = await store.getIntent(auction.intentHash ?? id);
    return json({ auction, intent });
  }

  async function submitBid(request, env, id) {
    if (request.method !== "POST") return json({ error: "Use POST." }, 405);
    let bid;
    try {
      bid = await request.json();
    } catch {
      return json({ error: "Expected JSON." }, 400);
    }
    bid.intentHash = id;
    const invalid = validateBidShape(bid);
    if (invalid) return json({ error: invalid }, 400);
    const sig = await verifyBidSignature(bid, env);
    if (!sig.ok) return json({ error: sig.reason }, 400);

    const auction = await store.getAuction(id);
    if (!auction) return json({ error: "Unknown auction." }, 404);
    const intent = await store.getIntent(auction.intentHash ?? id);
    if (!intent || intent.status !== "active") return json({ error: "Intent is not active." }, 409);
    if (auction.state === "SettlementPending" && auction.winnerExclusiveUntil * 1000 > Date.now()) {
      return json({ error: "Exclusive settlement window is live; next bids queue after it lapses." }, 409);
    }
    auction.bids.push({ ...bid, receivedAt: Math.floor(Date.now() / 1000) });
    await store.upsertAuction(auction);
    const best = selectWinner(auction.bids, { ...intent, filledAmount: auction.filledAmount ?? "0" }, Math.floor(Date.now() / 1000), {
      reserve: currentReserve(auction, Math.floor(Date.now() / 1000)),
    });
    return json({ ok: true, bids: auction.bids.length, best });
  }

  /**
   * Coordinator tick: advance clock, declare winner when closable.
   *
   * `nowSeconds` is an injectable clock for deterministic tests. The HTTP route
   * never passes it; production always uses the wall clock, so a caller cannot
   * close an auction early over the wire.
   */
  async function tickAuction(env, id, nowSeconds = null) {
    const config = configFromEnv(env);
    const now = Number.isFinite(nowSeconds) ? Math.floor(Number(nowSeconds)) : Math.floor(Date.now() / 1000);
    const auction = await store.getAuction(id);
    if (!auction) return json({ error: "Unknown auction." }, 404);
    const intent = await store.getIntent(auction.intentHash ?? id);
    if (!intent) return json({ error: "Unknown intent." }, 404);
    advanceAuction(auction, { ...intent, filledAmount: auction.filledAmount ?? "0" }, now, config);
    if (["BidReceived", "FastAuction", "DiscoveryAuction"].includes(auction.state)) {
      const fastOver = auction.path === "fast" && now >= auction.fastEndsAt;
      const fullBid = selectWinner(auction.bids, { ...intent, filledAmount: auction.filledAmount ?? "0" }, now, {
        reserve: currentReserve(auction, now),
      });
      if (fullBid && (auction.path !== "fast" || fastOver)) {
        declareWinner(auction, { ...intent, filledAmount: auction.filledAmount ?? "0" }, now, config);
      }
    }
    await store.upsertAuction(auction);
    return json({ auction });
  }

  async function cancel(request, env) {
    if (request.method !== "POST") return json({ error: "Use POST." }, 405);
    let body;
    try {
      body = await request.json();
    } catch {
      return json({ error: "Expected JSON." }, 400);
    }
    const record = await store.getIntent(body.intentHash);
    if (!record) return json({ error: "Unknown intent." }, 404);
    if (String(body.seller ?? "").toLowerCase() !== String(record.seller).toLowerCase()) {
      return json({ error: "Only the seller can cancel." }, 403);
    }
    await store.cancelIntent(body.intentHash);
    return json({
      ok: true,
      requiresOnchainCancel: true,
      note: "Coordinator matching is halted, but only ErodoroIntent.cancelIntent on-chain guarantees no fill. Send the cancel transaction in your wallet.",
    });
  }

  async function result(env, id) {
    const auction = await store.getAuction(id);
    if (!auction) return json({ error: "Unknown auction." }, 404);
    const intent = await store.getIntent(auction.intentHash ?? id);
    return json({
      auction,
      intent,
      winner: auction.winner ?? null,
      exclusiveUntil: auction.winnerExclusiveUntil ?? 0,
      settlementTx: auction.settlementTx ?? null,
    });
  }

  async function reportFill(request) {
    if (request.method !== "POST") return json({ error: "Use POST." }, 405);
    let body;
    try {
      body = await request.json();
    } catch {
      return json({ error: "Expected JSON." }, 400);
    }
    if (!/^0x[0-9a-fA-F]{64}$/.test(body.intentHash ?? "")) return json({ error: "Invalid intentHash." }, 400);
    await store.recordFill(body.intentHash, body.amount, body.txHash ?? null, body.premium ?? null, body.buyer ?? null);
    const auction = await store.getAuction(body.intentHash);
    return json({ ok: true, auction });
  }

  return { registerIntent, listIntents, listAuctions, getAuction, submitBid, tickAuction, cancel, result, reportFill };
}
