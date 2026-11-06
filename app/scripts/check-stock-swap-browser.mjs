import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { chromium } from "playwright-core";
import * as viem from "viem";

// The Worker serves the issuer catalog and proxies Base reads; Aerodrome quotes
// are on-chain reads (pool lookup, fee, quoter) through /rpc/mainnet. This
// fixture serves the static export and answers both, so the browser check runs
// the real client code against deterministic rates.
const USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const POOL = "0x00000000000000000000000000000000000000a1";
const address = (n) => `0x${n.toString(16).padStart(40, "0")}`;
const tokens = Array.from({ length: 8 }, (_, i) => ({ chainId: 8453, address: address(i + 1), name: `New company ${i}`, symbol: `NEW${i}`, sourceId: "test", source: "https://issuer.test/list", issuer: "Fixture issuer", disclosures: "https://issuer.test/terms" }));

// Deterministic fixture rates. Buying: 5 USDC (6dp) yields 0.025 stock (8dp).
// Selling: 0.1 stock (8dp) yields 5 USDC (6dp).
let failQuotes = false, lastQuote = null;
const quote = (path, amountIn) => {
  if (failQuotes) throw new Error("insufficient liquidity");
  const sellToken = `0x${path.slice(2, 42)}`, buyToken = `0x${path.slice(48, 88)}`;
  lastQuote = { sellToken, buyToken };
  const isBuy = sellToken.toLowerCase() === USDC.toLowerCase();
  return isBuy ? amountIn / 2n : (amountIn * 50_000_000n) / 100_000_000n;
};

const root = path.resolve(import.meta.dirname, "../out");
// Token metadata and the Aerodrome quote both go through the app's /rpc/mainnet proxy.
const abi = [...viem.erc20Abi, ...viem.parseAbi([
  "function getPool(address,address,int24) view returns (address)",
  "function fee() view returns (uint24)",
  "function quoteExactInput(bytes path, uint256 amountIn) returns (uint256 amountOut, uint160[] sqrtPriceX96AfterList, uint32[] initializedTicksCrossedList, uint256 gasEstimate)",
])];
const aggregateAbi = viem.parseAbi(["function aggregate3((address target,bool allowFailure,bytes callData)[] calls) payable returns((bool success,bytes returnData)[] returnData)"]);
const answerCall = (data) => {
  if (data.startsWith(viem.toFunctionSelector("aggregate3((address,bool,bytes)[])"))) {
    const { args } = viem.decodeFunctionData({ abi: aggregateAbi, data });
    const result = args[0].map((call) => { try { return { success: true, returnData: answerCall(call.callData) }; } catch { return { success: false, returnData: "0x" }; } });
    return viem.encodeFunctionResult({ abi: aggregateAbi, functionName: "aggregate3", result });
  }
  const { functionName, args } = viem.decodeFunctionData({ abi, data });
  let result;
  if (functionName === "getPool") result = args[2] === 100 ? POOL : viem.zeroAddress;
  else if (functionName === "fee") result = 500;
  else if (functionName === "quoteExactInput") result = [quote(args[0], args[1]), [], [], 100000n];
  else if (functionName === "name") result = "New company";
  else if (functionName === "symbol") result = "NEW7";
  else if (functionName === "decimals") result = 8;
  else if (functionName === "balanceOf") result = 100000000n;
  else throw new Error(`Unexpected read: ${functionName}`);
  const fragment = abi.find((f) => f.type === "function" && viem.toFunctionSelector(f) === data.slice(0, 10));
  return viem.encodeFunctionResult({ abi: [fragment], functionName, result });
};
const server = http.createServer((req, res) => {
  const url = new URL(req.url, "http://localhost");
  if (url.pathname === "/stocks") {
    res.setHeader("content-type", "application/json");
    return res.end(JSON.stringify({ chainId: 8453, fetchedAt: Date.now(), expiresAt: Date.now() + 900000, partial: true, tokens, sources: [] }));
  }
  if (url.pathname === "/rpc/mainnet") {
    const respond = (r) => {
      let result;
      if (r.method === "eth_chainId") result = "0x2105";
      else if (r.method === "eth_blockNumber") result = "0x30b6000";
      // The quote's deadline is set from the latest block's time.
      else if (r.method === "eth_getBlockByNumber") result = { number: "0x30b6000", hash: `0x${"11".repeat(32)}`, parentHash: `0x${"22".repeat(32)}`, timestamp: `0x${Math.floor(Date.now() / 1000).toString(16)}`, baseFeePerGas: "0x1", gasLimit: "0x1c9c380", gasUsed: "0x0", miner: viem.zeroAddress, transactions: [], logsBloom: `0x${"00".repeat(256)}`, extraData: "0x", nonce: "0x0000000000000000", difficulty: "0x0", totalDifficulty: "0x0", size: "0x0", stateRoot: `0x${"33".repeat(32)}`, receiptsRoot: `0x${"44".repeat(32)}`, transactionsRoot: `0x${"55".repeat(32)}`, sha3Uncles: `0x${"66".repeat(32)}`, mixHash: `0x${"77".repeat(32)}`, uncles: [] };
      else if (r.method === "eth_call") {
        try { result = answerCall(r.params[0].data); }
        catch (e) { return { jsonrpc: "2.0", id: r.id, error: { code: 3, message: `execution reverted: ${e.message}`, data: "0x" } }; }
      }
      else throw new Error(`Unexpected RPC operation: ${r.method}`);
      return { jsonrpc: "2.0", id: r.id, result };
    };
    let raw = "";
    req.on("data", (chunk) => { raw += chunk; });
    req.on("end", () => {
      const payload = JSON.parse(raw);
      const result = Array.isArray(payload) ? payload.map(respond) : respond(payload);
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify(result));
    });
    return;
  }
  const target = path.join(root, /^\/(swap|buy|sell|earn|faucet|portfolio|rewards)$/.test(url.pathname) ? `${url.pathname}.html` : url.pathname);
  if (!target.startsWith(`${root}/`) || !fs.existsSync(target) || !fs.statSync(target).isFile()) return res.writeHead(404).end();
  res.setHeader("content-type", ({ ".html": "text/html", ".js": "text/javascript", ".css": "text/css" })[path.extname(target)] ?? "application/octet-stream");
  fs.createReadStream(target).pipe(res);
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", headless: true });
// The app network control is a Base UI select: open it and pick by label.
const networkLabel = { "8453": "Mainnet", "84532": "Testnet" };
const chooseNetwork = async (page, chainId) => {
  await page.getByRole("combobox", { name: "App network" }).click();
  await page.getByRole("option", { name: networkLabel[chainId], exact: true }).click();
};
try {
  const page = await browser.newPage();
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  // The real-stock swap is the Mainnet side of the header toggle.
  await page.addInitScript(() => { if (!localStorage.getItem("erodoro.network")) localStorage.setItem("erodoro.network", "8453"); });
  const origin = `http://127.0.0.1:${server.address().port}`;
  await page.goto(`${origin}/buy`);
  await page.waitForURL(`${origin}/swap`);
  await page.getByRole("button", { name: "Select stock", exact: true }).click();
  await page.getByRole("dialog").waitFor();
  await page.getByText("8 verified listings", { exact: true }).waitFor();
  await page.getByText("Some issuer lists are unavailable right now.").waitFor();
  await page.getByRole("textbox", { name: "Search stocks or issuers" }).fill("New company 7");
  await page.getByRole("button", { name: /NEW7.*Fixture issuer/ }).click();
  // The picker animates closed; it must leave rather than linger over the form.
  await page.getByRole("dialog").waitFor({ state: "detached" });

  await page.getByRole("textbox", { name: "You pay (USDC)" }).fill("5");
  await page.getByLabel("Swap quote").waitFor();
  // 5 USDC (6dp) / 2 = 2500000 raw at 8dp -> "0.025"
  assert.equal(await page.getByLabel("Estimated output").innerText(), "0.025");
  assert.equal(await page.getByText("Aerodrome route available.", { exact: true }).count(), 1);
  assert.equal(await page.getByRole("button", { name: "Review approval / confirm swap" }).count(), 0, "Disconnected users cannot submit a swap");

  // Editing invalidates the visible quote until the debounced re-quote lands.
  await page.getByRole("textbox", { name: "You pay (USDC)" }).fill("6");
  assert.equal(await page.getByLabel("Swap quote").count(), 0);
  await page.getByLabel("Swap quote").waitFor();
  assert.equal(await page.getByLabel("Estimated output").innerText(), "0.03");

  // A routing failure says so and shows no quote.
  failQuotes = true;
  await page.getByRole("button", { name: "Refresh quote" }).click();
  await page.getByText("No Aerodrome route.", { exact: true }).waitFor();
  assert.equal(await page.getByLabel("Swap quote").count(), 0);
  failQuotes = false;
  await page.getByRole("button", { name: "Refresh quote" }).click();
  await page.getByLabel("Swap quote").waitFor();

  // The USDC leg is derived by the client, not typed by the user.
  assert.equal(lastQuote.sellToken.toLowerCase(), USDC.toLowerCase());
  assert.equal(lastQuote.buyToken.toLowerCase(), tokens[7].address.toLowerCase());

  for (const width of [375, 390, 768, 1440, 1920]) {
    await page.setViewportSize({ width, height: 1000 });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false, `overflow at ${width}`);
    assert.equal(await page.getByRole("combobox", { name: "App network" }).isVisible(), true, `network selector visible at ${width}`);
    await page.getByRole("button", { name: "Select stock", exact: true }).click();
    assert.equal(await page.getByRole("dialog").evaluate(el => el.scrollWidth > el.clientWidth), false, `picker overflow at ${width}`);
    await page.keyboard.press("Escape");
    await page.getByRole("dialog").waitFor({ state: "detached" });
  }

  await page.getByRole("button", { name: "Reverse swap direction" }).click();
  await page.waitForURL(`${origin}/swap?direction=sell`);
  assert.equal(await page.getByLabel("Swap quote").count(), 0, "Reversing must discard the previous quote");
  assert.equal(await page.getByRole("textbox", { name: "You pay (NEW7)" }).inputValue(), "", "Never reinterpret a USDC amount as stock units");
  await page.getByRole("textbox", { name: "You pay (NEW7)" }).fill("0.1");
  await page.getByLabel("Swap quote").waitFor();
  assert.equal(await page.getByLabel("Estimated output").innerText(), "5");  assert.equal(lastQuote.sellToken.toLowerCase(), tokens[7].address.toLowerCase(), "Selling sends the stock as sellToken");

  await page.goto(`${origin}/sell`);
  await page.waitForURL(`${origin}/swap?direction=sell`);
  await page.getByRole("button", { name: "Select stock", exact: true }).waitFor();
  assert.equal(await page.locator('a[href="/buy"]').count(), 0, "No link to the legacy /buy route");
  assert.equal(await page.locator('a[href="/sell"]').count(), 0, "No link to the legacy /sell route");
  // Testnet keeps the same screen for test stocks and test USDC, and the choice survives a reload.
  await chooseNetwork(page, "84532");
  await page.getByText(/Test stocks on Base Sepolia/).waitFor();
  await page.getByRole("button", { name: /Get 1,000 test USDC/ }).waitFor();
  await page.reload();
  await page.getByText(/Test stocks on Base Sepolia/).waitFor();
  assert.equal((await page.getByRole("combobox", { name: "App network" }).innerText()).trim(), "Testnet");
  await chooseNetwork(page, "8453");
  await page.getByRole("button", { name: "Select stock", exact: true }).waitFor();
  assert.equal(await page.getByLabel("Swap quote").count(), 0, "Network switching discards quotes");
  assert.equal(await page.getByRole("textbox", { name: "You pay (Select stock)" }).inputValue(), "", "Network switching discards amounts");

  await page.goto(`${origin}/earn`);
  await page.getByRole("heading", { name: "Earn on Base Mainnet" }).waitFor();
  await page.getByText(/no canonical market/).waitFor();
  assert.equal(await page.getByRole("link", { name: "Get test assets", exact: true }).count(), 0);
  await page.goto(`${origin}/portfolio`);
  await page.getByRole("heading", { name: "Base Mainnet portfolio" }).waitFor();
  await page.getByText(/no Erodoro positions/).waitFor();
  await page.goto(`${origin}/rewards`);
  await page.getByRole("heading", { name: "Rewards", exact: true }).waitFor();
  await page.getByText("Program not active", { exact: true }).waitFor();
  await page.goto(`${origin}/faucet`);
  await page.getByRole("heading", { name: "This feature is not available on Base Mainnet" }).waitFor();
  await chooseNetwork(page, "84532");
  await page.getByRole("heading", { name: "Get test assets", exact: true, level: 1 }).waitFor();
  assert.deepEqual(errors, []);
  console.log("Stock swap browser checks passed: dynamic catalog, Aerodrome quote lifecycle, failure copy, USDC-leg derivation, five viewport widths, Mainnet/Testnet toggle, Mainnet Earn/Portfolio status, Rewards access and testnet-only faucet.");
} finally { await browser.close(); await new Promise((resolve) => server.close(resolve)); }
