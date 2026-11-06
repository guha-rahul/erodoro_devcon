/** Isolated Base Sepolia fixture: real transactions, explicitly mock economics.
 * No pilot configuration is changed. Never usable on mainnet.
 * node scripts/rips-sepolia.mjs balance|deploy|seed|quotes [positionId]|keep-quotes|mint|batch|newpool
 * `newpool` deploys a fresh pool on the existing vault/factory/oracle/put and
 * writes it to RIP_TEST_NEW_MANIFEST, reusing the test stock tokens; run `batch`
 * against that manifest next. The source manifest is left untouched.
 * `batch` starts a new batch of test versions of the ten Coinbase stocks, priced
 * from their Chainlink feeds on Base mainnet (reference only; settlement stays mock).
 * RIP_TEST_KEY_FILE defaults to the session-only wallet under /tmp.
 */
import { readFile, writeFile } from "node:fs/promises";
import { createPublicClient, createWalletClient, http, erc20Abi, keccak256, toHex, formatEther } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { baseSepolia } from "viem/chains";
import { marketExpiry } from "./lib/market-expiry.mjs";
const keyFile = process.env.RIP_TEST_KEY_FILE ?? "/tmp/erodoro-rips-sepolia-test-wallet.json";
const { privateKey } = JSON.parse(await readFile(keyFile, "utf8"));
const account = privateKeyToAccount(privateKey);
const transport = http(process.env.RIP_TEST_RPC_URL ?? "https://sepolia.base.org");
const client = createPublicClient({ chain: baseSepolia, transport, pollingInterval: 1000 });
const wallet = createWalletClient({ account, chain: baseSepolia, transport });
if (await client.getChainId() !== 84532) throw new Error("This script only uses Base Sepolia.");
const mode = process.argv[2] ?? "balance";
const manifestFile = process.env.RIP_TEST_MANIFEST ?? "/tmp/erodoro-rips-sepolia-deployment.json";
const quote = "0xbD85b60dA2b9B667eb215e0F050047dBBFC46B13";
const artifact = async (name) => JSON.parse(await readFile(new URL(`../contracts/out/${name}.sol/${name}.json`, import.meta.url), "utf8"));
const poolArtifact = await artifact("MarketRipPool");
async function receipt(hash) {
  const r = await client.waitForTransactionReceipt({ hash, confirmations: 2 });
  if (r.status !== "success") throw new Error(`Transaction reverted: ${hash}`);
  return r;
}
/** A long-running quote keeper may share this key, so a send can lose a nonce race; retry with a fresh nonce. */
async function retryNonce(submit) {
  for (let attempt = 1; ; attempt++) {
    try { return await submit(); }
    catch (e) {
      if (attempt >= 5 || !/nonce too low|replacement transaction underpriced|already known/i.test(e.details ?? e.message)) throw e;
      await new Promise(r => setTimeout(r, 3000));
    }
  }
}
async function send(address, abi, functionName, args = []) {
  const hash = await retryNonce(() => wallet.writeContract({ address, abi, functionName, args }));
  await receipt(hash); return hash;
}
if (mode === "balance") {
  console.log(JSON.stringify({ address: account.address, chainId: 84532, testETH: formatEther(await client.getBalance({ address: account.address })) }));
} else if (mode === "mint") {
  const abi = (await artifact("TestQuoteToken")).abi;
  console.log(await send(quote, abi, "mint", [account.address, 100_000_000n]));
} else if (mode === "quotes") {
  const m = JSON.parse(await readFile(manifestFile, "utf8"));
  const selected = process.argv[3];
  if (selected && !m.positionIds.some(id => String(id) === selected)) throw new Error("Choose a position ID from the isolated test manifest.");
  const ids = selected ? m.positionIds.filter(id => String(id) === selected) : m.positionIds;
  const validUntil = (await client.getBlock()).timestamp + 300n;
  for (const id of ids) await send(m.pool, poolArtifact.abi, "setQuote", [BigInt(id), BigInt(m.quoteUnits?.[id] ?? 10_000_000), validUntil, keccak256(toHex(`test-only:${id}:${validUntil}`))]);
  console.log("Test-only quotes refreshed for five minutes.");
} else if (mode === "keep-quotes") {
  // Long-running keeper: refreshes only quotes about to lapse on positions that
  // can still sell, so restarts or a second copy do not double-spend gas, and
  // exits once every position has expired.
  const m = JSON.parse(await readFile(manifestFile, "utf8"));
  const lead = BigInt(process.env.RIP_TEST_QUOTE_LEAD ?? 75);
  const low = BigInt(process.env.RIP_TEST_LOW_BALANCE ?? 300_000_000_000_000);
  const log = (msg) => console.log(`${new Date().toISOString()} ${msg}`);
  for (;;) {
    try {
      const now = (await client.getBlock()).timestamp;
      const positions = await Promise.all(m.positionIds.map(async id => [id, await client.readContract({ address: m.pool, abi: poolArtifact.abi, functionName: "position", args: [BigInt(id)] })]));
      const open = positions.filter(([, p]) => BigInt(p.expiry) > now);
      if (open.length === 0) { log("Every position has expired; nothing left to quote."); break; }
      const due = open.filter(([, p]) => p.remainingUnits >= p.unitsPerRip && p.remainingUnits > 0n && BigInt(p.quoteValidUntil) < now + lead);
      if (due.length) {
        const until = now + 300n;
        for (const [id, p] of due) {
          const validUntil = until < BigInt(p.expiry) ? until : BigInt(p.expiry);
          await send(m.pool, poolArtifact.abi, "setQuote", [BigInt(id), BigInt(m.quoteUnits?.[id] ?? 10_000_000), validUntil, keccak256(toHex(`test-only:${id}:${validUntil}`))]);
        }
        const balance = await client.getBalance({ address: account.address });
        log(`Refreshed ${due.length} quote(s); ${formatEther(balance)} test ETH left.${balance < low ? " LOW: fund " + account.address + " with Base Sepolia ETH." : ""}`);
      }
    } catch (e) { log(`Refresh failed, retrying: ${e.shortMessage ?? e.message}`); }
    await new Promise(r => setTimeout(r, 30_000));
  }
} else if (mode === "batch") {
  // Test versions of the real stocks: Chainlink spot, strike +5%, Black-Scholes quote.
  const FEEDS = {
    NVDA: ["NVIDIA", "0x04689a41629776563E6822F76f2e57D148d28513"], AAPL: ["Apple", "0x787f13dEa48Db0897CbCDD985de77809D837F988"],
    MSFT: ["Microsoft", "0xeB10A6c9aa7E537aEd766C08c35Dae35B321b18c"], AMZN: ["Amazon", "0x06A8E4b3aBB3B7543d8396FB2B763d22820cB295"],
    GOOGL: ["Alphabet", "0x5bF49E0ffA937CE2FfF033c739aD7C634c4D34F2"], META: ["Meta", "0x6526aE6797A76123638b863AeE4dD27Ba4E4b27D"],
    TSLA: ["Tesla", "0xFaf869185383a24F8cb00e27BdA6b63B9905DCb4"], SNDK: ["SanDisk", "0x388b0dC46C0Fb05A74BeE0994fa5b02c6Fcca2eA"],
    MSTR: ["Strategy", "0xB3cE282CD188b35DA0E38D8Bc7d58e33173D202a"], SPCX: ["SpaceX", "0x6A634B235903C4ad6376892180d6fF8612e3Fa68"],
  };
  const VOL = Number(process.env.RIP_TEST_VOL ?? 0.5);
  const m = JSON.parse(await readFile(manifestFile, "utf8"));
  if (m.chainId !== 84532 || m.wallet.toLowerCase() !== account.address.toLowerCase()) throw new Error("Wrong test fixture owner or chain.");
  m.transactions ??= {}; m.quoteUnits ??= {};
  const save = () => writeFile(manifestFile, JSON.stringify(m, null, 2));
  async function once(key, submit) {
    const hash = m.transactions[key] ?? await retryNonce(submit);
    m.transactions[key] = hash; await save();
    return receipt(hash);
  }
  const mainnet = createPublicClient({ chain: { ...baseSepolia, id: 8453, name: "Base" }, transport: http(process.env.RIP_MAINNET_RPC_URL ?? "https://mainnet.base.org") });
  const feedAbi = [{ type: "function", name: "latestRoundData", stateMutability: "view", inputs: [], outputs: [{ type: "uint80" }, { type: "int256" }, { type: "uint256" }, { type: "uint256" }, { type: "uint80" }] }];
  const pool = m.pool;
  const va = (await artifact("ErodoroVault")).abi;
  const fa = (await artifact("Factory")).abi;
  const tokenArtifact = await artifact("MockB20Asset");
  m.refBatch ??= { tokens: {}, n: Date.now() };
  const tag = `ref${m.refBatch.n}`;
  const batchId = m.refBatch.batchId ? BigInt(m.refBatch.batchId) : await client.readContract({ address: pool, abi: poolArtifact.abi, functionName: "nextBatchId" });
  m.refBatch.batchId = batchId.toString(); await save();
  // RIP_TEST_EXPIRY_MINUTES: a short Base Sepolia batch (the pool allows one hour or more there), so a full
  // sell, settle and redeem cycle can run in a day. Chainlink's stock feeds update 24/5, so any weekday time works.
  const nowSec = Number((await client.getBlock()).timestamp);
  const batchExpiry = process.env.RIP_TEST_EXPIRY_MINUTES
    ? BigInt(nowSec + Number(process.env.RIP_TEST_EXPIRY_MINUTES) * 60)
    : marketExpiry(nowSec, Number(process.env.RIP_TEST_DAYS ?? 30));
  await once(`${tag}:createBatch`, () => wallet.writeContract({ address: pool, abi: poolArtifact.abi, functionName: "createBatch", args: [batchExpiry] }));
  const expiry = await client.readContract({ address: pool, abi: poolArtifact.abi, functionName: "batchExpiry", args: [batchId] });
  const years = Number(expiry - (await client.getBlock()).timestamp) / (365 * 86400);
  const cdf = (x) => { const t = 1 / (1 + 0.2316419 * Math.abs(x)); const d = 0.3989423 * Math.exp(-x * x / 2); const p = d * t * (0.3193815 + t * (-0.3565638 + t * (1.781478 + t * (-1.821256 + t * 1.330274)))); return x > 0 ? 1 - p : p; };
  for (const [ticker, [name, feed]] of Object.entries(FEEDS)) {
    const k = `${tag}:${ticker}`;
    let token = m.refBatch.tokens[ticker];
    if (!token) {
      const r = await once(`${k}:deploy`, () => wallet.deployContract({ abi: tokenArtifact.abi, bytecode: tokenArtifact.bytecode.object, args: [`Test ${name} (not security)`, `t${ticker}`, 8, false] }));
      token = m.refBatch.tokens[ticker] = r.contractAddress; await save();
    }
    const [, answer] = await mainnet.readContract({ address: feed, abi: feedAbi, functionName: "latestRoundData" });
    const spotRaw = m.refBatch[`${ticker}:spot`] ? BigInt(m.refBatch[`${ticker}:spot`]) : answer;
    m.refBatch[`${ticker}:spot`] = spotRaw.toString(); await save();
    const strikeRaw = (spotRaw * 105n + 99n) / 100n;
    const S = Number(spotRaw) / 1e8, K = Number(strikeRaw) / 1e8;
    const d1 = (Math.log(S / K) + VOL * VOL * years / 2) / (VOL * Math.sqrt(years)), d2 = d1 - VOL * Math.sqrt(years);
    const premium = Math.max(0.01, S * cdf(d1) - K * cdf(d2));
    // Fixed at first run: a resumed run must split exactly what was minted.
    const unitsPerRip = BigInt(m.refBatch[`${ticker}:unitsPerRip`] ?? Math.floor(1e8 / premium));
    m.refBatch[`${ticker}:unitsPerRip`] = unitsPerRip.toString(); await save();
    const inventory = unitsPerRip * 5n;
    // With the CRE settlement oracle, a feed ID names the Chainlink feed itself, so the CRE workflow's
    // configuration doesn't change between batches.
    const feedId = keccak256(toHex(m.creFeedIds ? `chainlink:${ticker}/USD` : `RIPS-REF-${tag}-${ticker}`));
    await once(`${k}:configuration`, () => wallet.writeContract({ address: m.factory, abi: fa, functionName: "setSettlementConfiguration", args: [{ collateral: token, oracle: m.oracle, fallbackOracle: "0x0000000000000000000000000000000000000000", feedId, settlementModel: 1, fallbackDelay: 0, priceDecimals: 8 }] }));
    const params = { collateral: token, oracle: m.oracle, fallbackOracle: "0x0000000000000000000000000000000000000000", feeRecipient: account.address, feedId, fallbackRequestId: `0x${"00".repeat(32)}`, settlementModel: 1, strike: strikeRaw, minSplitAmount: 0n, maturity: expiry, settlementDelay: 60n, maxPriceLag: BigInt(process.env.RIP_TEST_PRICE_LAG ?? 3600), fallbackDelay: 0n, maxConfBps: 0, feeBps: 0, priceDecimals: 8, admin: account.address };
    const seriesId = await client.readContract({ address: m.vault, abi: va, functionName: "seriesIdFor", args: [m.factory, params] });
    await once(`${k}:series`, () => wallet.writeContract({ address: m.factory, abi: fa, functionName: "createSeries", args: [params, account.address] }));
    await once(`${k}:mint`, () => wallet.writeContract({ address: token, abi: tokenArtifact.abi, functionName: "mint", args: [account.address, inventory] }));
    await once(`${k}:approve`, () => wallet.writeContract({ address: token, abi: erc20Abi, functionName: "approve", args: [m.vault, inventory] }));
    await once(`${k}:split`, () => wallet.writeContract({ address: m.vault, abi: va, functionName: "split", args: [seriesId, inventory] }));
    const validUntil = (await client.getBlock()).timestamp + 300n;
    await once(`${k}:position`, () => wallet.writeContract({ address: pool, abi: poolArtifact.abi, functionName: "addPosition", args: [{ batchId, stock: token, direction: 0, claimId: seriesId | 1n, spotAtCreation: spotRaw, unitsPerRip, quoteValidUntil: validUntil, quoteRef: keccak256(toHex(`test-only:${tag}:${ticker}`)) }] }));
    console.log(`t${ticker}: spot $${S.toFixed(2)} strike $${K.toFixed(2)} claim $${premium.toFixed(2)} (vol ${VOL})`);
  }
  const positionIds = await client.readContract({ address: pool, abi: poolArtifact.abi, functionName: "batchPositions", args: [batchId] });
  const validUntil = (await client.getBlock()).timestamp + 300n;
  for (const [i, id] of positionIds.entries()) {
    const units = BigInt(m.refBatch[`${Object.keys(FEEDS)[i]}:unitsPerRip`]);
    m.quoteUnits[id.toString()] = units.toString();
    await send(pool, poolArtifact.abi, "setQuote", [id, units, validUntil, keccak256(toHex(`test-only:${id}:${validUntil}`))]);
  }
  if (await client.readContract({ address: pool, abi: poolArtifact.abi, functionName: "activeBatchId" }) !== batchId)
    await send(pool, poolArtifact.abi, "activateBatch", [batchId]);
  m.positionIds = positionIds.map(String); m.tokens = Object.values(m.refBatch.tokens); await save();
  console.log(`Batch ${batchId} active with Chainlink-referenced test stocks.`);
} else if (mode === "newpool") {
  const from = JSON.parse(await readFile(manifestFile, "utf8"));
  const target = process.env.RIP_TEST_NEW_MANIFEST;
  if (!target || target === manifestFile) throw new Error("Set RIP_TEST_NEW_MANIFEST to a new manifest path.");
  if (from.chainId !== 84532 || from.wallet.toLowerCase() !== account.address.toLowerCase()) throw new Error("Wrong test fixture owner or chain.");
  let m;
  try { m = JSON.parse(await readFile(target, "utf8")); }
  catch (error) {
    if (error.code !== "ENOENT") throw error;
    m = { chainId: 84532, mockEconomics: true, wallet: account.address, quote, vault: from.vault, factory: from.factory, oracle: from.oracle, put: from.put,
      tokens: from.tokens ?? [], positionIds: [], transactions: {}, quoteUnits: {}, refBatch: { tokens: from.refBatch?.tokens ?? {}, n: from.refBatch?.n ?? Date.now() }, deployedAt: new Date().toISOString() };
  }
  const save = () => writeFile(target, JSON.stringify(m, null, 2));
  await save();
  async function step(key, submit) {
    const hash = m.transactions[key] ?? await submit();
    m.transactions[key] = hash; await save();
    return receipt(hash);
  }
  if (!m.pool) {
    const r = await step("deploy:pool", () => wallet.deployContract({ abi: poolArtifact.abi, bytecode: poolArtifact.bytecode.object, args: [quote, m.vault, m.factory, m.put, account.address] }));
    m.pool = r.contractAddress; m.poolDeployBlock = r.blockNumber.toString(); await save();
    console.log(`MarketRipPool: ${m.pool} https://sepolia.basescan.org/tx/${r.transactionHash}`);
  }
  const va = (await artifact("ErodoroVault")).abi;
  await step("operator", () => wallet.writeContract({ address: m.vault, abi: va, functionName: "setOperator", args: [m.pool, true] }));
  console.log(`Saved ${target}. Next: RIP_TEST_MANIFEST=${target} node scripts/rips-sepolia.mjs batch`);
} else if (mode === "deploy" || mode === "seed") {
  if (await client.getBalance({ address: account.address }) === 0n) throw new Error(`Fund ${account.address} with Base Sepolia test ETH first.`);
  let manifest;
  if (mode === "seed") {
    manifest = JSON.parse(await readFile(manifestFile, "utf8"));
    if (manifest.chainId !== 84532 || manifest.wallet.toLowerCase() !== account.address.toLowerCase() || !manifest.mockEconomics) throw new Error("Wrong test fixture owner or chain.");
  } else {
    try { await readFile(manifestFile); throw new Error("A test deployment already exists. Use seed to resume it."); }
    catch (error) { if (error.code !== "ENOENT") throw error; }
    manifest = { chainId: 84532, mockEconomics: true, wallet: account.address, quote, tokens: [], positionIds: [], transactions: {}, deployedAt: new Date().toISOString() };
  }
  manifest.transactions ??= {};
  const save = () => writeFile(manifestFile, JSON.stringify(manifest, null, 2));
  await save();
  // Persist each submitted hash before awaiting it. A restart verifies receipts
  // and skips completed actions rather than deploying or splitting twice.
  async function step(key, submit) {
    const hash = manifest.transactions[key] ?? await submit();
    manifest.transactions[key] = hash; await save();
    const r = await receipt(hash); return r;
  }
  async function core(key, name, args = []) {
    if (manifest[key]) return manifest[key];
    const a = await artifact(name);
    const r = await step(`deploy:${key}`, () => wallet.deployContract({ abi: a.abi, bytecode: a.bytecode.object, args }));
    manifest[key] = r.contractAddress;
    if (key === "pool") manifest.poolDeployBlock = r.blockNumber.toString();
    await save(); console.log(`${name}: ${r.contractAddress} https://sepolia.basescan.org/tx/${r.transactionHash}`);
    return r.contractAddress;
  }
  async function once(key, address, abi, functionName, args = []) {
    return step(key, () => wallet.writeContract({ address, abi, functionName, args }));
  }
  const vault = await core("vault", "ErodoroVault");
  const factory = await core("factory", "Factory", [vault, account.address, { minHorizon: 7n * 86400n, maxHorizon: 365n * 86400n, minSettlementDelay: 60, maxSettlementDelay: 86400, minPriceLag: 1, maxPriceLag: 90000, maxConfBps: 500, maxFeeBps: 100, priceDecimals: 8 }]);
  const oracle = await core("oracle", "MockOracleAdapter", [1]);
  const put = await core("put", "MarketRipPut", [quote, account.address]);
  const pool = await core("pool", "MarketRipPool", [quote, vault, factory, put, account.address]);
  const va = (await artifact("ErodoroVault")).abi;
  const fa = (await artifact("Factory")).abi;
  const ta = (await artifact("MockB20Asset")).abi;
  const tokens = manifest.tokens;
  const batchId = manifest.batchId ? BigInt(manifest.batchId) : await client.readContract({ address: pool, abi: poolArtifact.abi, functionName: "nextBatchId" });
  manifest.batchId = batchId.toString(); await save();
  await once("createBatch", pool, poolArtifact.abi, "createBatch", [marketExpiry(Number((await client.getBlock()).timestamp), Number(process.env.RIP_TEST_DAYS ?? 30))]);
  const expiry = await client.readContract({ address: pool, abi: poolArtifact.abi, functionName: "batchExpiry", args: [batchId] });
  await once("operator", vault, va, "setOperator", [pool, true]);
  for (let index = 0; index < 10; index++) {
    const token = await core(`token${index}`, "MockB20Asset", [`Test asset ${index + 1} (not security)`, `tRIP${index + 1}`, 8, false]);
    tokens[index] = token; await save();
    const feedId = keccak256(toHex(`RIPS-TEST-${index}`));
    await once(`configuration:${index}`, factory, fa, "setSettlementConfiguration", [{ collateral: token, oracle, fallbackOracle: "0x0000000000000000000000000000000000000000", feedId, settlementModel: 1, fallbackDelay: 0, priceDecimals: 8 }]);
    const params = { collateral: token, oracle, fallbackOracle: "0x0000000000000000000000000000000000000000", feeRecipient: account.address, feedId, fallbackRequestId: `0x${"00".repeat(32)}`, settlementModel: 1, strike: 10_500_000_000n, minSplitAmount: 0n, maturity: expiry, settlementDelay: 60n, maxPriceLag: 3600n, fallbackDelay: 0n, maxConfBps: 0, feeBps: 0, priceDecimals: 8, admin: account.address };
    const seriesId = await client.readContract({ address: vault, abi: va, functionName: "seriesIdFor", args: [factory, params] });
    await once(`series:${index}`, factory, fa, "createSeries", [params, account.address]);
    await once(`mint:${index}`, token, ta, "mint", [account.address, 500_000_000n]);
    await once(`approve:${index}`, token, erc20Abi, "approve", [vault, 500_000_000n]);
    await once(`split:${index}`, vault, va, "split", [seriesId, 500_000_000n]);
    const validUntil = (await client.getBlock()).timestamp + 300n;
    await once(`position:${index}`, pool, poolArtifact.abi, "addPosition", [{ batchId, stock: token, direction: 0, claimId: seriesId | 1n, spotAtCreation: 10_000_000_000n, unitsPerRip: 100_000_000n, quoteValidUntil: validUntil, quoteRef: keccak256(toHex(`test-only:initial:${index}`)) }]);
  }
  const positionIds = await client.readContract({ address: pool, abi: poolArtifact.abi, functionName: "batchPositions", args: [batchId] });
  // Test quotes have no economic value; sufficient inventory for each UI amount.
  const validUntil = (await client.getBlock()).timestamp + 300n;
  for (const id of positionIds) await send(pool, poolArtifact.abi, "setQuote", [id, 10_000_000n, validUntil, keccak256(toHex(`test-only:${id}:${validUntil}`))]);
  await send(pool, poolArtifact.abi, "activateBatch", [batchId]);
  manifest.positionIds = positionIds.map(String);
  manifest.seededAt = new Date().toISOString();
  await save();
  console.log(`Saved public test deployment to ${manifestFile}. Restart app with NEXT_PUBLIC_RIP_POOL_ADDRESS=${pool} NEXT_PUBLIC_RIP_PUT_ADDRESS=${put}.`);
} else throw new Error("Use balance, deploy, seed, quotes, mint, batch, or newpool.");
