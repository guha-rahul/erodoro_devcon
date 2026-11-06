import { quote as houseQuote } from "./market-maker.mjs";
import { decodeFunctionResult, encodeFunctionData } from "viem";
import { stockCatalog } from "./stock-catalog.mjs";
import { AuctionStore } from "./auction-store.mjs";
import { createAuctionRouter } from "./auction-routes.mjs";
import { proxyZeroEx } from "./zeroex.mjs";
import { handlePrepare as handlePaymasterPrepare, proxyPaymaster } from "./paymaster.mjs";
import { handleVerify } from "./base-verify.mjs";
import {
  AccessRequestCapacityError,
  normalizeXUsername,
  storeAccessRequest,
} from "./access-requests.mjs";

// A no-binding development fallback. Production binds D1; keeping one store
// per isolate still avoids throwing every auction away between two requests.
const inMemoryAuctionStore = new AuctionStore();

/**
 * The only dynamic surface in front of the static export.
 *
 * Access requests are validated here and stored in the bound Cloudflare D1
 * database. Everything else falls through to the static export or the scoped
 * API handlers below.
 *
 * Everything else falls through to the assets binding.
 */

const JSON_HEADERS = { "content-type": "application/json" };

function json(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: JSON_HEADERS });
}

/** Read-only JSON-RPC. Anything that could move funds is refused outright. */
const RPC_ALLOWED = new Set([
  "eth_call",
  "eth_chainId",
  "eth_blockNumber",
  "eth_getBalance",
  "eth_getCode",
  "eth_getLogs",
  "eth_getBlockByNumber",
  "eth_getTransactionReceipt",
  "eth_getTransactionByHash",
  "eth_estimateGas",
  "eth_feeHistory",
  "eth_gasPrice",
  "eth_maxPriorityFeePerGas",
]);

/**
 * Proxy reads so the endpoint key never reaches the browser bundle.
 *
 * The public endpoint rate-limits, and the markets table costs several calls
 * per market. This is also the only place a read key can live without shipping
 * it to every visitor.
 *
 * Falls back to the public endpoint when no private one is configured, and says
 * so in a response header — a silent fallback would hide the very rate limiting
 * this exists to avoid.
 */
async function proxyRpc(request, env) {
  if (request.method !== "POST") return json({ error: "Use POST." }, 405);

  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: "Expected JSON." }, 400);
  }

  const calls = Array.isArray(body) ? body : [body];
  if (calls.length > 32) return json({ error: "Too many calls in one batch." }, 413);
  for (const c of calls) {
    if (!RPC_ALLOWED.has(c?.method)) {
      return json({ error: `Method not allowed: ${c?.method ?? "unknown"}` }, 403);
    }
  }

  const upstream = env.PRIVATE_RPC_URL || env.PUBLIC_RPC_URL || "https://sepolia.base.org";
  const res = await fetch(upstream, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

  const out = new Response(res.body, { status: res.status, headers: { "content-type": "application/json" } });
  out.headers.set("x-rpc-source", env.PRIVATE_RPC_URL ? "private" : "public-fallback");
  return out;
}

/** Same-origin pass-through for signed Pyth updates used by the browser UI. */
async function proxyHermes(request, env) {
  if (request.method !== "GET") return json({ error: "Use GET." }, 405);

  const incoming = new URL(request.url);
  const match = incoming.pathname.match(/^\/hermes\/v2\/updates\/price\/(latest|[0-9]+)$/);
  const ids = incoming.searchParams.getAll("ids[]");
  if (!match || ids.length !== 1 || !/^[0-9a-fA-F]{64}$/.test(ids[0])) {
    return json({ error: "Unsupported Hermes request." }, 400);
  }

  const upstream = new URL(`https://pyth.dourolabs.app/hermes/v2/updates/price/${match[1]}`);
  upstream.searchParams.set("ids[]", ids[0].toLowerCase());
  upstream.searchParams.set("encoding", "hex");
  const requestHeaders = new Headers({ accept: "application/json" });
  if (env.PYTH_API_KEY) requestHeaders.set("authorization", `Bearer ${env.PYTH_API_KEY}`);
  const response = await fetch(upstream, { headers: requestHeaders });
  const headers = new Headers({ "content-type": response.headers.get("content-type") ?? "application/json" });
  headers.set("cache-control", match[1] === "latest" ? "public, max-age=5" : "public, max-age=31536000, immutable");
  return new Response(response.body, { status: response.status, headers });
}

/**
 * Ask every configured market maker for a price, return what comes back.
 *
 * This is the whole liquidity model: nothing rests on chain, so there is no
 * empty book and no unseeded pool. A seller who wants a price asks for one.
 *
 * Makers are configured as a comma-separated list of endpoints in MM_ENDPOINTS.
 * Each is POSTed the request and answers with `{ quote, signature }` where the
 * quote is EIP-712 signed for ErodoroRFQ. Nothing is signed here — this worker
 * holds no key and is a fan-out, not a counterparty.
 *
 * One bad maker must not stop a seller being served by the others. Every
 * attempt is still classified and logged, so an empty result is measurable
 * rather than indistinguishable from a broken service.
 */
export async function requestQuotes(request, env) {
  if (request.method !== "POST") return json({ error: "Use POST." }, 405);

  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: "Expected JSON." }, 400);
  }

  const invalid = validateQuoteRequest(body, env);
  if (invalid) return json({ error: invalid }, 400);

  const endpoints = parseMakerEndpoints(env.MM_ENDPOINTS);
  // The house maker runs in-process. A worker fetching its own hostname is a
  // self-subrequest, which Cloudflare declines — and an HTTP hop to ourselves
  // would be latency for nothing.
  const hasHouse = Boolean(env.MM_PRIVATE_KEY);

  if (endpoints.length === 0 && !hasHouse) {
    return json({
      quotes: [],
      makers: 0,
      responded: 0,
      responseRate: 0,
      attempts: [],
      note: "No market makers are configured. Set MM_ENDPOINTS to a comma-separated list of quoting endpoints, or MM_PRIVATE_KEY to run the built-in one.",
    });
  }

  const timeout = Math.min(Math.max(Number(env.MM_TIMEOUT_MS ?? 2500), 100), 10_000);
  const startedAt = Date.now();
  const results = await Promise.all(
    endpoints.map(async ({ name, url }) => {
      const started = Date.now();
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeout);
      try {
        const res = await fetch(url, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
          signal: controller.signal,
        });
        if (!res.ok) return failedAttempt(name, started, "http_status", res.status);
        let candidate;
        try {
          candidate = await res.json();
        } catch {
          return failedAttempt(name, started, "invalid_json");
        }
        if (candidate?.error && !candidate?.quote) return failedAttempt(name, started, "declined");
        const reason = validateSignedQuote(candidate, body);
        if (reason) return failedAttempt(name, started, reason);
        const funding = await checkFunding(candidate, body, env);
        return funding.ok
          ? { maker: name, status: "quoted", latencyMs: Date.now() - started, candidate }
          : failedAttempt(name, started, funding.reason, undefined, funding.detail);
      } catch (error) {
        return failedAttempt(name, started, error?.name === "AbortError" ? "timeout" : "network_error");
      } finally {
        clearTimeout(timer);
      }
    }),
  );

  const collected = results.filter((r) => r.status === "quoted").map((r) => r.candidate);
  const attempts = results.map(publicAttempt);

  if (hasHouse) {
    const started = Date.now();
    try {
      const res = await houseQuote(
        new Request("https://internal/mm/quote", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        }),
        env,
      );
      const q = await res.json();
      const reason = res.ok ? validateSignedQuote(q, body) : "house_error";
      if (reason) {
        attempts.push(publicAttempt(failedAttempt("house-test", started, reason, res.status)));
      } else {
        const funding = await checkFunding(q, body, env);
        if (funding.ok) {
          collected.push(q);
          attempts.push({ maker: "house-test", status: "quoted", latencyMs: Date.now() - started });
        } else {
          attempts.push(publicAttempt(failedAttempt("house-test", started, funding.reason, undefined, funding.detail)));
        }
      }
    } catch (error) {
      attempts.push(publicAttempt(failedAttempt("house-test", started, error?.name === "AbortError" ? "timeout" : "house_error")));
    }
  }

  const quotes = collected
    // Best price first. The seller is selling, so more quote token is better.
    .sort((a, b) => {
      const left = BigInt(a.quote.quoteAmount);
      const right = BigInt(b.quote.quoteAmount);
      return right > left ? 1 : right < left ? -1 : 0;
    });

  const makers = endpoints.length + (hasHouse ? 1 : 0);
  const responseRate = makers === 0 ? 0 : quotes.length / makers;
  const metric = {
    event: "rfq_result",
    at: new Date().toISOString(),
    durationMs: Date.now() - startedAt,
    makers,
    responded: quotes.length,
    responseRate,
    requestedClaimAmount: body.claimAmount,
    bestQuoteAmount: quotes[0]?.quote?.quoteAmount ?? null,
    bestAvailableSize: quotes[0]?.metrics?.availableSize ?? null,
    bestSpreadBps: quotes[0]?.metrics?.spreadBps ?? null,
    bestExpiry: quotes[0]?.quote?.expiry ?? null,
    attempts,
  };
  console.log(JSON.stringify(metric));

  return json({
    quotes,
    makers,
    responded: quotes.length,
    responseRate,
    attempts,
    note: quotes.length === 0 ? "No maker returned a usable funded quote." : undefined,
  });
}

const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const UINT = /^(0|[1-9][0-9]*)$/;
const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";

function validateQuoteRequest(body, env) {
  if (!ADDRESS.test(body?.claims) || !ADDRESS.test(body?.quoteToken) || !ADDRESS.test(body?.taker)) {
    return "claims, quoteToken and taker must be addresses.";
  }
  if (!UINT.test(body?.claimId) || !UINT.test(body?.claimAmount) || BigInt(body.claimAmount) === 0n) {
    return "claimId and a positive claimAmount must be decimal strings.";
  }
  if ((BigInt(body.claimId) & 1n) !== 1n) return "Only N claims can be quoted.";
  if (env.RFQ_CLAIMS_ADDRESS && body.claims.toLowerCase() !== env.RFQ_CLAIMS_ADDRESS.toLowerCase()) {
    return "The claims contract is not supported.";
  }
  if (env.MM_QUOTE_TOKEN && body.quoteToken.toLowerCase() !== env.MM_QUOTE_TOKEN.toLowerCase()) {
    return "The quote token is not supported.";
  }
  return null;
}

function validateSignedQuote(candidate, requested) {
  const q = candidate?.quote;
  if (!q || typeof candidate.signature !== "string" || !/^0x[0-9a-fA-F]+$/.test(candidate.signature)) {
    return "invalid_response";
  }
  if (!ADDRESS.test(q.maker) || !ADDRESS.test(q.taker) || !ADDRESS.test(q.claims) || !ADDRESS.test(q.quoteToken)) {
    return "invalid_response";
  }
  for (const field of ["claimId", "claimAmount", "quoteAmount", "expiry", "nonce"]) {
    if (!UINT.test(q[field])) return "invalid_response";
  }
  if (q.claims.toLowerCase() !== requested.claims.toLowerCase()
    || q.quoteToken.toLowerCase() !== requested.quoteToken.toLowerCase()
    || q.claimId !== requested.claimId
    || q.claimAmount !== requested.claimAmount) return "request_mismatch";
  if (q.taker !== ZERO_ADDRESS && q.taker.toLowerCase() !== requested.taker.toLowerCase()) return "request_mismatch";
  if (BigInt(q.quoteAmount) === 0n || BigInt(q.expiry) <= BigInt(Math.floor(Date.now() / 1000))) return "expired_or_zero";
  if (!UINT.test(candidate?.metrics?.availableSize)
    || BigInt(candidate.metrics.availableSize) < BigInt(requested.claimAmount)
    || !Number.isInteger(candidate?.metrics?.spreadBps)
    || candidate.metrics.spreadBps < 0
    || candidate.metrics.spreadBps > 10_000) return "invalid_metrics";
  return null;
}

function parseMakerEndpoints(value = "") {
  return value.split(",").map((entry, index) => {
    const trimmed = entry.trim();
    const separator = trimmed.indexOf("|");
    return separator === -1
      ? { name: `maker-${index + 1}`, url: trimmed }
      : { name: trimmed.slice(0, separator).trim() || `maker-${index + 1}`, url: trimmed.slice(separator + 1).trim() };
  }).filter(({ url }) => /^https?:\/\//.test(url));
}

function failedAttempt(maker, started, reason, upstreamStatus, detail) {
  return { maker, status: "failed", latencyMs: Date.now() - started, reason, upstreamStatus, detail };
}

function publicAttempt({ candidate: _candidate, ...attempt }) {
  return attempt;
}

const CHECK_QUOTE_ABI = [{
  type: "function",
  name: "checkQuote",
  stateMutability: "view",
  inputs: [
    {
      name: "q",
      type: "tuple",
      components: [
        { name: "maker", type: "address" },
        { name: "taker", type: "address" },
        { name: "claims", type: "address" },
        { name: "claimId", type: "uint256" },
        { name: "claimAmount", type: "uint256" },
        { name: "quoteToken", type: "address" },
        { name: "quoteAmount", type: "uint256" },
        { name: "expiry", type: "uint256" },
        { name: "nonce", type: "uint256" },
      ],
    },
    { name: "signature", type: "bytes" },
    { name: "taker", type: "address" },
  ],
  outputs: [{ name: "ok", type: "bool" }, { name: "reason", type: "string" }],
}];

async function checkFunding(candidate, requested, env) {
  if (!ADDRESS.test(env.RFQ_ADDRESS ?? "")) {
    return { ok: false, reason: "funding_check_unavailable", detail: "RFQ_ADDRESS is not configured" };
  }
  const rpc = env.PRIVATE_RPC_URL || env.PUBLIC_RPC_URL || "https://sepolia.base.org";
  const q = candidate.quote;
  const data = encodeFunctionData({
    abi: CHECK_QUOTE_ABI,
    functionName: "checkQuote",
    args: [{
      ...q,
      claimId: BigInt(q.claimId),
      claimAmount: BigInt(q.claimAmount),
      quoteAmount: BigInt(q.quoteAmount),
      expiry: BigInt(q.expiry),
      nonce: BigInt(q.nonce),
    }, candidate.signature, requested.taker],
  });
  try {
    const response = await fetch(rpc, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_call", params: [{ to: env.RFQ_ADDRESS, data }, "latest"] }),
    });
    if (!response.ok) return { ok: false, reason: "funding_check_unavailable", detail: `RPC ${response.status}` };
    const payload = await response.json();
    if (payload.error || !payload.result) {
      return { ok: false, reason: "funding_check_unavailable", detail: payload.error?.message ?? "Missing RPC result" };
    }
    const [ok, detail] = decodeFunctionResult({ abi: CHECK_QUOTE_ABI, functionName: "checkQuote", data: payload.result });
    return ok ? { ok: true } : { ok: false, reason: "onchain_rejected", detail };
  } catch {
    return { ok: false, reason: "funding_check_unavailable", detail: "RPC request failed" };
  }
}

/**
 * Coinbase tokenized stocks are offered only outside the United States, so
 * neither the app nor its APIs serve US visitors. Cloudflare's edge sets
 * `request.cf.country`; a VPN can get around it, so the terms carry the
 * restriction too. US territories count as the US.
 */
export const BLOCKED_COUNTRIES = new Set(["US", "PR", "GU", "VI", "AS", "MP", "UM"]);

const BLOCKED_PAGE = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Not available in your region · erodoro</title><style>:root{color-scheme:light dark}body{margin:0;min-height:100vh;display:grid;place-items:center;background:#f3f0ea;color:#16130f;font:16px/1.6 system-ui,sans-serif}@media (prefers-color-scheme:dark){body{background:#14120f;color:#f3f0ea}}main{max-width:28rem;padding:2rem 1.25rem;text-align:center}h1{font-size:1.75rem;line-height:1.2;margin:0 0 .75rem}p{margin:0;opacity:.75}</style></head><body><main><h1>Not available in your region</h1><p>Erodoro and the tokenized stocks it uses are not offered to people in the United States or its territories.</p></main></body></html>`;

export function blockedRegion(request) {
  return BLOCKED_COUNTRIES.has(request.cf?.country ?? "");
}

function blockedResponse(url) {
  const api = /^\/(api|rpc|stocks|hermes|rfq|mm|waitlist)(\/|$)/.test(url.pathname);
  return api
    ? json({ error: "Not available in your region." }, 451)
    : new Response(BLOCKED_PAGE, { status: 451, headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" } });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (blockedRegion(request)) return blockedResponse(url);

    const legacySwap = url.pathname.match(/^\/(buy|sell)\/?$/);
    if (legacySwap && (request.method === "GET" || request.method === "HEAD")) {
      const target = new URL("/swap", url);
      if (legacySwap[1] === "sell") target.searchParams.set("direction", "sell");
      return Response.redirect(target, 308);
    }

    // Older releases linked to one prebuilt HTML file per market. Redirect
    // those links to the permanent client-selected route so bookmarks and
    // shared URLs keep working after a new market is listed.
    const legacyMarket = url.pathname.match(/^\/app\/([0-9a-fA-F]{64})\/?$/);
    if (legacyMarket && (request.method === "GET" || request.method === "HEAD")) {
      const target = new URL("/app", url);
      target.searchParams.set("market", legacyMarket[1].toLowerCase());
      return Response.redirect(target, 308);
    }

    if (url.pathname === "/rpc") return proxyRpc(request, env);
    if (url.pathname === "/stocks") return stockCatalog(request);
    // 0x swap routing. The API key stays in a Worker secret; the browser only
    // ever sees validated, executable transaction data.
    if (url.pathname === "/api/swap/price" || url.pathname === "/api/swap/quote") {
      const result = await proxyZeroEx(request, env);
      return json(result.body, result.status);
    }
    // Gas sponsorship. The allowlist is enforced here; the RPC endpoint only
    // forwards methods a paymaster is allowed to answer.
    if (url.pathname === "/api/paymaster/prepare") {
      const result = await handlePaymasterPrepare(request, env);
      return json(result.body, result.status);
    }
    if (url.pathname === "/api/paymaster") {
      const result = await proxyPaymaster(request, env);
      return json(result.body, result.status);
    }
    // Base Verify traits, scoped to Sybil/reward use only. A trait that does not
    // declare eligibility or KYC is refused for those purposes.
    if (url.pathname === "/api/verify/trait") {
      const result = await handleVerify(request, env);
      return json(result.body, result.status);
    }
    if (url.pathname === "/rpc/mainnet") return proxyRpc(request, {
      PRIVATE_RPC_URL: env.BASE_MAINNET_RPC_URL,
      PUBLIC_RPC_URL: "https://mainnet.base.org",
    });
    // The app's Mainnet/Testnet toggle reads whichever chain is selected, so
    // each chain has its own route whatever chain `/rpc` is configured for.
    if (url.pathname === "/rpc/sepolia") return proxyRpc(request, {
      PRIVATE_RPC_URL: env.BASE_SEPOLIA_RPC_URL,
      PUBLIC_RPC_URL: "https://sepolia.base.org",
    });
    if (url.pathname.startsWith("/hermes/")) return proxyHermes(request, env);
    if (url.pathname === "/rfq") return requestQuotes(request, env);
    // The house maker. A stand-in so the flow works before a real desk is wired.
    if (url.pathname === "/mm/quote") return houseQuote(request, env);

    // Permissionless intent auction (coordinator is centralized in MVP;
    // settlement stays contract-enforced). No chain txs here.
    const auctionStore = env.AUCTION_DB || env.AUCTION_STORE_FILE
      ? AuctionStore.fromEnv(env)
      : inMemoryAuctionStore;
    const auctions = createAuctionRouter(auctionStore);
    if (url.pathname === "/api/intents" && request.method === "POST") {
      return auctions.registerIntent(request, env);
    }
    if (url.pathname === "/api/intents" && request.method === "GET") {
      return auctions.listIntents(request, env, url);
    }
    if (url.pathname === "/api/intents/cancel") return auctions.cancel(request, env);
    if (url.pathname === "/api/auctions" && request.method === "GET") return auctions.listAuctions();
    const auctionId = url.pathname.match(/^\/api\/auctions\/([0-9a-fA-Fx]+)\/?$/);
    if (auctionId && request.method === "GET") return auctions.getAuction(auctionId[1]);
    const bidRoute = url.pathname.match(/^\/api\/auctions\/([0-9a-fA-Fx]+)\/bids\/?$/);
    if (bidRoute) return auctions.submitBid(request, env, bidRoute[1]);
    const tickRoute = url.pathname.match(/^\/api\/auctions\/([0-9a-fA-Fx]+)\/advance\/?$/);
    if (tickRoute && request.method === "POST") return auctions.tickAuction(env, tickRoute[1]);
    const resultRoute = url.pathname.match(/^\/api\/auctions\/([0-9a-fA-Fx]+)\/result\/?$/);
    if (resultRoute) return auctions.result(env, resultRoute[1]);
    if (url.pathname === "/api/settlement/report") return auctions.reportFill(request);

    if (url.pathname === "/waitlist") {
      if (request.method !== "POST") {
        return json({ error: "Use POST." }, 405);
      }
      let body;
      try {
        body = await request.json();
      } catch {
        return json({ error: "Expected JSON." }, 400);
      }
      if (!normalizeXUsername(body?.xUsername)) {
        return json({ error: "Enter a valid X username." }, 400);
      }
      try {
        await storeAccessRequest(env.ACCESS_DB ?? env.AUCTION_DB, body.xUsername);
      } catch (error) {
        if (error instanceof AccessRequestCapacityError) {
          return json({ error: "The access request list is full." }, 409);
        }
        return json({ error: "Access requests are temporarily unavailable." }, 503);
      }
      return json({ ok: true, stored: true });
    }

    return env.ASSETS.fetch(request);
  },
};
