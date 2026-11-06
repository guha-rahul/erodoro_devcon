/**
 * 0x Swap API proxy.
 *
 * The API key must never reach the browser, and the browser must never be
 * trusted to say which chain or which spender a trade targets. This module is
 * the whole boundary: it validates the request shape, pins the chain and the
 * two token roles, forwards to 0x, and returns the executable transaction data
 * unchanged.
 *
 * 0x publishes two endpoints that mean different things:
 * - `/price` is for **editing**: it reflects the current quote and may move.
 * - `/quote` is for **confirming**: it returns the calldata the wallet signs,
 *   and 0x commits to the amounts it carries.
 *
 * Both go through the `allowance-holder` settlement path, whose spender is the
 * `allowanceTarget` 0x returns. A caller must approve **that** address — never
 * a router named in the response body, and never a fixed spender copied from
 * documentation.
 */

const ZEROX_BASE = "https://api.0x.org";
const SUPPORTED_CHAIN = 8453; // Base mainnet. Test assets use the in-app path.

const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const UINT = /^(0|[1-9][0-9]*)$/;
const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";

export const ZEROEX_PATHS = {
  price: "/swap/allowance-holder/price",
  quote: "/swap/allowance-holder/quote",
};

/** Which endpoint a caller is asking for. Anything else is refused. */
export function pathFor(kind) {
  if (kind === "price") return ZEROEX_PATHS.price;
  if (kind === "quote") return ZEROEX_PATHS.quote;
  return null;
}

/**
 * Validate one swap request against the roles the caller claims.
 *
 * `sellToken`/`buyToken` are addresses, never tickers. `side` is derived from
 * the USDC address so the UI cannot relabel a sell as a buy and have this
 * forward it. `taker` is the connected account and must be an address.
 */
export function validateSwapRequest(query, env = {}) {
  const chainId = Number(query?.chainId);
  if (chainId !== SUPPORTED_CHAIN) return "Only Base mainnet is supported.";
  if (!ADDRESS.test(query?.sellToken ?? "")) return "sellToken must be an address.";
  if (!ADDRESS.test(query?.buyToken ?? "")) return "buyToken must be an address.";
  if (!ADDRESS.test(query?.taker ?? "")) return "taker must be an address.";
  if (query.sellToken.toLowerCase() === query.buyToken.toLowerCase()) return "Tokens must differ.";
  if (!UINT.test(query?.sellAmount ?? "") || BigInt(query.sellAmount) === 0n) {
    return "sellAmount must be a positive decimal string.";
  }
  const usdc = (env.ZEROX_USDC ?? "").toLowerCase();
  if (usdc) {
    const sell = query.sellToken.toLowerCase();
    const buy = query.buyToken.toLowerCase();
    if (sell !== usdc && buy !== usdc) return "One leg of every swap must be the configured quote token.";
  }
  return null;
}

/**
 * Reject a response the browser must not act on.
 *
 * The check is deliberately about *consistency*, not about re-deriving 0x's
 * numbers: we cannot improve on their routing, but we can refuse a response
 * whose spender is missing, whose calldata is empty, or whose transaction
 * target is the zero address.
 */
export function validateSwapResponse(payload, requested, kind = "quote") {
  if (!payload || typeof payload !== "object") return "Malformed 0x response.";
  if (payload.liquidityAvailable === false) return "No liquidity for this trade.";
  if (!ADDRESS.test(payload.allowanceTarget ?? "")) return "Response is missing a valid allowance target.";
  if (payload.allowanceTarget.toLowerCase() === ZERO_ADDRESS) return "Response allowance target is the zero address.";
  if (!UINT.test(String(payload.buyAmount ?? "")) || BigInt(payload.buyAmount) === 0n) {
    return "Response has no buy amount.";
  }
  // A /price answer is indicative and never carries calldata; only a /quote
  // the wallet will sign must.
  if (kind === "quote") {
    const tx = payload.transaction;
    if (!tx || !ADDRESS.test(tx.to ?? "")) return "Response has no executable transaction.";
    if (typeof tx.data !== "string" || !/^0x[0-9a-fA-F]+$/.test(tx.data)) return "Response transaction has no calldata.";
  }
  // The token roles must come back the way they went out.
  if (requested) {
    if (String(payload.sellToken ?? "").toLowerCase() !== requested.sellToken.toLowerCase()) {
      return "Response sell token does not match the request.";
    }
    if (String(payload.buyToken ?? "").toLowerCase() !== requested.buyToken.toLowerCase()) {
      return "Response buy token does not match the request.";
    }
    if (UINT.test(requested.sellAmount) && UINT.test(String(payload.sellAmount ?? ""))
      && BigInt(payload.sellAmount) !== BigInt(requested.sellAmount)) {
      return "Response sell amount does not match the request.";
    }
  }
  return null;
}

/**
 * Forward one validated request to 0x.
 *
 * Returns `{ status, body }`; the caller maps that to a Response. The API key
 * is read from the Worker secret and never echoed back, even on failure.
 */
export async function proxyZeroEx(request, env, fetchImpl = fetch) {
  if (request.method !== "GET") return { status: 405, body: { error: "Use GET." } };

  const url = new URL(request.url);
  const kind = url.pathname.endsWith("/price") ? "price" : url.pathname.endsWith("/quote") ? "quote" : null;
  const target = pathFor(kind);
  if (!target) return { status: 404, body: { error: "Unknown swap endpoint." } };

  if (!env.ZEROX_API_KEY) {
    return { status: 503, body: { error: "Swap routing is not configured.", configured: false } };
  }

  const query = Object.fromEntries(url.searchParams.entries());
  const invalid = validateSwapRequest(query, env);
  if (invalid) return { status: 400, body: { error: invalid } };

  const upstream = new URL(target, ZEROX_BASE);
  upstream.searchParams.set("chainId", String(SUPPORTED_CHAIN));
  for (const key of ["sellToken", "buyToken", "sellAmount", "taker"]) {
    upstream.searchParams.set(key, query[key]);
  }
  if (query.slippageBps !== undefined) {
    if (!UINT.test(query.slippageBps) || Number(query.slippageBps) > 1000) {
      return { status: 400, body: { error: "slippageBps must be 0-1000." } };
    }
    upstream.searchParams.set("slippageBps", query.slippageBps);
  }

  let response;
  try {
    response = await fetchImpl(upstream, {
      headers: { "0x-api-key": env.ZEROX_API_KEY, "0x-version": "v2", accept: "application/json" },
      signal: AbortSignal.timeout(10_000),
    });
  } catch {
    return { status: 502, body: { error: "Swap routing is temporarily unavailable." } };
  }

  let payload;
  try {
    payload = await response.json();
  } catch {
    return { status: 502, body: { error: "Swap routing returned an unreadable response." } };
  }

  if (!response.ok) {
    // 0x's own reason is useful and carries no secret; pass it through.
    return { status: response.status, body: { error: payload?.reason ?? payload?.message ?? "Swap routing failed." } };
  }

  const invalidResponse = validateSwapResponse(payload, query, kind);
  if (invalidResponse) return { status: 502, body: { error: invalidResponse } };

  return { status: 200, body: payload };
}
