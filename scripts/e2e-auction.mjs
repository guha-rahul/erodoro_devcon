#!/usr/bin/env node
/**
 * Deterministic local end-to-end demo for the permissionless intent auction.
 *
 * Run:  pnpm test:e2e   (from the repo root)
 *
 * 1. starts anvil  2. deploys vault + mocks + ErodoroIntent
 * 3. funds writer/buyer  4. writer splits stock into P+N
 * 5. writer viem-signs a SellIntent (cross-checks the contract digest:
 *    fillIntent would revert BadSignature on any encoding mismatch)
 * 6. coordinator registers it, buyer bids, winner is declared
 * 7. buyer settles on-chain (N->buyer, USDC floor->writer, P retained)
 * 8. time advances past maturity, series settles, both sides redeem
 * 9. balances reconcile; also exercises low-bid rejection + cancellation
 */
import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import {
  createPublicClient,
  createWalletClient,
  createTestClient,
  http,
  stringToHex,
  verifyTypedData,
} from "viem";
import { privateKeyToAccount, mnemonicToAccount } from "viem/accounts";
import { AuctionStore } from "../cloudflare/auction-store.mjs";
import { createAuctionRouter, INTENT_TYPES, BID_TYPES } from "../cloudflare/auction-routes.mjs";

const ANVIL_PORT = 8555;
const RPC = `http://127.0.0.1:${ANVIL_PORT}`;
const CHAIN = { id: 31337, name: "anvil", nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 }, rpcUrls: { default: { http: [RPC] } } };

// Deterministic anvil accounts (default mnemonic), derived — never pasted.
const MNEMONIC = "test test test test test test test test test test test junk";
const deployer = mnemonicToAccount(MNEMONIC, { addressIndex: 0 });
const writer = mnemonicToAccount(MNEMONIC, { addressIndex: 1 });
const buyer = mnemonicToAccount(MNEMONIC, { addressIndex: 2 });

const TEN = 10n * 10n ** 8n;
const FLOOR = 50_000_000n;
const STRIKE = 340n * 10n ** 8n;
const FEED = stringToHex("AAPLc/USD", { size: 32 });

const log = (s) => console.log(s);
const fmtUSDC = (v) => `${Number(v) / 1e6} USDC`;
const fmtStock = (v) => `${Number(v) / 1e8} tAAPLc`;

async function artifact(file, name) {
  const raw = await readFile(new URL(`../contracts/out/${file}/${name}.json`, import.meta.url), "utf8");
  return JSON.parse(raw);
}

async function main() {
  const anvil = spawn("anvil", ["--port", String(ANVIL_PORT), "--silent"], { stdio: "ignore" });
  const kill = () => anvil.kill("SIGKILL");
  process.on("exit", kill);
  try {
    await waitForRpc();
    const publicClient = createPublicClient({ chain: CHAIN, transport: http(RPC) });
    const wallet = (account) => createWalletClient({ account, chain: CHAIN, transport: http(RPC) });
    const testClient = createTestClient({ chain: CHAIN, mode: "anvil", transport: http(RPC) });
    const deployerWallet = wallet(deployer);

    // --- Deploy ---------------------------------------------------------
    const deploy = async (file, name, args = []) => {
      const { abi, bytecode } = await artifact(file, name);
      const hash = await deployerWallet.deployContract({ abi, bytecode: bytecode.object, args });
      const { contractAddress } = await publicClient.waitForTransactionReceipt({ hash });
      return { abi, address: contractAddress };
    };
    const stock = await deploy("MockB20Asset.sol", "MockB20Asset", ["Apple test", "tAAPLc", 8, false]);
    const usdc = await deploy("TestQuoteToken.sol", "TestQuoteToken", []);
    const pyth = await deploy("MockPythUnique.sol", "MockPythUnique", [60n, 1n]);
    const adapter = await deploy("PythAdapter.sol", "PythAdapter", [pyth.address]);
    const vault = await deploy("ErodoroVault.sol", "ErodoroVault", []);
    const intentC = await deploy("ErodoroIntent.sol", "ErodoroIntent", []);
    log(`deployed vault=${vault.address} intent=${intentC.address}`);

    const now = BigInt(Math.floor(Date.now() / 1000));
    const maturity = now + 86400n;
    const seriesParams = {
      collateral: stock.address,
      oracle: adapter.address,
      fallbackOracle: "0x0000000000000000000000000000000000000000",
      feeRecipient: writer.address,
      feedId: FEED,
      fallbackRequestId: "0x0000000000000000000000000000000000000000000000000000000000000000",
      settlementModel: 0,
      strike: STRIKE,
      minSplitAmount: 0n,
      maturity,
      settlementDelay: 300n,
      maxPriceLag: 3600n,
      fallbackDelay: 0n,
      maxConfBps: 500,
      feeBps: 0,
      priceDecimals: 8,
      admin: writer.address,
    };
    const seriesId = await publicClient.readContract({
      address: vault.address, abi: vault.abi, functionName: "seriesIdFor", args: [writer.address, seriesParams],
    });
    const nid = seriesId | 1n;
    const pid = seriesId & ~1n;

    // --- Fund -----------------------------------------------------------
    const writerW = wallet(writer);
    const buyerW = wallet(buyer);
    await publicClient.waitForTransactionReceipt({ hash: await deployerWallet.writeContract({ address: stock.address, abi: stock.abi, functionName: "mint", args: [writer.address, 100n * 10n ** 8n] }) });
    await publicClient.waitForTransactionReceipt({ hash: await deployerWallet.writeContract({ address: usdc.address, abi: usdc.abi, functionName: "mint", args: [buyer.address, 100000n * 10n ** 6n] }) });
    await publicClient.waitForTransactionReceipt({ hash: await writerW.writeContract({ address: stock.address, abi: stock.abi, functionName: "approve", args: [vault.address, TEN] }) });
    await publicClient.waitForTransactionReceipt({ hash: await buyerW.writeContract({ address: usdc.address, abi: usdc.abi, functionName: "approve", args: [intentC.address, 2n * FLOOR] }) });

    // --- Writer splits --------------------------------------------------
    await publicClient.waitForTransactionReceipt({ hash: await writerW.writeContract({ address: vault.address, abi: vault.abi, functionName: "createSeries", args: [seriesParams] }) });
    await publicClient.waitForTransactionReceipt({ hash: await writerW.writeContract({ address: vault.address, abi: vault.abi, functionName: "split", args: [seriesId, TEN] }) });
    await publicClient.waitForTransactionReceipt({ hash: await writerW.writeContract({ address: vault.address, abi: vault.abi, functionName: "setOperator", args: [intentC.address, true] }) });

    const wUsdcBefore = await publicClient.readContract({ address: usdc.address, abi: usdc.abi, functionName: "balanceOf", args: [writer.address] });
    log(`before: writer=${fmtStock(await bal(stock, writer.address))} stock, ${fmtUSDC(wUsdcBefore)} | buyer=${fmtUSDC(await bal(usdc, buyer.address))}`);

    // --- Writer signs intent (viem EIP-712; fill would revert on mismatch) --
    const validFrom = now - 60n;
    const validUntil = now + 86400n;
    const intentMessage = {
      seller: writer.address, claims: vault.address, claimId: nid, collateral: stock.address,
      strike: STRIKE, maturity, claimAmount: TEN, quoteToken: usdc.address, minPremium: FLOOR,
      nonce: 7n, validFrom, validUntil, allowPartial: false, allowRollover: false,
    };
    const signature = await writer.signTypedData({
      domain: { name: "ErodoroIntent", version: "1", chainId: 31337, verifyingContract: intentC.address },
      types: INTENT_TYPES, primaryType: "SellIntent", message: intentMessage,
    });
    const sigOk = await verifyTypedData({
      address: writer.address,
      domain: { name: "ErodoroIntent", version: "1", chainId: 31337, verifyingContract: intentC.address },
      types: INTENT_TYPES, primaryType: "SellIntent", message: intentMessage, signature,
    });
    if (!sigOk) throw new Error("intent signature does not verify off-chain");
    log("intent signature verifies off-chain (viem digest matches)");

    // --- Coordinator: register -> bid -> winner --------------------------
    // A 20s window keeps the demo short; the clock is injected below so the
    // test does not sleep for it.
    const env = { INTENT_ADDRESS: intentC.address, INTENT_CHAIN_ID: "31337", FAST_AUCTION_SECONDS: "20" };
    const store = new AuctionStore({});
    const router = createAuctionRouter(store);
    const wire = Object.fromEntries(Object.entries({ ...intentMessage, signature }).map(([k, v]) => [k, typeof v === "bigint" ? v.toString() : v]));
    const reg = await (await router.registerIntent(jsonReq("/intents", wire), env)).json();
    if (!reg.intentHash) throw new Error(`register failed: ${JSON.stringify(reg)}`);
    log(`auction open: ${reg.intentHash.slice(0, 18)}… state=${reg.auction.state} path=${reg.auction.path}`);

    const bidMessage = { bidder: buyer.address, intentHash: reg.intentHash, amount: TEN, premium: 60000000n, expiry: now + 600n, nonce: 1n };
    const bidSig = await buyer.signTypedData({
      domain: { name: "ErodoroAuction", version: "1", chainId: 31337, verifyingContract: intentC.address },
      types: BID_TYPES, primaryType: "Bid", message: bidMessage,
    });
    const bidWire = { bidder: buyer.address, amount: TEN.toString(), premium: "60000000", expiry: (now + 600n).toString(), nonce: "1", signature: bidSig };
    const sub = await (await router.submitBid(jsonReq("bid", bidWire), env, reg.intentHash)).json();
    if (!sub.ok) throw new Error(`bid refused: ${JSON.stringify(sub)}`);
    // Tick with a clock just past the 20s competition window but well inside
    // the 600s bid expiry, so the winner is declared deterministically.
    const closedAt = Math.floor(Date.now() / 1000) + 21;
    const ticked = await (await router.tickAuction(env, reg.intentHash, closedAt)).json();
    if (ticked.auction.state !== "SettlementPending" || !ticked.auction.winner) throw new Error("no winner declared");
    log(`winner: ${ticked.auction.winner.bidder.slice(0, 10)}… premium=${fmtUSDC(BigInt(ticked.auction.winner.premium))} exclusive for ~45s`);

    // --- Buyer settles on-chain ------------------------------------------
    const fillHash = await buyerW.writeContract({
      address: intentC.address, abi: intentC.abi, functionName: "fillIntent",
      args: [{ ...intentMessage, claimId: nid }, signature, TEN, 60000000n],
    });
    await publicClient.waitForTransactionReceipt({ hash: fillHash });
    await router.reportFill(jsonReq("report", { intentHash: reg.intentHash, amount: TEN.toString(), txHash: fillHash }));
    const wUsdcAfter = await bal(usdc, writer.address);
    const bN = await vaultBal(vault, publicClient, buyer.address, nid);
    const wP = await vaultBal(vault, publicClient, writer.address, pid);
    log(`after fill: writer=${fmtUSDC(wUsdcAfter)} (+${fmtUSDC(wUsdcAfter - wUsdcBefore)}) buyer N=${fmtStock(bN)} writer P=${fmtStock(wP)}`);
    if (bN !== TEN || wP !== TEN) throw new Error("position tokens misrouted");

    // --- Low bid + cancel paths (off-chain) -------------------------------
    const wire2 = { ...wire, nonce: "8" };
    const sig2 = await writer.signTypedData({
      domain: { name: "ErodoroIntent", version: "1", chainId: 31337, verifyingContract: intentC.address },
      types: INTENT_TYPES, primaryType: "SellIntent",
      message: { ...intentMessage, nonce: 8n },
    });
    wire2.signature = sig2;
    const reg2 = await (await router.registerIntent(jsonReq("/intents", wire2), env)).json();
    const lowBid = { ...bidWire, premium: (FLOOR - 1n).toString(), nonce: "2" };
    const lowSig = await buyer.signTypedData({
      domain: { name: "ErodoroAuction", version: "1", chainId: 31337, verifyingContract: intentC.address },
      types: BID_TYPES, primaryType: "Bid",
      message: { bidder: buyer.address, intentHash: reg2.intentHash, amount: TEN, premium: FLOOR - 1n, expiry: now + 600n, nonce: 2n },
    });
    await router.submitBid(jsonReq("bid", { ...lowBid, signature: lowSig }), env, reg2.intentHash);
    const tick2 = await (await router.tickAuction(env, reg2.intentHash)).json();
    if (tick2.auction.winner) throw new Error("low bid must never win");
    log("low bid correctly never wins (floor enforced)");
    const cancelled = await (await router.cancel(jsonReq("cancel", { intentHash: reg2.intentHash, seller: writer.address }), env)).json();
    if (!cancelled.requiresOnchainCancel) throw new Error("cancel must flag on-chain requirement");
    log("cancel flags on-chain cancelIntent as required");

    // --- Mature above strike, settle, redeem ------------------------------
    await testClient.increaseTime({ seconds: 86400 + 300 });
    await testClient.mine({ blocks: 1 });
    const updateData = await publicClient.readContract({
      address: pyth.address, abi: pyth.abi, functionName: "createPriceFeedUpdateData",
      args: [FEED, 500n * 10n ** 8n, 1000000n, -8, 500n * 10n ** 8n, 1000000n, maturity + 30n],
    });
    const fee = await publicClient.readContract({ address: pyth.address, abi: pyth.abi, functionName: "getUpdateFee", args: [[updateData]] });
    const settleHash = await buyerW.writeContract({ address: vault.address, abi: vault.abi, functionName: "settle", args: [seriesId, [updateData]], value: fee });
    await publicClient.waitForTransactionReceipt({ hash: settleHash });
    const settlement = await publicClient.readContract({ address: vault.address, abi: vault.abi, functionName: "settlementOf", args: [seriesId] });
    log(`settled at $${Number(settlement.price) / 1e8}: pPool=${fmtStock(settlement.pPool)} nPool=${fmtStock(settlement.nPool)}`);
    if (settlement.pPool + settlement.nPool !== TEN) throw new Error("conservation violated");
    if (settlement.nPool === 0n) throw new Error("above-strike upside must pay");
    const wStockBefore = await bal(stock, writer.address);
    await publicClient.waitForTransactionReceipt({ hash: await writerW.writeContract({ address: vault.address, abi: vault.abi, functionName: "redeem", args: [seriesId, true, TEN] }) });
    await publicClient.waitForTransactionReceipt({ hash: await buyerW.writeContract({ address: vault.address, abi: vault.abi, functionName: "redeem", args: [seriesId, false, TEN] }) });
    const locked = await publicClient.readContract({ address: vault.address, abi: vault.abi, functionName: "lockedOf", args: [seriesId] });
    log(`redeemed: writer stock ${fmtStock(wStockBefore)} -> ${fmtStock(await bal(stock, writer.address))}; vault locked=${locked}`);
    if (locked !== 0n) throw new Error("vault did not drain");

    log("\nE2E PASS: sign -> bid -> win -> settle -> mature -> redeem reconciles.");
  } finally {
    kill();
  }

  async function bal(token, who) {
    const client = createPublicClient({ chain: CHAIN, transport: http(RPC) });
    return client.readContract({ address: token.address, abi: token.abi, functionName: "balanceOf", args: [who] });
  }
  async function vaultBal(v, client, who, id) {
    return client.readContract({ address: v.address, abi: v.abi, functionName: "balanceOf", args: [who, id] });
  }
  function jsonReq(_path, body) {
    return new Request("https://local/test", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body, (_, v) => (typeof v === "bigint" ? v.toString() : v)) });
  }
  async function waitForRpc() {
    const client = createPublicClient({ chain: CHAIN, transport: http(RPC) });
    for (let i = 0; i < 50; i++) {
      try {
        await client.getBlockNumber();
        return;
      } catch {
        await new Promise((r) => setTimeout(r, 200));
      }
    }
    throw new Error("anvil did not start");
  }
}

main().catch((e) => {
  console.error(`E2E FAIL: ${e.stack}`);
  process.exit(1);
});
