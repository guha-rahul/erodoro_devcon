/** Rips on a local Base mainnet fork: the mainnet code path, end to end.
 * Run `base-anvil --fork-url https://mainnet.base.org --port 8545 --block-time 2`
 * first, then:  node scripts/rips-fork.mjs deploy   (once per fork)
 *                node scripts/rips-fork.mjs quotes   (loops; quotes live 5 min)
 *                node scripts/rips-fork.mjs safe     (adds a pool run by a 2-of-2 Safe)
 *                node scripts/rips-fork.mjs exec <file>  (executes an /ops Safe batch)
 * Real USDC, real Coinbase stock tokens, their Chainlink feeds and Coinbase's
 * oracle registry. Stock and USDC are borrowed by impersonating Uniswap v4's
 * PoolManager, and the fallback oracle is the test mock, so this only runs
 * against a local fork (it refuses anything that is not 127.0.0.1 on 8453).
 * Accounts are fresh random keys written to the manifest (outside the repo):
 * anvil's well-known keys carry EIP-7702 delegations on real Base, and a fork
 * inherits them, so they do not behave like plain wallets.
 */
import { readFile, writeFile } from "node:fs/promises";
import { createPublicClient, createTestClient, createWalletClient, http, erc20Abi, keccak256, toHex, parseAbi, encodeFunctionData, encodePacked, concat, decodeEventLog, size, zeroAddress } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { base } from "viem/chains";
import { marketExpiry } from "./lib/market-expiry.mjs";

const RPC = process.env.RIP_FORK_RPC ?? "http://127.0.0.1:8545";
const MANIFEST = process.env.RIP_FORK_MANIFEST ?? "/tmp/erodoro-rips-fork.json";
const USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const REGISTRY = "0x3f3E8cf41cdd3b1D118c16471aB0113DfDDd5CaD";
const POOL_MANAGER = "0x498581fF718922c3f8e6A244956aF099B2652b2b";
const VOL = 0.5;
const MAX_PRICE_LAG = 4n * 3600n;
const FALLBACK_DELAY = 86400n;

if (!/^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/.test(RPC)) throw new Error("rips-fork only talks to a local fork.");
const transport = http(RPC);
const client = createPublicClient({ chain: base, transport });
if (await client.getChainId() !== 8453) throw new Error("The fork is not of Base mainnet.");
const test = createTestClient({ chain: base, mode: "anvil", transport });
const mode = process.argv[2];
const existing = await readFile(MANIFEST, "utf8").then(JSON.parse).catch(() => null);
const keys = mode === "deploy" || !existing?.keys ? [generatePrivateKey(), generatePrivateKey(), generatePrivateKey()] : existing.keys;
const [operator, buyer, seller] = keys.map((k) => privateKeyToAccount(k));
if (mode === "deploy") await test.setBalance({ address: operator.address, value: 10n ** 20n });
const wallet = createWalletClient({ account: operator, chain: base, transport });
const artifact = async (name, file = `${name}.sol`) => JSON.parse(await readFile(new URL(`../contracts/out/${file}/${name}.json`, import.meta.url)));
const catalog = JSON.parse(await readFile(new URL("../contracts/deployments/base-stocks.json", import.meta.url))).stocks.filter((s) => s.settlement === "chainlink");
const feedAbi = parseAbi(["function latestRoundData() view returns (uint80, int256, uint256, uint256, uint80)"]);

async function wait(hash) {
  const r = await client.waitForTransactionReceipt({ hash });
  if (r.status !== "success") throw new Error(`reverted: ${hash}`);
  return r;
}
const deploy = async (a, args = []) => (await wait(await wallet.deployContract({ abi: a.abi, bytecode: a.bytecode.object, args }))).contractAddress;
const send = (address, abi, functionName, args = []) => wallet.writeContract({ address, abi, functionName, args }).then(wait);

/** Moves real tokens out of PoolManager on the fork. */
async function borrow(token, to, amount) {
  await test.impersonateAccount({ address: POOL_MANAGER });
  await test.setBalance({ address: POOL_MANAGER, value: 10n ** 18n });
  const hash = await createWalletClient({ account: POOL_MANAGER, chain: base, transport }).writeContract({ address: token, abi: erc20Abi, functionName: "transfer", args: [to, amount] });
  await wait(hash);
  await test.stopImpersonatingAccount({ address: POOL_MANAGER });
}

const cdf = (x) => { const t = 1 / (1 + 0.2316419 * Math.abs(x)); const d = 0.3989423 * Math.exp(-x * x / 2); const p = d * t * (0.3193815 + t * (-0.3565638 + t * (1.781478 + t * (-1.821256 + t * 1.330274)))); return x > 0 ? 1 - p : p; };

async function deployAll() {
  const [vaultA, factoryA, putA, poolA, statusA, adapterA, fallbackA] = await Promise.all([
    artifact("ErodoroVault"), artifact("Factory"), artifact("MarketRipPut"), artifact("MarketRipPool"),
    artifact("CoinbaseFeedStatus"), artifact("ChainlinkTotalReturnAdapter"), artifact("MockFallbackSettlementOracle"),
  ]);
  const vault = await deploy(vaultA);
  const factory = await deploy(factoryA, [vault, operator.address, { minHorizon: 7n * 86400n, maxHorizon: 45n * 86400n, minSettlementDelay: 60n, maxSettlementDelay: 86400n, minPriceLag: 1n, maxPriceLag: 25n * 3600n, maxConfBps: 500, maxFeeBps: 0, priceDecimals: 8 }]);
  const put = await deploy(putA, [USDC, operator.address]);
  const poolDeployBlock = await client.getBlockNumber();
  const pool = await deploy(poolA, [USDC, vault, factory, put, operator.address]);
  await send(vault, vaultA.abi, "setOperator", [pool, true]);

  const now = (await client.getBlock()).timestamp;
  const expiry = marketExpiry(Number(now));
  await send(pool, poolA.abi, "createBatch", [expiry]);
  const batchId = 1n;
  const notBefore = expiry + MAX_PRICE_LAG + FALLBACK_DELAY;
  const years = Number(expiry - now) / (365 * 86400);
  const markets = [];
  for (const s of catalog) {
    const held = await client.readContract({ address: s.address, abi: erc20Abi, functionName: "balanceOf", args: [POOL_MANAGER] });
    const [, answer, , updatedAt] = await client.readContract({ address: s.chainlink.proxy, abi: feedAbi, functionName: "latestRoundData" });
    const S = Number(answer) / 1e8, strike = (answer * 105n + 99n) / 100n, K = Number(strike) / 1e8;
    const d1 = (Math.log(S / K) + VOL * VOL * years / 2) / (VOL * Math.sqrt(years)), d2 = d1 - VOL * Math.sqrt(years);
    const premium = Math.max(0.01, S * cdf(d1) - K * cdf(d2));
    const unitsPerRip = BigInt(Math.floor(1e8 / premium));
    const inventory = unitsPerRip * 5n;
    if (held < inventory * 2n) { console.log(`${s.underlying}: skipped, PoolManager holds too little on this fork`); continue; }
    if (markets.length === 10) break;
    const feedId = keccak256(toHex(`COINBASE:${s.address}`));
    const status = await deploy(statusA, [REGISTRY, s.address, feedId]);
    const adapter = await deploy(adapterA, [s.chainlink.proxy, status, feedId]);
    // One fallback per stock, as on mainnet: the Factory rejects a fallback bound to another feed.
    const fallback = await deploy(fallbackA, [1, feedId]);
    const requestId = await client.readContract({ address: fallback, abi: fallbackA.abi, functionName: "requestIdFor", args: [expiry, notBefore] });
    await send(factory, factoryA.abi, "setSettlementConfiguration", [{ collateral: s.address, oracle: adapter, fallbackOracle: fallback, feedId, settlementModel: 1, fallbackDelay: FALLBACK_DELAY, priceDecimals: 8 }]);
    const params = { collateral: s.address, oracle: adapter, fallbackOracle: fallback, feeRecipient: operator.address, feedId, fallbackRequestId: requestId, settlementModel: 1, strike, minSplitAmount: 0n, maturity: expiry, settlementDelay: 60n, maxPriceLag: MAX_PRICE_LAG, fallbackDelay: FALLBACK_DELAY, maxConfBps: 0, feeBps: 0, priceDecimals: 8, admin: operator.address };
    const seriesId = await client.readContract({ address: vault, abi: vaultA.abi, functionName: "seriesIdFor", args: [factory, params] });
    await send(factory, factoryA.abi, "createSeries", [params, operator.address]);
    await borrow(s.address, operator.address, inventory);
    await send(s.address, erc20Abi, "approve", [vault, inventory]);
    await send(vault, vaultA.abi, "split", [seriesId, inventory]);
    const validUntil = (await client.getBlock()).timestamp + 300n;
    await send(pool, poolA.abi, "addPosition", [{ batchId, stock: s.address, direction: 0, claimId: seriesId | 1n, spotAtCreation: answer, unitsPerRip, quoteValidUntil: validUntil, quoteRef: keccak256(toHex(`fork:${s.underlying}:${validUntil}`)) }]);
    markets.push({ ticker: s.underlying, token: s.address, unitsPerRip: unitsPerRip.toString(), seriesId: seriesId.toString(), fallback });
    console.log(`${s.symbol}: spot $${S.toFixed(2)} (feed ${Math.round((Number(now) - Number(updatedAt)) / 3600)}h old) strike $${K.toFixed(2)} claim $${premium.toFixed(2)}`);
  }
  if (markets.length !== 10) throw new Error(`Only ${markets.length} stocks could be seeded on this fork.`);
  await send(pool, poolA.abi, "activateBatch", [batchId]);

  // Buyer: ETH for gas and $25 of real USDC. Seller: ETH and stock to deposit.
  for (const a of [buyer, seller]) await test.setBalance({ address: a.address, value: 10n ** 18n });
  await borrow(USDC, buyer.address, 25_000_000n);
  const deposit = markets.find((m) => m.ticker === "AAPL") ?? markets[0];
  await borrow(deposit.token, seller.address, BigInt(deposit.unitsPerRip) * 20n);

  const m = { chainId: 8453, rpc: RPC, keys, vault, factory, put, pool, poolDeployBlock: poolDeployBlock.toString(), batchId: batchId.toString(), expiry: expiry.toString(), markets, buyer: buyer.address, seller: seller.address, sellerStock: deposit.ticker };
  await writeFile(MANIFEST, JSON.stringify(m, null, 2));
  console.log(`pool ${pool}; expiry ${new Date(Number(expiry) * 1000).toUTCString()}; manifest ${MANIFEST}`);
}

async function refreshQuotes() {
  const m = JSON.parse(await readFile(MANIFEST, "utf8"));
  const poolA = await artifact("MarketRipPool");
  for (;;) {
    const ids = await client.readContract({ address: m.pool, abi: poolA.abi, functionName: "batchPositions", args: [BigInt(m.batchId)] });
    const validUntil = (await client.getBlock()).timestamp + 300n;
    for (const [i, id] of ids.slice(0, m.markets.length).entries()) {
      await send(m.pool, poolA.abi, "setQuote", [id, BigInt(m.markets[i].unitsPerRip), validUntil, keccak256(toHex(`fork:${id}:${validUntil}`))]);
    }
    console.log(`[quotes ${new Date().toISOString().slice(11, 19)}] refreshed ${m.markets.length} house quotes`);
    await new Promise((r) => setTimeout(r, 120_000));
  }
}

// Safe v1.4.1 on Base (canonical deployments).
const SAFE_PROXY_FACTORY = "0x4e1DCf7AD4e460CfD30791CCC4F9c8a4f820ec67";
const SAFE_L2 = "0x29fcB43b46531BcA003ddC8FCB67FFE91900C762";
const SAFE_FALLBACK_HANDLER = "0xfd0732Dc9E303f09fCEf3a7388Ad10A83459Ec99";
const MULTI_SEND_CALL_ONLY = "0x9641d764fc13c8B624c04430C7356C1C7C8102e2";
const safeAbi = parseAbi([
  "function setup(address[] owners, uint256 threshold, address to, bytes data, address fallbackHandler, address paymentToken, uint256 payment, address paymentReceiver)",
  "function nonce() view returns (uint256)",
  "function execTransaction(address to, uint256 value, bytes data, uint8 operation, uint256 safeTxGas, uint256 baseGas, uint256 gasPrice, address gasToken, address refundReceiver, bytes signatures) payable returns (bool)",
  "function createProxyWithNonce(address singleton, bytes initializer, uint256 saltNonce) returns (address)",
  "event ProxyCreation(address indexed proxy, address singleton)",
  "event ExecutionFailure(bytes32 txHash, uint256 payment)",
  "function multiSend(bytes transactions) payable",
]);

/** A second pool whose operator is a 2-of-2 Safe (fork operator + a cosigner),
 * holding stock for ten house markets. Batches, markets and quotes are then set
 * up from /ops as the Safe's signers would, with `exec` standing in for Safe{Wallet}. */
async function deploySafePool() {
  const m = JSON.parse(await readFile(MANIFEST, "utf8"));
  const cosignerKey = generatePrivateKey();
  const owners = [operator.address, privateKeyToAccount(cosignerKey).address];
  const initializer = encodeFunctionData({ abi: safeAbi, functionName: "setup", args: [owners, 2n, zeroAddress, "0x", SAFE_FALLBACK_HANDLER, zeroAddress, 0n, zeroAddress] });
  const r = await send(SAFE_PROXY_FACTORY, safeAbi, "createProxyWithNonce", [SAFE_L2, initializer, BigInt(Date.now())]);
  const created = r.logs.map((l) => { try { return decodeEventLog({ abi: safeAbi, ...l }); } catch { return null; } }).find((e) => e?.eventName === "ProxyCreation");
  const safe = created.args.proxy;
  const poolA = await artifact("MarketRipPool");
  const poolDeployBlock = await client.getBlockNumber();
  const pool = await deploy(poolA, [USDC, m.vault, m.factory, m.put, safe]);
  for (const mk of m.markets) await borrow(mk.token, safe, BigInt(mk.unitsPerRip) * 10n);
  m.safe = { address: safe, owners, cosignerKey, pool, poolDeployBlock: poolDeployBlock.toString() };
  await writeFile(MANIFEST, JSON.stringify(m, null, 2));
  console.log(`Safe ${safe} (2 of 2) operates pool ${pool}; it holds stock for ${m.markets.length} house markets.`);
}

/** Executes a Transaction Builder file the way Safe{Wallet} does: one call
 * directly, several through MultiSendCallOnly; both owners sign the SafeTx. */
async function execBatch(file) {
  const m = JSON.parse(await readFile(MANIFEST, "utf8"));
  const batch = JSON.parse(await readFile(file, "utf8"));
  if (batch.chainId !== "8453" || batch.meta.createdFromSafeAddress.toLowerCase() !== m.safe?.address.toLowerCase()) throw new Error("This batch is not for the fork's Safe.");
  const txs = batch.transactions;
  const [to, data, operation] = txs.length === 1 ? [txs[0].to, txs[0].data, 0]
    : [MULTI_SEND_CALL_ONLY, encodeFunctionData({ abi: safeAbi, functionName: "multiSend", args: [concat(txs.map((t) => encodePacked(["uint8", "address", "uint256", "uint256", "bytes"], [0, t.to, BigInt(t.value), BigInt(size(t.data)), t.data])))] }), 1];
  const nonce = await client.readContract({ address: m.safe.address, abi: safeAbi, functionName: "nonce" });
  const message = { to, value: 0n, data, operation, safeTxGas: 0n, baseGas: 0n, gasPrice: 0n, gasToken: zeroAddress, refundReceiver: zeroAddress, nonce };
  const types = { SafeTx: [{ name: "to", type: "address" }, { name: "value", type: "uint256" }, { name: "data", type: "bytes" }, { name: "operation", type: "uint8" }, { name: "safeTxGas", type: "uint256" }, { name: "baseGas", type: "uint256" }, { name: "gasPrice", type: "uint256" }, { name: "gasToken", type: "address" }, { name: "refundReceiver", type: "address" }, { name: "nonce", type: "uint256" }] };
  const signers = [operator, privateKeyToAccount(m.safe.cosignerKey)].sort((a, b) => (BigInt(a.address) < BigInt(b.address) ? -1 : 1));
  const signatures = concat(await Promise.all(signers.map((a) => a.signTypedData({ domain: { chainId: 8453, verifyingContract: m.safe.address }, types, primaryType: "SafeTx", message }))));
  const r = await send(m.safe.address, safeAbi, "execTransaction", [to, 0n, data, operation, 0n, 0n, 0n, zeroAddress, zeroAddress, signatures]);
  if (r.logs.some((l) => { try { return decodeEventLog({ abi: safeAbi, ...l }).eventName === "ExecutionFailure"; } catch { return false; } })) throw new Error(`The Safe ran "${batch.meta.name}" but it reverted.`);
  console.log(`Executed "${batch.meta.name}" (${txs.length} call${txs.length === 1 ? "" : "s"}) as Safe nonce ${nonce}.`);
}

if (mode === "deploy") await deployAll();
else if (mode === "quotes") await refreshQuotes();
else if (mode === "safe") await deploySafePool();
else if (mode === "exec") await execBatch(process.argv[3]);
else console.log("node scripts/rips-fork.mjs deploy|quotes|safe|exec <file>");
