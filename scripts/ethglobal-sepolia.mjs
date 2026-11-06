/** ETHGlobal Mumbai additions to the Base Sepolia Rips fixture: real transactions, mock stock economics.
 * node scripts/ethglobal-sepolia.mjs deploy|resale|status
 *
 * `deploy` adds, on the source fixture's vault, factory and put:
 *  - CreSettlementOracle: Chainlink stock prices pushed by the CRE `rips-prices` workflow, used to settle.
 *  - HumanRegistry: World ID humans reported by the CRE `verify-human` workflow, with a cap per human per batch.
 *  - a new MarketRipPool gated by that registry.
 *  - RipsResaleHook: the Uniswap v4 hook that lets only verified humans trade Rips resale pools.
 * It writes RIP_TEST_NEW_MANIFEST; then run `rips-sepolia.mjs batch` against it, then `resale`.
 *
 * `resale` opens a Uniswap v4 pool for each position's upside claim (wrapped as ERC-20) against test USDC at
 * the house quote, with liquidity from the house.
 *
 * Keys come from RIP_TEST_KEY_FILE, as in rips-sepolia.mjs. Never usable on mainnet.
 */
import { readFile, writeFile } from "node:fs/promises";
import {
  concat, createPublicClient, createWalletClient, encodeAbiParameters, encodeDeployData, erc20Abi, formatEther,
  getContractAddress, http, keccak256, maxUint256, numberToHex, parseAbi, parseAbiParameters, toHex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { baseSepolia } from "viem/chains";

const keyFile = process.env.RIP_TEST_KEY_FILE ?? "/tmp/erodoro-rips-sepolia-test-wallet.json";
const { privateKey } = JSON.parse(await readFile(keyFile, "utf8"));
const account = privateKeyToAccount(privateKey);
const transport = http(process.env.RIP_TEST_RPC_URL ?? "https://sepolia.base.org");
const client = createPublicClient({ chain: baseSepolia, transport, pollingInterval: 1000 });
const wallet = createWalletClient({ account, chain: baseSepolia, transport });
if (await client.getChainId() !== 84532) throw new Error("This script only uses Base Sepolia.");

const mode = process.argv[2] ?? "status";
const quote = "0xbD85b60dA2b9B667eb215e0F050047dBBFC46B13";
/** Chainlink CRE's simulation forwarder on Base Sepolia (`cre workflow simulate --broadcast`). */
const CRE_MOCK_FORWARDER = "0x82300bd7c3958625581cc2f77bc6464dcecdf3e5";
/** Uniswap v4 on Base Sepolia. */
const UNISWAP = {
  poolManager: "0x05E73354cFDd6745C338b50BcFDfA3Aa6fA03408",
  positionManager: "0x4B2C77d209D3405F41a037Ec6c77F7F5b8e2ca80",
  universalRouter: "0x492E6456D9528771018DeB9E87ef7750EF184104",
  v4Quoter: "0x4A6513c898fe1B2d0E78d3b0e0A4a151589B1cBa",
  stateView: "0x571291b572ed32ce6751a2Cb2486EbEe8DEfB9B4",
  permit2: "0x000000000022D473030F116dDEE9F6B43aC78BA3",
};
const CREATE2_DEPLOYER = "0x4e59b44847b379578588920cA78FbF26c0B4956C";
/** beforeInitialize | beforeAddLiquidity | beforeSwap: the low 14 bits a v4 hook address must carry. */
const HOOK_FLAGS = (1n << 13n) | (1n << 11n) | (1n << 7n);
const ALL_HOOK_MASK = (1n << 14n) - 1n;
/** Default per-human cap: $5 of Rips per batch, the size of one house position. */
const MAX_SPEND_PER_BATCH = BigInt(process.env.RIP_HUMAN_CAP_USDC ?? 5_000_000);
const FEE = 3000;
const TICK_SPACING = 60;
const FULL_RANGE = 887220;

const artifact = async (name) => JSON.parse(await readFile(new URL(`../contracts/out/${name}.sol/${name}.json`, import.meta.url), "utf8"));
async function receipt(hash) {
  const r = await client.waitForTransactionReceipt({ hash, confirmations: 2 });
  if (r.status !== "success") throw new Error(`Transaction reverted: ${hash}`);
  return r;
}

const target = process.env.RIP_TEST_NEW_MANIFEST ?? process.env.RIP_TEST_MANIFEST;
if (!target) throw new Error("Set RIP_TEST_NEW_MANIFEST (deploy) or RIP_TEST_MANIFEST.");
let m;
try { m = JSON.parse(await readFile(target, "utf8")); }
catch (error) {
  if (error.code !== "ENOENT" || mode !== "deploy") throw error;
  const sourceFile = process.env.RIP_TEST_MANIFEST;
  if (!sourceFile || sourceFile === target) throw new Error("Set RIP_TEST_MANIFEST to the source fixture.");
  const from = JSON.parse(await readFile(sourceFile, "utf8"));
  if (from.chainId !== 84532 || from.wallet.toLowerCase() !== account.address.toLowerCase()) throw new Error("Wrong test fixture owner or chain.");
  m = { chainId: 84532, mockEconomics: true, wallet: account.address, quote, vault: from.vault, factory: from.factory, put: from.put,
    tokens: [], positionIds: [], transactions: {}, quoteUnits: {}, refBatch: { tokens: {}, n: Date.now() }, creFeedIds: true,
    uniswap: UNISWAP, deployedAt: new Date().toISOString() };
}
if (m.chainId !== 84532 || m.wallet.toLowerCase() !== account.address.toLowerCase()) throw new Error("Wrong test fixture owner or chain.");
const save = () => writeFile(target, JSON.stringify(m, null, 2));
/** The quote keeper shares this key, so a send can lose a nonce race; try again with a fresh nonce. */
async function submitWithRetry(submit) {
  for (let attempt = 1; ; attempt++) {
    try { return await submit(); }
    catch (e) {
      if (attempt >= 5 || !/nonce too low|replacement transaction underpriced|already known/i.test(e.details ?? e.message)) throw e;
      await new Promise(r => setTimeout(r, 3000));
    }
  }
}
async function step(key, submit) {
  const hash = m.transactions[key] ?? await submitWithRetry(submit);
  m.transactions[key] = hash; await save();
  return receipt(hash);
}
async function deploy(key, name, args) {
  if (m[key]) return m[key];
  const a = await artifact(name);
  const r = await step(`deploy:${key}`, () => wallet.deployContract({ abi: a.abi, bytecode: a.bytecode.object, args }));
  m[key] = r.contractAddress; await save();
  console.log(`${name}: ${m[key]} https://sepolia.basescan.org/tx/${r.transactionHash}`);
  return m[key];
}

if (mode === "status") {
  console.log(JSON.stringify({ address: account.address, testETH: formatEther(await client.getBalance({ address: account.address })),
    oracle: m.oracle, registry: m.registry, pool: m.pool, hook: m.hook, resalePools: Object.keys(m.resale ?? {}).length }, null, 2));
} else if (mode === "deploy") {
  await save();
  const [oracleA, registryA, poolA, vaultA, factoryA, hookA] = await Promise.all(
    ["CreSettlementOracle", "HumanRegistry", "MarketRipPool", "ErodoroVault", "Factory", "RipsResaleHook"].map(artifact));

  // Chainlink CRE settlement oracle and World ID registry; the simulation sender is this operator key.
  await deploy("oracle", "CreSettlementOracle", [account.address, CRE_MOCK_FORWARDER, account.address]);
  await deploy("registry", "HumanRegistry", [account.address, CRE_MOCK_FORWARDER, account.address, MAX_SPEND_PER_BATCH]);

  // A pool that only sells to verified humans, within the per-human cap.
  if (!m.pool) {
    const r = await step("deploy:pool", () => wallet.deployContract({ abi: poolA.abi, bytecode: poolA.bytecode.object, args: [quote, m.vault, m.factory, m.put, account.address] }));
    m.pool = r.contractAddress; m.poolDeployBlock = r.blockNumber.toString(); await save();
    console.log(`MarketRipPool: ${m.pool} https://sepolia.basescan.org/tx/${r.transactionHash}`);
  }
  await step("pool:humanGate", () => wallet.writeContract({ address: m.pool, abi: poolA.abi, functionName: "setHumanGate", args: [m.registry] }));
  await step("registry:pool", () => wallet.writeContract({ address: m.registry, abi: registryA.abi, functionName: "setPool", args: [m.pool, true] }));
  await step("vault:operator", () => wallet.writeContract({ address: m.vault, abi: vaultA.abi, functionName: "setOperator", args: [m.pool, true] }));

  // Base Sepolia batches may be short, so the factory must accept series maturing within hours.
  const [minHorizon, maxHorizon, minSettlementDelay, maxSettlementDelay, minPriceLag, maxPriceLag, maxConfBps, maxFeeBps, priceDecimals] =
    await client.readContract({ address: m.factory, abi: factoryA.abi, functionName: "bounds" });
  if (minHorizon > 3600n) {
    await step("factory:bounds", () => wallet.writeContract({ address: m.factory, abi: factoryA.abi, functionName: "setBounds",
      args: [{ minHorizon: 3600n, maxHorizon, minSettlementDelay, maxSettlementDelay, minPriceLag, maxPriceLag, maxConfBps, maxFeeBps, priceDecimals }] }));
  }

  // RIP_HOOK_REDEPLOY=1 replaces the hook (e.g. after a fix); `resale` then opens a fresh set of pools for it.
  if (process.env.RIP_HOOK_REDEPLOY === "1" && m.hook) {
    (m.oldHooks ??= []).push(m.hook);
    m.hookVersion = (m.hookVersion ?? 1) + 1;
    for (const k of Object.keys(m.transactions)) if (k === "deploy:hook" || k.startsWith("hook:")) delete m.transactions[k];
    delete m.hook; await save();
  }
  // The Uniswap hook must live at an address whose low bits name its hooks, so mine a CREATE2 salt.
  if (!m.hook) {
    const initCode = encodeDeployData({ abi: hookA.abi, bytecode: hookA.bytecode.object, args: [UNISWAP.poolManager, m.registry, quote, account.address] });
    const initCodeHash = keccak256(initCode);
    let salt, address;
    for (let i = 0n; ; i++) {
      salt = numberToHex(i, { size: 32 });
      address = getContractAddress({ from: CREATE2_DEPLOYER, opcode: "CREATE2", salt, bytecodeHash: initCodeHash });
      if ((BigInt(address) & ALL_HOOK_MASK) === HOOK_FLAGS) break;
    }
    await step("deploy:hook", () => wallet.sendTransaction({ to: CREATE2_DEPLOYER, data: concat([salt, initCode]) }));
    m.hook = address; await save();
    console.log(`RipsResaleHook: ${m.hook}`);
  }
  await step("hook:router", () => wallet.writeContract({ address: m.hook, abi: hookA.abi, functionName: "setTrustedRouter", args: [UNISWAP.universalRouter, true] }));
  await step("hook:positionManager", () => wallet.writeContract({ address: m.hook, abi: hookA.abi, functionName: "setTrustedRouter", args: [UNISWAP.positionManager, true] }));
  await step("hook:quoter", () => wallet.writeContract({ address: m.hook, abi: hookA.abi, functionName: "setExempt", args: [UNISWAP.v4Quoter, true] }));
  await step("hook:house", () => wallet.writeContract({ address: m.hook, abi: hookA.abi, functionName: "setExempt", args: [account.address, true] }));
  console.log(`Saved ${target}. Next: RIP_TEST_MANIFEST=${target} RIP_TEST_EXPIRY_MINUTES=… node scripts/rips-sepolia.mjs batch`);
} else if (mode === "resale") {
  // One Uniswap v4 pool per position: wrapped upside claim vs test USDC, opened at the house's $1 quote.
  const [poolA, vaultA, wrapperA, tokenA] = await Promise.all(["MarketRipPool", "ErodoroVault", "ClaimWrapper", "MockB20Asset"].map(artifact));
  const usdcAbi = (await artifact("TestQuoteToken")).abi;
  const permit2Abi = parseAbi(["function approve(address token, address spender, uint160 amount, uint48 expiration)"]);
  const poolManagerAbi = parseAbi(["function initialize((address,address,uint24,int24,address) key, uint160 sqrtPriceX96) returns (int24)"]);
  const positionManagerAbi = parseAbi(["function modifyLiquidities(bytes unlockData, uint256 deadline) payable"]);
  const usdcPerPool = BigInt(process.env.RIP_RESALE_USDC ?? 20_000_000);
  // Pools belong to a hook; after a hook redeploy each step runs again under a new key.
  const v = m.hookVersion ?? 1;
  const tag = v > 1 ? `resale@v${v}` : "resale";
  m.resale ??= {};
  const approveForPositions = async (token) => {
    await step(`resale:${token}:permit2`, () => wallet.writeContract({ address: token, abi: erc20Abi, functionName: "approve", args: [UNISWAP.permit2, maxUint256] }));
    await step(`resale:${token}:pm`, () => wallet.writeContract({ address: UNISWAP.permit2, abi: permit2Abi, functionName: "approve", args: [token, UNISWAP.positionManager, (1n << 160n) - 1n, (1n << 48n) - 1n] }));
  };
  await step(`${tag}:usdc:batch${m.refBatch?.batchId ?? 1}`, () => wallet.writeContract({ address: quote, abi: usdcAbi, functionName: "mint", args: [account.address, usdcPerPool * BigInt(m.positionIds.length)] }));
  await approveForPositions(quote);

  for (const id of m.positionIds) {
    const p = await client.readContract({ address: m.pool, abi: poolA.abi, functionName: "position", args: [BigInt(id)] });
    const seriesId = p.claimId & ~1n;
    const units = BigInt(m.quoteUnits[id] ?? p.unitsPerRip); // N units per $1
    const r = m.resale[id] ??= {};
    if (!r.wrapper) {
      const symbol = await client.readContract({ address: p.stock, abi: erc20Abi, functionName: "symbol" });
      const d = await step(`resale:${id}:wrapper`, () => wallet.deployContract({ abi: wrapperA.abi, bytecode: wrapperA.bytecode.object,
        args: [m.vault, p.claimId, `Rip upside ${symbol} #${id}`, `RIP-${symbol}`] }));
      r.wrapper = d.contractAddress; await save();
    }
    // The house splits fresh stock for N to provide, keeping P, then wraps the N.
    const nAmount = units * (usdcPerPool / 1_000_000n);
    await step(`${tag}:${id}:mint`, () => wallet.writeContract({ address: p.stock, abi: tokenA.abi, functionName: "mint", args: [account.address, nAmount] }));
    await step(`${tag}:${id}:approveStock`, () => wallet.writeContract({ address: p.stock, abi: erc20Abi, functionName: "approve", args: [m.vault, nAmount] }));
    await step(`${tag}:${id}:split`, () => wallet.writeContract({ address: m.vault, abi: vaultA.abi, functionName: "split", args: [seriesId, nAmount] }));
    await step(`resale:${id}:wrapperOperator`, () => wallet.writeContract({ address: m.vault, abi: vaultA.abi, functionName: "setOperator", args: [r.wrapper, true] }));
    await step(`${tag}:${id}:wrap`, () => wallet.writeContract({ address: r.wrapper, abi: wrapperA.abi, functionName: "wrap", args: [nAmount] }));
    await approveForPositions(r.wrapper);

    // Price: `units` raw N per 1e6 raw USDC, as currency1 per currency0 in Q64.96.
    const usdcFirst = BigInt(quote) < BigInt(r.wrapper);
    const [currency0, currency1] = usdcFirst ? [quote, r.wrapper] : [r.wrapper, quote];
    const [amount0, amount1] = usdcFirst ? [usdcPerPool, nAmount] : [nAmount, usdcPerPool];
    const sqrtPriceX96 = sqrt((amount1 << 192n) / amount0);
    const key = [currency0, currency1, FEE, TICK_SPACING, m.hook];
    await step(`${tag}:${id}:initialize`, () => wallet.writeContract({ address: UNISWAP.poolManager, abi: poolManagerAbi, functionName: "initialize", args: [key, sqrtPriceX96] }));
    // Full range: L = amount0·√P and amount1/√P (the range ends are far enough away to ignore), less 1% for rounding.
    const Q96 = 1n << 96n;
    const l0 = amount0 * sqrtPriceX96 / Q96, l1 = amount1 * Q96 / sqrtPriceX96;
    const liquidity = (l0 < l1 ? l0 : l1) * 99n / 100n;
    const mint = encodeAbiParameters(
      parseAbiParameters("(address,address,uint24,int24,address), int24, int24, uint256, uint128, uint128, address, bytes"),
      [key, -FULL_RANGE, FULL_RANGE, liquidity, amount0, amount1, account.address, "0x"]);
    const settle = encodeAbiParameters(parseAbiParameters("address, address"), [currency0, currency1]);
    const unlockData = encodeAbiParameters(parseAbiParameters("bytes, bytes[]"), ["0x020d", [mint, settle]]); // MINT_POSITION, SETTLE_PAIR
    const deadline = (await client.getBlock()).timestamp + 600n;
    await step(`${tag}:${id}:liquidity`, () => wallet.writeContract({ address: UNISWAP.positionManager, abi: positionManagerAbi, functionName: "modifyLiquidities", args: [unlockData, deadline] }));
    Object.assign(r, { claimId: p.claimId.toString(), seriesId: seriesId.toString(), stock: p.stock, currency0, currency1, unitsPerDollar: units.toString() });
    await save();
    console.log(`Position ${id}: Uniswap pool ${currency0}/${currency1} via hook ${m.hook}`);
  }
  console.log(`Resale pools open for ${m.positionIds.length} positions.`);
} else if (mode === "set-quoter") {
  // Gives house quote refreshes their own key, so the keeper never races the operator's transactions.
  const quoter = process.argv[3];
  if (!/^0x[0-9a-fA-F]{40}$/.test(quoter ?? "")) throw new Error("Usage: set-quoter <address>");
  const poolA = await artifact("MarketRipPool");
  await step(`pool:quoter:${quoter.toLowerCase()}`, () => wallet.writeContract({ address: m.pool, abi: poolA.abi, functionName: "setQuoter", args: [quoter] }));
  console.log(`Quoter: ${await client.readContract({ address: m.pool, abi: poolA.abi, functionName: "quoter" })}`);
} else if (mode === "set-cap") {
  // USDC (whole dollars) one verified person may spend on each batch.
  const dollars = BigInt(process.argv[3] ?? "");
  const registryA = await artifact("HumanRegistry");
  await step(`registry:cap:${dollars}`, () => wallet.writeContract({ address: m.registry, abi: registryA.abi, functionName: "setMaxSpendPerBatch", args: [dollars * 1_000_000n] }));
  console.log(`Per-person cap: ${await client.readContract({ address: m.registry, abi: registryA.abi, functionName: "maxSpendPerBatch" })}`);
} else if (mode === "new-batch") {
  // Archives the finished batch so `rips-sepolia.mjs batch` starts a fresh one (new test tokens, series and quotes).
  (m.pastBatches ??= []).push({ refBatch: m.refBatch, positionIds: m.positionIds, resale: m.resale });
  m.refBatch = { tokens: {}, n: Date.now() };
  m.positionIds = []; m.resale = {};
  await save();
  console.log("Ready for a new batch.");
} else if (mode === "check-swap") {
  // Simulates a $1 buy of position 1's claim through Universal Router as the house (exempt from the hook), to
  // check the swap encoding against the deployed router. Approves the router through Permit2 once.
  const { buildSwap, universalRouterAbi, permit2Abi } = await import("../app/lib/rips/resale.ts");
  const r = m.resale[m.positionIds[0]];
  const pool = { ...r, hook: m.hook };
  await step("check:usdc", () => wallet.writeContract({ address: quote, abi: erc20Abi, functionName: "approve", args: [UNISWAP.permit2, maxUint256] }));
  await step("check:permit2", () => wallet.writeContract({ address: UNISWAP.permit2, abi: permit2Abi, functionName: "approve", args: [quote, UNISWAP.universalRouter, (1n << 160n) - 1n, (1n << 48n) - 1n] }));
  const { commands, inputs } = buildSwap(pool, "buy", 1_000_000n, 0n);
  const deadline = (await client.getBlock()).timestamp + 600n;
  await client.simulateContract({ address: UNISWAP.universalRouter, abi: universalRouterAbi, functionName: "execute", args: [commands, inputs, deadline], account });
  console.log("Universal Router accepts the swap encoding.");
} else {
  throw new Error(`Unknown mode ${mode}`);
}

function sqrt(n) {
  if (n < 2n) return n;
  let x = n, y = (x + 1n) / 2n;
  while (y < x) { x = y; y = (x + n / x) / 2n; }
  return x;
}
