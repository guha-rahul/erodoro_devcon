import test from "node:test";
import assert from "node:assert/strict";
import { SOURCES, parseBaseApi, parseBasePage, parseTokenList, parseBackedPage, loadCatalog } from "./stock-catalog.mjs";
import worker from "./worker.mjs";

const address = (i) => `0x${i.toString(16).padStart(40, "0")}`;
const baseApi = (n) => JSON.stringify({ source: "api", stocks: Array.from({ length: n }, (_, i) => ({ ticker: `STOCK${i}c`, name: `Company ${i}`, address: address(i + 1) })) });
const basePage = (n) => Array.from({ length: n }, (_, i) => `<span>STOCK${i}c</span><p>Company ${i}</p><a aria-label="View STOCK${i}c on BaseScan" href="https://basescan.org/token/${address(i + 1)}">`).join("");

test("discovers new stocks without a fixed ticker allowlist; deduplicates responsive markup", () => {
  const tokens = parseBasePage(basePage(18) + basePage(18));
  assert.equal(tokens.length, 18);
  assert.equal(tokens[17].symbol, "STOCK17c");
  assert.equal(tokens[17].name, "Company 17");
  assert.equal(tokens[17].chainId, 8453);
});
test("reads every stock from Base's JSON list, not just the ten the page renders", () => {
  const tokens = parseBaseApi(JSON.parse(baseApi(127)));
  assert.equal(tokens.length, 127);
  assert.equal(tokens[126].symbol, "STOCK126c");
  assert.equal(tokens[126].name, "Company 126");
  assert.equal(tokens[126].b20, true);
  assert.throws(() => parseBaseApi({ stocks: [] }));
  assert.throws(() => parseBaseApi({ stocks: [{ ticker: "BAD", name: "Bad", address: "garbage" }] }));
});
test("does not accept spoofed stock links or changed empty issuer markup", () => {
  assert.throws(() => parseBasePage(`<a aria-label="View FAKE on BaseScan" href="https://evil.test/token/${address(1)}">`));
  assert.throws(() => parseBasePage("Maintenance"));
});
test("issuer lists filter by chain identity, not symbol; same ticker can have distinct issuer tokens", () => {
  const sample = { address: address(1), name: "Example xStock", symbol: "EXx", decimals: 18 };
  const result = parseTokenList({ tokens: [{ ...sample, chainId: 1 }, { ...sample, chainId: 8453 }, { ...sample, chainId: 8453, address: address(2) }] }, SOURCES[1]);
  assert.equal(result.length, 2);
  assert.throws(() => parseTokenList({ tokens: [{ ...sample, chainId: 8453, address: "garbage" }] }, SOURCES[1]));
  assert.equal(parseTokenList({ tokens: [{ ...sample, chainId: 1 }] }, SOURCES[1]).length, 0);
});
test("Ondo cash token is excluded, stocks and ETFs are allowed", () => {
  const tokens = [{ chainId: 8453, address: address(1), symbol: "USDon", name: "Ondo U.S. Dollar Token" }, { chainId: 8453, address: address(2), symbol: "NEWon", name: "New Stock (Ondo Tokenized)" }];
  assert.deepEqual(parseTokenList({ tokens }, SOURCES[2]).map((t) => t.symbol), ["NEWon"]);
});
test("Backed Base addresses come only from the Base network entry and carry legacy disclosure", () => {
  const html = `<title>Backed Example (bEX) - Backed Assets</title><a title="Ethereum" data-network-address="${address(1)}" href="https://etherscan.io/token/"><a title="Base" data-network-address="${address(2)}" href="https://basescan.org/token/">`;
  assert.equal(parseBackedPage(html)[0].address.toLowerCase(), address(2));
  assert.match(parseBackedPage(html)[0].notice, /discontinued/);
  assert.deepEqual(parseBackedPage(html.replace(address(2), "")), []);
});
test("source failure produces explicit partial coverage, not fake fallback stocks", async () => {
  const fetcher = async (url) => {
    if (url === SOURCES[0].url) return new Response(baseApi(8));
    return new Response("Unavailable", { status: 503 });
  };
  const result = await loadCatalog(fetcher, 1234);
  assert.equal(result.tokens.length, 8);
  assert.equal(result.partial, true);
  assert.equal(result.sources.filter((s) => s.status === "unavailable").length, 3);
  assert.equal(result.fetchedAt, 1234);
  assert.ok(result.expiresAt > result.fetchedAt);
});
test("uses Workers-compatible manual redirects and refuses redirected issuer sources", async () => {
  const fetcher = async (_url, options) => {
    assert.equal(options.redirect, "manual");
    return new Response(null, { status: 302, headers: { location: "https://untrusted.test/list" } });
  };
  const result = await loadCatalog(fetcher);
  assert.equal(result.tokens.length, 0);
  assert.equal(result.partial, true);
});
test("mainnet proxy never falls back to testnet or permits signed transaction submission", async (t) => {
  let upstream;
  t.mock.method(globalThis, "fetch", async (url) => { upstream = url; return Response.json({ result: "0x2105" }); });
  const request = (method) => new Request("https://erodoro.test/rpc/mainnet", { method: "POST", body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params: [] }) });
  const env = { PRIVATE_RPC_URL: "https://private-sepolia.test", PUBLIC_RPC_URL: "https://sepolia.test", BASE_MAINNET_RPC_URL: "https://chainstack.test" };
  assert.equal((await worker.fetch(request("eth_chainId"), env)).status, 200);
  assert.equal(upstream, "https://chainstack.test");
  assert.equal((await worker.fetch(request("eth_sendRawTransaction"), env)).status, 403);
  await worker.fetch(request("eth_chainId"), { PRIVATE_RPC_URL: "https://private-sepolia.test" });
  assert.equal(upstream, "https://mainnet.base.org");
});
test("sepolia proxy never falls back to the mainnet endpoint the default /rpc may be set to", async (t) => {
  let upstream;
  t.mock.method(globalThis, "fetch", async (url) => { upstream = url; return Response.json({ result: "0x14a34" }); });
  const request = (method) => new Request("https://erodoro.test/rpc/sepolia", { method: "POST", body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params: [] }) });
  const env = { PRIVATE_RPC_URL: "https://private-mainnet.test", PUBLIC_RPC_URL: "https://mainnet.test", BASE_SEPOLIA_RPC_URL: "https://sepolia-key.test" };
  assert.equal((await worker.fetch(request("eth_chainId"), env)).status, 200);
  assert.equal(upstream, "https://sepolia-key.test");
  assert.equal((await worker.fetch(request("eth_sendRawTransaction"), env)).status, 403);
  await worker.fetch(request("eth_chainId"), { PRIVATE_RPC_URL: "https://private-mainnet.test" });
  assert.equal(upstream, "https://sepolia.base.org");
});
