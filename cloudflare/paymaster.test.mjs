import test from "node:test";
import assert from "node:assert/strict";
import {
  SPONSORED_ACTIONS,
  createSponsorLimiter,
  handlePrepare,
  proxyPaymaster,
  sponsorAllowlist,
  validateSponsorRequest,
} from "./paymaster.mjs";

const ACCOUNT = "0x1111111111111111111111111111111111111111";
const FAUCET = "0x20fEF2FC80e34df2F47E09116BaaC2C02D71Bc19";
const VAULT = "0x7e63b6A2948d317ccA06d7df9437613D5249afC1";
const INTENT = "0x0C22B391c47B99Bf1434D75af807d75C3CBc773F";
const HOUSE = "0x11239572b1FB70E5b3585d8B40c23D6a12691836";

const env = {
  PAYMASTER_URL: "https://paymaster.test/rpc",
  PAYMASTER_API_KEY: "pm-secret",
  PAYMASTER_CHAIN_ID: "84532",
  FAUCET_ADDRESS: FAUCET,
  VAULT_ADDRESS: VAULT,
  INTENT_ADDRESS: INTENT,
  AUCTION_HOUSE_ADDRESS: HOUSE,
};

const call = (to, selector, rest = {}) => ({ to, data: `${selector}${"00".repeat(4)}`, value: "0", ...rest });
const body = (calls, chainId = 84532) => ({ chainId, account: ACCOUNT, calls });

const prepare = async (payload, overrides = {}, limiter) =>
  handlePrepare(
    new Request("https://example.test/api/paymaster/prepare", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
    }),
    { ...env, ...overrides },
    limiter,
  );

test("the allowlist is built from deployment addresses and pins the four selectors", () => {
  const list = sponsorAllowlist(env);
  const byAction = Object.fromEntries(list.map((entry) => [entry.action, entry]));
  assert.equal(byAction.claim.selector, SPONSORED_ACTIONS.claim.selector);
  assert.equal(byAction.createAuction.selector, SPONSORED_ACTIONS.createAuction.selector);
  assert.equal(byAction.fillIntent.selector, SPONSORED_ACTIONS.fillIntent.selector);
  assert.equal(byAction.redeem.selector, SPONSORED_ACTIONS.redeem.selector);
  assert.equal(byAction.claim.target, FAUCET.toLowerCase());

  // A malformed address drops that action rather than widening the list.
  const trimmed = sponsorAllowlist({ ...env, AUCTION_HOUSE_ADDRESS: "not-an-address" });
  assert.equal(trimmed.some((entry) => entry.action === "createAuction"), false);
  assert.equal(trimmed.length, 3);
});

test("each sponsored action passes, and nothing else does", () => {
  assert.equal(validateSponsorRequest(body([call(FAUCET, "0x4e71d92d")]), env), null);
  assert.equal(validateSponsorRequest(body([call(HOUSE, "0x3ccbcdd5")]), env), null);
  assert.equal(validateSponsorRequest(body([call(INTENT, "0x28681828")]), env), null);
  assert.equal(validateSponsorRequest(body([call(VAULT, "0xe43f80a5")]), env), null);

  // Right address, wrong selector.
  assert.match(validateSponsorRequest(body([call(FAUCET, "0xdeadbeef")]), env), /not sponsored/);
  // Right selector, wrong address.
  assert.match(validateSponsorRequest(body([call(HOUSE, "0x4e71d92d")]), env), /not sponsored/);
  // Wrong chain.
  assert.match(validateSponsorRequest(body([call(FAUCET, "0x4e71d92d")], 1), env), /not sponsored/);
  // Value is never sponsored.
  assert.match(validateSponsorRequest(body([call(FAUCET, "0x4e71d92d", { value: "1" })]), env), /native value/);
  // Calldata with no selector.
  assert.match(validateSponsorRequest(body([{ to: FAUCET, data: "0x" }]), env), /selector/);
  // Unknown target.
  assert.match(validateSponsorRequest(body([call(ACCOUNT, "0x4e71d92d")]), env), /not sponsored/);
});

test("rejects malformed requests before they reach the paymaster", () => {
  assert.match(validateSponsorRequest({ ...body([]), calls: [] }, env), /At least one/);
  assert.match(validateSponsorRequest({ chainId: 84532, account: "nope", calls: [call(FAUCET, "0x4e71d92d")] }, env), /account/);
  assert.match(validateSponsorRequest({ account: ACCOUNT, calls: [call(FAUCET, "0x4e71d92d")] }, env), /chainId/);
  assert.match(validateSponsorRequest({ ...body([call(FAUCET, "0x4e71d92d")]), chainId: "not-a-chain" }, env), /chainId/);
  const tooMany = Array.from({ length: 9 }, () => call(FAUCET, "0x4e71d92d"));
  assert.match(validateSponsorRequest(body(tooMany), env), /At most/);
  // Gas bound must be a positive integer under the configured cap.
  assert.equal(validateSponsorRequest({ ...body([call(FAUCET, "0x4e71d92d")]), maxGas: 500000 }, env), null);
  assert.match(validateSponsorRequest({ ...body([call(FAUCET, "0x4e71d92d")]), maxGas: "nope" }, env), /maxGas/);
  assert.match(validateSponsorRequest({ ...body([call(FAUCET, "0x4e71d92d")]), maxGas: 1 }, { ...env, PAYMASTER_MAX_GAS: "0" }), /gas cap/);
  assert.match(validateSponsorRequest({ ...body([call(FAUCET, "0x4e71d92d")]), maxGas: 9_000_000 }, env), /gas cap/);
});

test("prepare is 503 when unconfigured and 403 with nothing sponsored otherwise", async () => {
  const unconfigured = await prepare(body([call(FAUCET, "0x4e71d92d")]), { PAYMASTER_URL: "" });
  assert.equal(unconfigured.status, 503);
  assert.equal(unconfigured.body.sponsored, undefined);

  const refused = await prepare(body([call(HOUSE, "0xdeadbeef")]));
  assert.equal(refused.status, 403);
  assert.equal(refused.body.sponsored, false);
});

test("prepare returns the paymaster service on the Worker's own origin", async () => {
  const ok = await prepare(body([call(INTENT, "0x28681828")]));
  assert.equal(ok.status, 200);
  assert.equal(ok.body.sponsored, true);
  assert.equal(ok.body.paymasterService.url, "https://example.test/api/paymaster");
  assert.equal(ok.body.chainId, 84532);
});

test("prepare rate-limits per wallet and fails closed when the limiter says no", async () => {
  const limiter = createSponsorLimiter();
  const first = await prepare(body([call(FAUCET, "0x4e71d92d")]), { PAYMASTER_DAILY_LIMIT: "1" }, limiter);
  assert.equal(first.status, 200);
  const second = await prepare(body([call(FAUCET, "0x4e71d92d")]), { PAYMASTER_DAILY_LIMIT: "1" }, limiter);
  assert.equal(second.status, 429);

  // A different wallet still gets its own budget.
  const other = await prepare({ chainId: 84532, account: "0x2222222222222222222222222222222222222222", calls: [call(FAUCET, "0x4e71d92d")] }, { PAYMASTER_DAILY_LIMIT: "1" }, limiter);
  assert.equal(other.status, 200);
});

test("the paymaster RPC proxy only forwards known methods, with the key", async () => {
  const seen = [];
  const fetchImpl = async (url, init) => {
    seen.push({ url: url.toString(), init });
    return { ok: true, status: 200, json: async () => ({ jsonrpc: "2.0", id: 1, result: "0x" }) };
  };
  const rpc = (method) =>
    new Request("https://example.test/api/paymaster", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params: [] }),
    });

  const refused = await proxyPaymaster(rpc("eth_sendTransaction"), env, fetchImpl);
  assert.equal(refused.status, 403);
  assert.equal(seen.length, 0);

  const forwarded = await proxyPaymaster(rpc("pm_getPaymasterData"), env, fetchImpl);
  assert.equal(forwarded.status, 200);
  assert.equal(seen.length, 1);
  assert.equal(seen[0].url, env.PAYMASTER_URL);
  assert.equal(seen[0].init.headers.authorization, "Bearer pm-secret");

  const unconfigured = await proxyPaymaster(rpc("pm_getPaymasterData"), { PAYMASTER_URL: "" });
  assert.equal(unconfigured.status, 503);

  const network = await proxyPaymaster(rpc("pm_getPaymasterStubData"), env, async () => {
    throw new Error("boom");
  });
  assert.equal(network.status, 502);
});
