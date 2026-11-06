import test from "node:test";
import assert from "node:assert/strict";
import { encodeFunctionResult } from "viem";
import worker, { requestQuotes } from "./worker.mjs";

const CLAIMS = "0x1111111111111111111111111111111111111111";
const QUOTE_TOKEN = "0x2222222222222222222222222222222222222222";
const TAKER = "0x3333333333333333333333333333333333333333";
const MAKER = "0x4444444444444444444444444444444444444444";
const RFQ = "0x5555555555555555555555555555555555555555";

const CHECK_RESULT_ABI = [{
  type: "function",
  name: "checkQuote",
  stateMutability: "view",
  inputs: [],
  outputs: [{ name: "ok", type: "bool" }, { name: "reason", type: "string" }],
}];

function quoteRequest(overrides = {}) {
  return {
    claims: CLAIMS,
    claimId: "11",
    claimAmount: "1000000000000000000",
    quoteToken: QUOTE_TOKEN,
    taker: TAKER,
    ...overrides,
  };
}

function signedQuote(request = quoteRequest(), overrides = {}) {
  return {
    makerName: "External maker",
    quote: {
      maker: MAKER,
      taker: request.taker,
      claims: request.claims,
      claimId: request.claimId,
      claimAmount: request.claimAmount,
      quoteToken: request.quoteToken,
      quoteAmount: "1230000",
      expiry: String(Math.floor(Date.now() / 1000) + 120),
      nonce: "7",
      ...overrides,
    },
    metrics: { availableSize: request.claimAmount, spreadBps: 600 },
    signature: `0x${"11".repeat(65)}`,
  };
}

async function call(body, env = {}) {
  const response = await requestQuotes(new Request("https://erodoro.test/rfq", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  }), env);
  return { status: response.status, body: await response.json() };
}

test("returns and measures a valid external quote", async (t) => {
  const request = quoteRequest();
  t.mock.method(globalThis, "fetch", async (input) => {
    if (String(input) === "https://maker.test/quote") return Response.json(signedQuote(request));
    return Response.json({
      jsonrpc: "2.0",
      id: 1,
      result: encodeFunctionResult({ abi: CHECK_RESULT_ABI, functionName: "checkQuote", result: [true, ""] }),
    });
  });
  t.mock.method(console, "log", () => {});

  const result = await call(request, {
    MM_ENDPOINTS: "desk|https://maker.test/quote",
    RFQ_ADDRESS: RFQ,
    PUBLIC_RPC_URL: "https://rpc.test",
  });

  assert.equal(result.status, 200);
  assert.equal(result.body.responded, 1);
  assert.equal(result.body.responseRate, 1);
  assert.equal(result.body.quotes[0].quote.quoteAmount, "1230000");
  assert.equal(result.body.attempts[0].maker, "desk");
  assert.equal(result.body.attempts[0].status, "quoted");
  assert.ok(result.body.attempts[0].latencyMs >= 0);
});

test("does not return a structurally valid but unfunded quote", async (t) => {
  const request = quoteRequest();
  t.mock.method(globalThis, "fetch", async (input) => {
    if (String(input) === "https://maker.test/quote") return Response.json(signedQuote(request));
    return Response.json({
      jsonrpc: "2.0",
      id: 1,
      result: encodeFunctionResult({
        abi: CHECK_RESULT_ABI,
        functionName: "checkQuote",
        result: [false, "Market maker is short of the quote token"],
      }),
    });
  });
  t.mock.method(console, "log", () => {});

  const result = await call(request, {
    MM_ENDPOINTS: "desk|https://maker.test/quote",
    RFQ_ADDRESS: RFQ,
    PUBLIC_RPC_URL: "https://rpc.test",
  });

  assert.equal(result.body.responded, 0);
  assert.equal(result.body.attempts[0].reason, "onchain_rejected");
  assert.equal(result.body.attempts[0].detail, "Market maker is short of the quote token");
});

test("rejects a maker response that changes the requested claim", async (t) => {
  const request = quoteRequest();
  t.mock.method(globalThis, "fetch", async () => Response.json(signedQuote(request, { claimId: "13" })));
  t.mock.method(console, "log", () => {});

  const result = await call(request, { MM_ENDPOINTS: "desk|https://maker.test/quote" });

  assert.equal(result.body.responded, 0);
  assert.equal(result.body.attempts[0].reason, "request_mismatch");
  assert.match(result.body.note, /No maker/);
});

test("reports the no-maker state without calling an endpoint", async () => {
  const result = await call(quoteRequest());
  assert.equal(result.status, 200);
  assert.equal(result.body.makers, 0);
  assert.equal(result.body.responded, 0);
  assert.deepEqual(result.body.attempts, []);
});

test("routes the public RFQ endpoint through the validated handler", async () => {
  const response = await worker.fetch(new Request("https://erodoro.test/rfq", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(quoteRequest()),
  }), {});
  const body = await response.json();

  assert.equal(response.status, 200);
  assert.equal(body.makers, 0);
  assert.deepEqual(body.quotes, []);
});

test("redirects legacy market paths to the permanent markets route", async () => {
  const id = "9be2d49bd64b6cbb5b6d0aae8e74bd12801ece2bc912d43ae9ab5dd1f45b6b54";
  const response = await worker.fetch(new Request(`https://erodoro.test/app/${id}`), {});

  assert.equal(response.status, 308);
  assert.equal(response.headers.get("location"), `https://erodoro.test/app?market=${id}`);
});

test("legacy stock routes redirect to Swap with the correct direction", async () => {
  for (const method of ["GET", "HEAD"]) {
    for (const [path, target] of [["/buy", "/swap"], ["/buy/", "/swap"], ["/sell", "/swap?direction=sell"], ["/sell/", "/swap?direction=sell"]]) {
      const response = await worker.fetch(new Request(`https://erodoro.test${path}`, { method }), {});
      assert.equal(response.status, 308);
      assert.equal(response.headers.get("location"), `https://erodoro.test${target}`);
    }
  }
});

test("proxies one validated Hermes price request", async (t) => {
  const id = "49f6b65cb1de6b10eaf75e7c03ca029c306d0357e91b5311b175084a5ad55688";
  t.mock.method(globalThis, "fetch", async (input) => {
    assert.equal(
      String(input),
      `https://pyth.dourolabs.app/hermes/v2/updates/price/latest?ids%5B%5D=${id}&encoding=hex`,
    );
    return Response.json({ parsed: [], binary: { data: [] } });
  });

  const response = await worker.fetch(
    new Request(`https://erodoro.test/hermes/v2/updates/price/latest?ids[]=${id}&encoding=hex`),
    {},
  );

  assert.equal(response.status, 200);
  assert.match(response.headers.get("cache-control"), /max-age=5/);
});

test("refuses P claims and unsupported contracts before fan-out", async () => {
  const pClaim = await call(quoteRequest({ claimId: "10" }), { MM_ENDPOINTS: "https://maker.test" });
  assert.equal(pClaim.status, 400);
  assert.match(pClaim.body.error, /Only N/);

  const wrongClaims = await call(quoteRequest(), { RFQ_CLAIMS_ADDRESS: MAKER });
  assert.equal(wrongClaims.status, 400);
  assert.match(wrongClaims.body.error, /not supported/);
});

test("refuses US and US-territory visitors: pages get a region page, APIs a 451", async () => {
  const env = { ASSETS: { fetch: () => new Response("app page") } };
  const from = (path, country, method = "GET") => {
    const request = new Request(`https://erodoro.test${path}`, { method });
    if (country) Object.defineProperty(request, "cf", { value: { country } });
    return request;
  };
  for (const country of ["US", "PR", "GU"]) {
    const page = await worker.fetch(from("/market-rip", country), env);
    assert.equal(page.status, 451);
    assert.match(await page.text(), /Not available in your region/);
  }
  const api = await worker.fetch(from("/api/swap/price", "US"), env);
  assert.equal(api.status, 451);
  assert.equal((await api.json()).error, "Not available in your region.");
  assert.equal((await worker.fetch(from("/waitlist", "US", "POST"), env)).status, 451);
  // Elsewhere, and where the edge gives no country (local dev), the app serves.
  assert.equal(await (await worker.fetch(from("/market-rip", "GB"), env)).text(), "app page");
  assert.equal(await (await worker.fetch(from("/", undefined), env)).text(), "app page");
});
