/**
 * Permissionless auction coordinator (pure logic, no I/O).
 *
 * Two execution paths share one sell-intent primitive:
 * - PATH A (visible MVP auction): 10min competition, winner gets 30-60s
 *   exclusive settlement. Failure releases the order; never locks it.
 * - PATH B (discovery/batch): 8-15min (hard max 15min), early close on
 *   acceptable full-size bid, fill-or-kill unless the intent allows partial,
 *   rollover only if the seller opted in.
 *
 * Batches are discovered frequently (every few seconds) while each
 * competition stays open longer. Nothing here sends transactions: empty or
 * unsuccessful rounds are pure state transitions. Only settlement hits chain
 * (ErodoroIntent.fillIntent).
 *
 * Amounts/premiums cross the boundary as decimal strings (JSON has no
 * uint256); this module converts to BigInt once, at the edge.
 */

export const AUCTION_DEFAULTS = {
  /** Competition window for the fast solver path. */
  FAST_AUCTION_SECONDS: 600,
  /** Winner's exclusive settlement window. */
  SETTLEMENT_EXCLUSIVITY_SECONDS: 45,
  /** Discovery/batch competition length. */
  DISCOVERY_AUCTION_SECONDS: 600,
  /** Hard ceiling for any discovery auction. */
  DISCOVERY_AUCTION_MAX_SECONDS: 900,
  /** How often the coordinator may open candidate batches. */
  FAST_BATCH_CREATION_INTERVAL_SECONDS: 2,
};

/** Order lifecycle shown in the UI. */
export const ORDER_STATES = [
  "Draft",
  "Signed",
  "Searching",
  "FastAuction",
  "DiscoveryAuction",
  "BidReceived",
  "PartiallyFilled",
  "Filled",
  "SettlementPending",
  "Settled",
  "Cancelled",
  "Expired",
  "Failed",
];

export function configFromEnv(env = {}) {
  const num = (key, fallback, min, max) => {
    const raw = env[key];
    if (raw === undefined || raw === null || raw === "") return fallback;
    const value = Number(raw);
    if (!Number.isFinite(value)) return fallback;
    return Math.min(max, Math.max(min, Math.floor(value)));
  };
  return {
    // The visible auction runs for 10 minutes in both local and deployed builds.
    FAST_AUCTION_SECONDS: num("FAST_AUCTION_SECONDS", AUCTION_DEFAULTS.FAST_AUCTION_SECONDS, 20, 1800),
    SETTLEMENT_EXCLUSIVITY_SECONDS: num(
      "SETTLEMENT_EXCLUSIVITY_SECONDS",
      AUCTION_DEFAULTS.SETTLEMENT_EXCLUSIVITY_SECONDS,
      30,
      60,
    ),
    DISCOVERY_AUCTION_SECONDS: num(
      "DISCOVERY_AUCTION_SECONDS",
      AUCTION_DEFAULTS.DISCOVERY_AUCTION_SECONDS,
      480,
      900,
    ),
    DISCOVERY_AUCTION_MAX_SECONDS: AUCTION_DEFAULTS.DISCOVERY_AUCTION_MAX_SECONDS,
    FAST_BATCH_CREATION_INTERVAL_SECONDS: num(
      "FAST_BATCH_CREATION_INTERVAL_SECONDS",
      AUCTION_DEFAULTS.FAST_BATCH_CREATION_INTERVAL_SECONDS,
      1,
      30,
    ),
  };
}

const UINT = /^(0|[1-9][0-9]*)$/;
const ADDRESS = /^0x[0-9a-fA-F]{40}$/;

function toBigint(value, field) {
  if (typeof value === "bigint") return value;
  if (typeof value === "string" && UINT.test(value)) return BigInt(value);
  throw new Error(`Invalid ${field}: expected decimal string.`);
}

/** Ceiling division so rounding never shaves the seller's floor. */
export function requiredPremium(minPremium, claimAmount, fillAmount) {
  const floor = toBigint(minPremium, "minPremium");
  const total = toBigint(claimAmount, "claimAmount");
  const amount = toBigint(fillAmount, "fillAmount");
  if (total <= 0n || amount <= 0n) throw new Error("Invalid fill size.");
  return ((floor * amount + total - 1n) / total).toString();
}

/**
 * Series/bucket key for batching. Compatible positions sharing one key can
 * be auctioned together without changing economics.
 */
export function seriesKey(intent) {
  for (const field of ["claims", "collateral", "quoteToken"]) {
    if (!ADDRESS.test(intent?.[field] ?? "")) throw new Error(`Invalid ${field}.`);
  }
  return [
    String(intent.claims).toLowerCase(),
    String(intent.collateral).toLowerCase(),
    String(intent.claimId),
    String(intent.strike),
    String(intent.maturity),
    String(intent.quoteToken).toLowerCase(),
  ].join("|");
}

export function groupIntentsBySeries(intents) {
  const groups = new Map();
  for (const intent of intents) {
    const key = seriesKey(intent);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(intent);
  }
  return groups;
}

/**
 * Dutch-style reserve at `elapsed` seconds into a `duration` window.
 * Linear decay from `startPremium` to `floor`; never below floor.
 * All values are decimal strings; returns a decimal string.
 */
export function dutchReserve({ startPremium, floor, elapsedSeconds, durationSeconds }) {
  const start = toBigint(startPremium, "startPremium");
  const min = toBigint(floor, "floor");
  if (start < min) throw new Error("Dutch start must be >= floor.");
  const elapsed = Math.max(0, Number(elapsedSeconds));
  const duration = Math.max(1, Number(durationSeconds));
  if (elapsed <= 0) return start.toString();
  if (elapsed >= duration) return min.toString();
  const drop = ((start - min) * BigInt(Math.floor(elapsed))) / BigInt(Math.floor(duration));
  return (start - drop).toString();
}

/**
 * Whether a bid is economically acceptable right now. Pure economics:
 * signature/funding checks belong at the API/contract boundary.
 */
export function isBidAcceptable(bid, intent, nowSeconds, { reserve = null } = {}) {
  try {
    const amount = toBigint(bid?.amount, "bid.amount");
    const premium = toBigint(bid?.premium, "bid.premium");
    const bidExpiry = Number(bid?.expiry);
    if (amount <= 0n || premium <= 0n) return false;
    if (!Number.isFinite(bidExpiry) || bidExpiry <= nowSeconds) return false;
    const now = Number(nowSeconds);
    if (now < Number(intent.validFrom) || now > Number(intent.validUntil)) return false;
    const remaining = toBigint(intent.claimAmount, "claimAmount") - toBigint(intent.filledAmount ?? "0", "filled");
    if (amount > remaining) return false; // overfill
    const floorRequired = BigInt(requiredPremium(intent.minPremium, intent.claimAmount, amount.toString()));
    let required = floorRequired;
    if (reserve !== null) {
      const reserveRequired = (BigInt(reserve) * amount + toBigint(intent.claimAmount, "claimAmount") - 1n)
        / toBigint(intent.claimAmount, "claimAmount");
      if (reserveRequired > required) required = reserveRequired;
    }
    if (premium < required) return false; // never below seller floor
    return true;
  } catch {
    return false;
  }
}

/**
 * Best valid premium above the floor wins. Ties: earlier received wins,
 * then larger size. Returns the winning bid or null.
 */
export function selectWinner(bids, intent, nowSeconds, opts = {}) {
  const valid = (bids ?? []).filter((b) => isBidAcceptable(b, intent, nowSeconds, opts));
  if (valid.length === 0) return null;
  valid.sort((a, b) => {
    const pa = BigInt(a.premium);
    const pb = BigInt(b.premium);
    if (pb !== pa) return pb > pa ? 1 : -1;
    if (a.receivedAt !== b.receivedAt) return Number(a.receivedAt) - Number(b.receivedAt);
    const aa = BigInt(a.amount);
    const ab = BigInt(b.amount);
    if (ab !== aa) return ab > aa ? 1 : -1;
    return String(a.bidder).localeCompare(String(b.bidder));
  });
  return valid[0];
}

export function createAuction(intent, nowSeconds, config = configFromEnv(), path = "fast") {
  const now = Math.floor(Number(nowSeconds));
  if (path === "discovery") {
    const duration = Math.min(config.DISCOVERY_AUCTION_SECONDS, config.DISCOVERY_AUCTION_MAX_SECONDS);
    return {
      id: intentHash(intent),
      intentHash: intentHash(intent),
      path: "discovery",
      state: "DiscoveryAuction",
      createdAt: now,
      fastEndsAt: now,
      discoveryEndsAt: now + duration,
      bids: [],
      winner: null,
      winnerExclusiveUntil: 0,
      filledAmount: intent.filledAmount ?? "0",
      round: 1,
    };
  }
  return {
    id: intentHash(intent),
    intentHash: intentHash(intent),
    path: "fast",
    state: "FastAuction",
    createdAt: now,
    fastEndsAt: now + config.FAST_AUCTION_SECONDS,
    discoveryEndsAt: 0,
    bids: [],
    winner: null,
    winnerExclusiveUntil: 0,
    filledAmount: intent.filledAmount ?? "0",
    round: 1,
  };
}

/**
 * Advance one auction by the clock. Returns the (mutated) auction.
 * - An empty round restarts on the same path when the seller allowed rollover.
 * - Otherwise an empty fast/discovery round expires.
 * - Winner exclusivity lapse without settlement -> release winner, reopen.
 */
export function advanceAuction(auction, intent, nowSeconds, config = configFromEnv()) {
  const now = Math.floor(Number(nowSeconds));
  if (["Settled", "Cancelled", "Expired", "Failed", "Filled"].includes(auction.state)) return auction;
  if (now >= Number(intent.validUntil) || now >= Number(intent.maturity)) {
    auction.state = "Expired";
    auction.rolloverEligible = false;
    return auction;
  }

  if (auction.winner) {
    if (now < auction.winnerExclusiveUntil) {
      auction.state = "SettlementPending";
      return auction;
    }
    // Winner missed the window: release, keep other valid bids.
    auction.winner = null;
    auction.winnerExclusiveUntil = 0;
    auction.state = auction.path === "fast" ? "FastAuction" : "DiscoveryAuction";
  }

  const best = selectWinner(auction.bids, { ...intent, filledAmount: auction.filledAmount }, now, {
    reserve: auction.dutch ? currentReserve(auction, now) : null,
  });
  if (best && coversFullSize(best, intent, auction.filledAmount)) {
    auction.state = "BidReceived";
    return auction;
  }

  if (auction.path === "fast" && now >= auction.fastEndsAt) {
    if (intent.allowRollover === true) return rolloverAuction(auction, now, config);
    auction.state = "Expired";
    auction.rolloverEligible = false;
    return auction;
  }
  if (auction.path === "discovery" && auction.discoveryEndsAt && now >= auction.discoveryEndsAt) {
    if (intent.allowRollover === true) return rolloverAuction(auction, now, config);
    auction.state = "Expired";
    auction.rolloverEligible = false;
    return auction;
  }
  if (best) auction.state = "BidReceived";
  return auction;
}

function rolloverAuction(auction, now, config) {
  auction.state = auction.path === "fast" ? "FastAuction" : "DiscoveryAuction";
  auction.round = Number(auction.round ?? 1) + 1;
  auction.lastRolledOverAt = now;
  auction.rolloverEligible = true;
  auction.bids = [];
  if (auction.path === "fast") {
    auction.fastEndsAt = now + config.FAST_AUCTION_SECONDS;
  } else {
    const duration = Math.min(config.DISCOVERY_AUCTION_SECONDS, config.DISCOVERY_AUCTION_MAX_SECONDS);
    auction.discoveryEndsAt = now + duration;
  }
  return auction;
}

/**
 * Declare the current best bid the winner. Atomicity guard: fails if a live
 * exclusive winner already exists, so two workers cannot crown two winners.
 */
export function declareWinner(auction, intent, nowSeconds, config = configFromEnv()) {
  const now = Math.floor(Number(nowSeconds));
  if (auction.winner && now < auction.winnerExclusiveUntil) {
    return { ok: false, reason: "A live winner already holds exclusivity." };
  }
  const best = selectWinner(auction.bids, { ...intent, filledAmount: auction.filledAmount }, now, {
    reserve: auction.dutch ? currentReserve(auction, now) : null,
  });
  if (!best) return { ok: false, reason: "No acceptable bid." };
  auction.winner = best;
  auction.winnerExclusiveUntil = now + config.SETTLEMENT_EXCLUSIVITY_SECONDS;
  auction.state = "SettlementPending";
  return { ok: true, winner: best, exclusiveUntil: auction.winnerExclusiveUntil };
}

export function applyFill(auction, amount) {
  const filled = toBigint(auction.filledAmount ?? "0", "filled") + toBigint(amount, "amount");
  auction.filledAmount = filled.toString();
  return auction;
}

export function coversFullSize(bid, intent, filledAmount = "0") {
  try {
    const remaining = toBigint(intent.claimAmount, "claimAmount") - toBigint(filledAmount, "filled");
    return toBigint(bid.amount, "bid.amount") >= remaining;
  } catch {
    return false;
  }
}

export function currentReserve(auction, nowSeconds) {
  if (!auction.dutch) return null;
  const elapsed = Math.floor(Number(nowSeconds)) - Number(auction.dutch.startedAt);
  return dutchReserve({
    startPremium: auction.dutch.startPremium,
    floor: auction.dutch.floor,
    elapsedSeconds: elapsed,
    durationSeconds: auction.dutch.durationSeconds,
  });
}

export function attachDutch(auction, { startPremium, floor, durationSeconds, startedAt }) {
  if (BigInt(startPremium) < BigInt(floor)) throw new Error("Dutch start must be >= floor.");
  if (durationSeconds > AUCTION_DEFAULTS.DISCOVERY_AUCTION_MAX_SECONDS) {
    throw new Error("Dutch window exceeds the 15-minute hard maximum.");
  }
  auction.dutch = { startPremium: String(startPremium), floor: String(floor), durationSeconds, startedAt };
  return auction;
}

export function validateIntentShape(intent) {
  for (const field of ["seller", "claims", "collateral", "quoteToken"]) {
    if (!ADDRESS.test(intent?.[field] ?? "")) return `${field} must be an address.`;
  }
  for (const field of ["claimId", "claimAmount", "strike", "maturity", "minPremium", "nonce", "validFrom", "validUntil"]) {
    if (!UINT.test(intent?.[field] ?? "")) return `${field} must be a decimal string.`;
  }
  if ((BigInt(intent.claimId) & 1n) !== 1n) return "Only N claims can be listed.";
  if (BigInt(intent.claimAmount) === 0n || BigInt(intent.minPremium) === 0n) return "Size and floor must be positive.";
  if (BigInt(intent.validFrom) > BigInt(intent.validUntil)) return "validFrom must precede validUntil.";
  if (typeof intent.signature !== "string" || !/^0x[0-9a-fA-F]+$/.test(intent.signature)) {
    return "A seller signature is required.";
  }
  return null;
}

export function validateBidShape(bid) {
  if (!ADDRESS.test(bid?.bidder ?? "")) return "bidder must be an address.";
  for (const field of ["amount", "premium", "expiry"]) {
    if (!UINT.test(bid?.[field] ?? "")) return `${field} must be a decimal string.`;
  }
  if (typeof bid?.intentHash !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(bid.intentHash)) {
    return "intentHash must be a 32-byte hex digest.";
  }
  if (bid.signature !== undefined && (typeof bid.signature !== "string" || !/^0x[0-9a-fA-F]+$/.test(bid.signature))) {
    return "Invalid bid signature.";
  }
  return null;
}

/** Deterministic auction id from intent identity (off-chain; the contract
 *  digest is authoritative on-chain). */
export function intentHash(intent) {
  const key = [
    String(intent.seller).toLowerCase(),
    String(intent.claims).toLowerCase(),
    String(intent.claimId),
    String(intent.nonce),
  ].join("|");
  let h1 = 0x811c9dc5;
  let h2 = 0x01000193;
  const s = key;
  let out = "";
  for (let i = 0; i < 8; i++) {
    for (let j = 0; j < s.length; j++) {
      h1 = (h1 ^ (s.charCodeAt(j) + i * 31 + j)) >>> 0;
      h1 = Math.imul(h1, 16777619) >>> 0;
      h2 = (Math.imul(h2, 31) + s.charCodeAt(j) + i) >>> 0;
    }
    out += h1.toString(16).padStart(8, "0") + h2.toString(16).padStart(8, "0");
  }
  return `0x${out.slice(0, 64)}`;
}
