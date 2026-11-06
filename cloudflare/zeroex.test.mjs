import test from "node:test";
import assert from "node:assert/strict";
import { proxyZeroEx, validateSwapRequest, validateSwapResponse, ZEROEX_PATHS } from "./zeroex.mjs";

const USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const TOKEN = "0xb200000000000000000000C2e324d24d7eEcd1fb";
const TAKER = "0x1111111111111111111111111111111111111111";
const ALLOWANCE = "0x0000000000001fF3684f28c67538d4D072C22734";
const env = { ZEROX_API_KEY: "secret-key", ZEROX_USDC: USDC };

const req = (kind, params = {}) => {
  const url = new URL(`https://example.test/api/swap/${kind}`);
  for (const [k, v] of Object.entries({ chainId: "8453", sellToken: USDC, buyToken: TOKEN, sellAmount: "5000000", taker: TAKER, ...params })) {
    url.searchParams.set(k, String(v));
  }
  return new Request(url);
};

const goodPayload = (over = {}) => ({
  liquidityAvailable: true,
  sellToken: USDC,
  buyToken: TOKEN,
  sellAmount: "5000000",
  buyAmount: "123456",
  allowanceTarget: ALLOWANCE,
  transaction: { to: "0x0000000000001fF3684f28c67538d4D072C22734", data: "0xdeadbeef", value: "0" },
  ...over,
});

const jsonResponse = (body, status = 200) => ({ ok: status >= 200 && status < 300, status, json: async () => body });

test("validates chain, token roles, taker and amount", () => {
  assert.equal(validateSwapRequest({ chainId: "8453", sellToken: USDC, buyToken: TOKEN, sellAmount: "1", taker: TAKER }, env), null);
  assert.match(validateSwapRequest({ chainId: "1", sellToken: USDC, buyToken: TOKEN, sellAmount: "1", taker: TAKER }, env), /Base mainnet/);
  assert.match(validateSwapRequest({ chainId: "8453", sellToken: "USDC", buyToken: TOKEN, sellAmount: "1", taker: TAKER }, env), /sellToken/);
  assert.match(validateSwapRequest({ chainId: "8453", sellToken: USDC, buyToken: TOKEN, sellAmount: "0", taker: TAKER }, env), /positive/);
  assert.match(validateSwapRequest({ chainId: "8453", sellToken: USDC, buyToken: USDC, sellAmount: "1", taker: TAKER }, env), /differ/);
  // Neither leg is the configured quote token.
  assert.match(validateSwapRequest({ chainId: "8453", sellToken: TOKEN, buyToken: TAKER, sellAmount: "1", taker: TAKER }, env), /quote token/);
});

test("rejects a response with no spender, calldata, or matching roles", () => {
  assert.equal(validateSwapResponse(goodPayload(), { sellToken: USDC, buyToken: TOKEN, sellAmount: "5000000" }), null);
  assert.match(validateSwapResponse(goodPayload({ allowanceTarget: undefined }), null), /allowance target/);
  assert.match(validateSwapResponse(goodPayload({ transaction: { to: ALLOWANCE, data: "0x" } }), null), /calldata/);
  assert.match(validateSwapResponse(goodPayload({ buyAmount: "0" }), null), /buy amount/);
  // A /price answer has no calldata by design; only a /quote must carry it.
  assert.equal(validateSwapResponse(goodPayload({ transaction: undefined }), null, "price"), null);
  assert.match(validateSwapResponse(goodPayload({ transaction: undefined }), null, "quote"), /executable transaction/);
  assert.match(validateSwapResponse(goodPayload({ liquidityAvailable: false }), null), /No liquidity/);
  assert.match(validateSwapResponse(goodPayload({ sellToken: TOKEN }), { sellToken: USDC, buyToken: TOKEN, sellAmount: "5000000" }), /sell token/);
  assert.match(validateSwapResponse(goodPayload({ sellAmount: "4000000" }), { sellToken: USDC, buyToken: TOKEN, sellAmount: "5000000" }), /sell amount/);
});

test("requires an API key and only accepts the two known endpoints", async () => {
  const noKey = await proxyZeroEx(req("price"), { ZEROX_USDC: USDC });
  assert.equal(noKey.status, 503);

  const unknown = await proxyZeroEx(new Request("https://example.test/api/swap/execute"), env);
  assert.equal(unknown.status, 404);
});

test("forwards price and quote to the pinned 0x paths and returns the payload", async () => {
  const seen = [];
  const fetchImpl = async (url, init) => {
    seen.push({ url: url.toString(), init });
    return jsonResponse(goodPayload());
  };
  for (const kind of ["price", "quote"]) {
    const out = await proxyZeroEx(req(kind), env, fetchImpl);
    assert.equal(out.status, 200);
    assert.equal(out.body.buyAmount, "123456");
    assert.equal(seen.at(-1).url.startsWith(`https://api.0x.org${ZEROEX_PATHS[kind]}`), true);
    assert.equal(seen.at(-1).init.headers["0x-api-key"], "secret-key");
    // The key never appears in the body handed back to the browser.
    assert.equal(JSON.stringify(out.body).includes("secret-key"), false);
  }
});

test("passes a bounded slippage through and rejects an absurd one", async () => {
  let seenUrl;
  const fetchImpl = async (url) => { seenUrl = url.toString(); return jsonResponse(goodPayload()); };
  const out = await proxyZeroEx(req("quote", { slippageBps: "50" }), env, fetchImpl);
  assert.equal(out.status, 200);
  assert.equal(new URL(seenUrl).searchParams.get("slippageBps"), "50");

  const bad = await proxyZeroEx(req("quote", { slippageBps: "9999" }), env, async () => jsonResponse(goodPayload()));
  assert.equal(bad.status, 400);
});

test("maps upstream failures and bad payloads to a safe error", async () => {
  const upstreamError = await proxyZeroEx(req("price"), env, async () => jsonResponse({ reason: "insufficient liquidity" }, 400));
  assert.equal(upstreamError.status, 400);
  assert.equal(upstreamError.body.error, "insufficient liquidity");

  const badPayload = await proxyZeroEx(req("price"), env, async () => jsonResponse(goodPayload({ allowanceTarget: undefined })));
  assert.equal(badPayload.status, 502);

  const network = await proxyZeroEx(req("price"), env, async () => { throw new Error("boom"); });
  assert.equal(network.status, 502);
});
