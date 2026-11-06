import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { chromium } from "playwright-core";
import { encodeAbiParameters, encodeEventTopics, parseAbi } from "viem";

const root = path.resolve(import.meta.dirname, "../out");
const wallet = "0x1111111111111111111111111111111111111111";
const other = "0x2222222222222222222222222222222222222222";
const token = "0xbD85b60dA2b9B667eb215e0F050047dBBFC46B13";
const rfq = "0x6C4d59A4521E8C542cd39F3d128f38d79D013F62";
const abi = parseAbi(["event Filled(address indexed maker,address indexed taker,uint256 indexed claimId,uint256 claimAmount,address quoteToken,uint256 quoteAmount,uint256 nonce)"]);
function fill(index, maker, taker, amount, quoteToken = token, block = 4500) {
  return {
    address: rfq,
    topics: encodeEventTopics({ abi, eventName: "Filled", args: { maker, taker, claimId: 3n } }),
    data: encodeAbiParameters([{ type: "uint256" }, { type: "address" }, { type: "uint256" }, { type: "uint256" }], [100n, quoteToken, BigInt(amount) * 1000000n, BigInt(index)]),
    blockNumber: `0x${block.toString(16)}`, blockHash: `0x${"ab".repeat(32)}`,
    transactionHash: `0x${index.toString(16).padStart(64, "0")}`,
    logIndex: `0x${index.toString(16)}`, transactionIndex: "0x0", removed: false,
  };
}
const logs = [fill(1, other, wallet, 10), fill(2, wallet, other, 4), fill(3, wallet, wallet, 2), fill(4, other, wallet, 99, other), fill(5, other, wallet, 3, token, 2500)];
const server = http.createServer((req, res) => {
  const pathname = new URL(req.url, "http://localhost").pathname;
  const target = path.join(root, pathname === "/portfolio" ? "portfolio.html" : pathname);
  if (!target.startsWith(`${root}/`) || !fs.existsSync(target) || !fs.statSync(target).isFile()) return res.writeHead(404).end();
  res.setHeader("content-type", ({ ".html": "text/html", ".js": "text/javascript", ".css": "text/css" })[path.extname(target)] ?? "application/octet-stream");
  fs.createReadStream(target).pipe(res);
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const browser = await chromium.launch({ headless: true, executablePath: process.env.CHROME_PATH ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" });
try {
  const page = await browser.newPage();
  let failOlder = false;
  await page.addInitScript((account) => {
    localStorage.setItem("erodoro:tour-seen", "1");
    window.ethereum = {
      on() {}, removeListener() {},
      async request({ method }) {
        if (["eth_accounts", "eth_requestAccounts"].includes(method)) return [account];
        if (method === "eth_chainId") return "0x14a34";
        throw new Error(`Unexpected wallet operation: ${method}`);
      },
    };
  }, wallet);
  await page.route("**/*", async (route) => {
    if (route.request().method() !== "POST") return route.continue();
    const payload = route.request().postDataJSON();
    const respond = (req) => {
      let result = "0x";
      if (req.method === "eth_chainId") result = "0x14a34";
      if (req.method === "eth_blockNumber") result = "0x1388";
      if (req.method === "eth_getLogs") {
        const f = req.params[0];
        if (failOlder && BigInt(f.toBlock) <= 3000n) return { jsonrpc: "2.0", id: req.id, error: { code: -32000, message: "Fixture RPC failure" } };
        result = logs.filter((log) => BigInt(log.blockNumber) >= BigInt(f.fromBlock) && BigInt(log.blockNumber) <= BigInt(f.toBlock) && f.topics.every((topic, i) => topic == null || topic.toLowerCase() === log.topics[i].toLowerCase()));
      }
      return { jsonrpc: "2.0", id: req.id, result };
    };
    await route.fulfill({ json: Array.isArray(payload) ? payload.map(respond) : respond(payload) });
  });
  await page.goto(`http://127.0.0.1:${server.address().port}/portfolio`);
  await page.getByRole("button", { name: "Connect wallet", exact: true }).click();
  await page.getByRole("menuitem", { name: "Injected", exact: true }).click();
  // First page covers blocks 3001-5000: three same-token fills plus one
  // other-token fill that must render as raw units, not a converted amount.
  await page.getByText("10 tUSDC", { exact: true }).waitFor();
  await page.getByText("4 tUSDC", { exact: true }).waitFor();
  await page.getByText("2 tUSDC", { exact: true }).waitFor();
  assert.equal(await page.getByText("Premium earned and paid", { exact: true }).count(), 1);
  assert.equal(await page.getByRole("link", { name: /View receipt/ }).count(), 4);
  await page.getByText(/99000000 raw units/).waitFor();
  failOlder = true;
  await page.getByRole("button", { name: "Show older payments" }).click();
  await page.getByText(/Could not load more payments/).waitFor({ timeout: 30000 });
  assert.equal(await page.getByText("10 tUSDC", { exact: true }).count(), 1);
  failOlder = false;
  await page.getByRole("button", { name: "Show older payments" }).click();
  await page.getByText("3 tUSDC", { exact: true }).waitFor();
  assert.equal(await page.getByRole("link", { name: /View receipt/ }).count(), 5);
  const downloaded = page.waitForEvent("download");
  await page.getByRole("button", { name: "Export CSV" }).click();
  const download = await downloaded;
  const csv = fs.readFileSync(await download.path(), "utf8");
  assert.equal(csv.split("\r\n").length, 6);
  assert.match(csv, /"coverage_from_block","coverage_to_block"/);
  assert.match(csv, /"1001","5000"/);
  assert.match(csv, /"2000000","true","true"/);
  assert.match(download.suggestedFilename(), /1001-5000\.csv$/);
  await page.getByRole("button", { name: "Refresh", exact: true }).click();
  await page.getByText("10 tUSDC", { exact: true }).waitFor();
  console.log("Premium history browser check passed: wallet connection, cash legs, self-fill deduplication, other-token exclusion, failed page retention, retry, refresh.");
} finally {
  await browser.close();
  await new Promise((resolve) => server.close(resolve));
}
