/**
 * Paymaster sponsorship boundary.
 *
 * Gas sponsorship is only ever granted for a small, named set of product
 * actions. The browser says which calls it is about to send; this module checks
 * every call's target address and 4-byte selector against the deployment's
 * allowlist and **fails closed**: an unrecognised target, selector, chain, or a
 * call that carries value is refused rather than sponsored.
 *
 * The paymaster RPC URL and its API key live in Worker config/secrets. The
 * prepare step has no secret of its own; it is the allowlist, not a signature,
 * that decides what is sponsored here.
 */

const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const HEX = /^0x[0-9a-fA-F]*$/;

export const PAYMASTER_PREPARE_PATH = "/api/paymaster/prepare";
export const PAYMASTER_RPC_PATH = "/api/paymaster";

/**
 * The four sponsored actions and their selectors, taken from the compiled
 * ABIs:
 * - `claim()` — TestFaucet, the first test-asset claim
 * - `createAuction(CreateParams)` — ErodoroAuctionHouse, first auction creation
 * - `fillIntent(...)` — ErodoroIntent, settlement
 * - `redeem(uint256,bool,uint256)` — ErodoroVault, position redemption
 */
export const SPONSORED_ACTIONS = {
  claim: { selector: "0x4e71d92d", label: "Test-asset claim" },
  createAuction: { selector: "0x3ccbcdd5", label: "Auction creation" },
  fillIntent: { selector: "0x28681828", label: "Settlement" },
  redeem: { selector: "0xe43f80a5", label: "Position redemption" },
};

/** Base Sepolia addresses so the allowlist works before any env is set. */
const SEPOLIA_DEFAULTS = {
  FAUCET_ADDRESS: "0x20fEF2FC80e34df2F47E09116BaaC2C02D71Bc19",
  VAULT_ADDRESS: "0x7e63b6A2948d317ccA06d7df9437613D5249afC1",
  INTENT_ADDRESS: "0x0C22B391c47B99Bf1434D75af807d75C3CBc773F",
};

export const MAX_CALLS = 8;

/** The methods a paymaster service is allowed to answer. Anything else is refused. */
export const PAYMASTER_METHODS = new Set([
  "pm_getPaymasterStubData",
  "pm_getPaymasterData",
  "pm_sponsorUserOperation",
]);

/**
 * Build the allowlist for one deployment. A missing or malformed address simply
 * drops that action; it never widens the list.
 */
export function sponsorAllowlist(env = {}) {
  const chainId = Number(env.PAYMASTER_CHAIN_ID ?? env.INTENT_CHAIN_ID ?? 84532);
  if (!Number.isInteger(chainId) || chainId <= 0) return [];
  const addresses = {
    claim: env.FAUCET_ADDRESS ?? SEPOLIA_DEFAULTS.FAUCET_ADDRESS,
    createAuction: env.AUCTION_HOUSE_ADDRESS,
    fillIntent: env.INTENT_ADDRESS ?? SEPOLIA_DEFAULTS.INTENT_ADDRESS,
    redeem: env.VAULT_ADDRESS ?? SEPOLIA_DEFAULTS.VAULT_ADDRESS,
  };
  return Object.entries(addresses)
    .filter(([, address]) => ADDRESS.test(address ?? ""))
    .map(([action, address]) => ({
      chainId,
      action,
      target: address.toLowerCase(),
      selector: SPONSORED_ACTIONS[action].selector.toLowerCase(),
      label: SPONSORED_ACTIONS[action].label,
    }));
}

function isZeroValue(value) {
  return value === undefined || value === null || value === "0" || value === 0 || value === 0n;
}

/**
 * Validate every call in a sponsorship request. Returns a sentence on the first
 * problem, or null when the whole request may be sponsored.
 */
export function validateSponsorRequest(body, env = {}, list = sponsorAllowlist(env)) {
  const chainId = Number(body?.chainId);
  if (!Number.isInteger(chainId)) return "chainId is required.";
  if (!ADDRESS.test(body?.account ?? "")) return "account must be an address.";

  // A caller may declare an upper gas bound. It must fit under the configured
  // cap; the upstream paymaster's own policy is the hard limit.
  if (body?.maxGas !== undefined) {
    const maxGas = Number(body.maxGas);
    if (!Number.isInteger(maxGas) || maxGas <= 0) return "maxGas must be a positive integer.";
    const cap = Number(env.PAYMASTER_MAX_GAS ?? 3_000_000);
    if (!Number.isInteger(cap) || cap <= 0 || maxGas > cap) return `maxGas exceeds the ${cap} gas cap.`;
  }

  const calls = body?.calls;
  if (!Array.isArray(calls) || calls.length === 0) return "At least one call is required.";
  if (calls.length > MAX_CALLS) return `At most ${MAX_CALLS} calls can be sponsored at once.`;

  for (const call of calls) {
    if (!ADDRESS.test(call?.to ?? "")) return "Every call needs a target address.";
    if (typeof call?.data !== "string" || !HEX.test(call.data) || call.data.length < 10) {
      return "Every sponsored call needs calldata with a selector.";
    }
    if (!isZeroValue(call.value)) return "Sponsored calls cannot send native value.";
    const selector = call.data.slice(0, 10).toLowerCase();
    const allowed = list.some(
      (entry) =>
        entry.chainId === chainId &&
        entry.target === call.to.toLowerCase() &&
        entry.selector === selector,
    );
    if (!allowed) return `This call is not sponsored: ${call.to} ${selector}.`;
  }
  return null;
}

/**
 * Best-effort per-wallet daily limiter. In-memory and per-isolate; a durable
 * counter belongs with the Phase 2 store. It exists so one wallet cannot drain
 * the sponsor budget, not as a security boundary.
 */
export function createSponsorLimiter() {
  const seen = new Map();
  return {
    allow(account, limit, now = Date.now()) {
      if (!Number.isInteger(limit) || limit <= 0) return false;
      const day = Math.floor(now / 86_400_000);
      const key = `${account.toLowerCase()}:${day}`;
      const used = seen.get(key) ?? 0;
      if (used >= limit) return false;
      seen.set(key, used + 1);
      return true;
    },
  };
}

const defaultLimiter = createSponsorLimiter();

/**
 * Decide whether the tools the browser is about to send can be sponsored.
 * Unconfigured paymaster: 503. A request that fails the allowlist: 403, with
 * nothing sponsored. There is no "best effort" here.
 */
export async function handlePrepare(request, env = {}, limiter = defaultLimiter) {
  if (request.method !== "POST") return { status: 405, body: { error: "Use POST." } };
  if (!env.PAYMASTER_URL) {
    return { status: 503, body: { error: "Gas sponsorship is not configured.", configured: false } };
  }

  let body;
  try {
    body = await request.json();
  } catch {
    return { status: 400, body: { error: "Expected JSON." } };
  }

  const list = sponsorAllowlist(env);
  const invalid = validateSponsorRequest(body, env, list);
  if (invalid) return { status: 403, body: { error: invalid, sponsored: false } };

  const limit = Number(env.PAYMASTER_DAILY_LIMIT ?? 5);
  if (!limiter.allow(body.account, limit)) {
    return { status: 429, body: { error: "Daily sponsorship limit reached for this wallet." } };
  }

  const origin = new URL(request.url).origin;
  return {
    status: 200,
    body: {
      sponsored: true,
      chainId: Number(body.chainId),
      paymasterService: { url: `${origin}${PAYMASTER_RPC_PATH}` },
      actions: list.map((entry) => entry.label),
    },
  };
}

/**
 * Forward an allowed paymaster JSON-RPC call. The upstream paymaster enforces
 * its own policies; this refuses methods it does not recognise so a caller
 * cannot repurpose the endpoint as a generic RPC proxy.
 */
export async function proxyPaymaster(request, env = {}, fetchImpl = fetch) {
  if (request.method !== "POST") return { status: 405, body: { error: "Use POST." } };
  if (!env.PAYMASTER_URL) return { status: 503, body: { error: "Gas sponsorship is not configured." } };

  let payload;
  try {
    payload = await request.json();
  } catch {
    return { status: 400, body: { error: "Expected JSON." } };
  }

  if (!PAYMASTER_METHODS.has(payload?.method)) {
    return { status: 403, body: { error: `Method not sponsored: ${payload?.method ?? "unknown"}` } };
  }

  const headers = { "content-type": "application/json" };
  if (env.PAYMASTER_API_KEY) headers.authorization = `Bearer ${env.PAYMASTER_API_KEY}`;

  let response;
  try {
    response = await fetchImpl(env.PAYMASTER_URL, {
      method: "POST",
      headers,
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(10_000),
    });
  } catch {
    return { status: 502, body: { error: "The paymaster is temporarily unavailable." } };
  }

  let out;
  try {
    out = await response.json();
  } catch {
    return { status: 502, body: { error: "The paymaster returned an unreadable response." } };
  }
  return { status: response.status, body: out };
}
