"use client";

import { erc20Abi, parseAbi, parseUnits, type Address, type PublicClient } from "viem";
import { waitForTransactionReceipt, writeContract } from "wagmi/actions";
import { MarketRipPoolAbi } from "./abis";
import { BASE_SEPOLIA, DEPLOYMENT } from "./deployment";
import { stockPrice } from "./rips/prices";
import type { Catalog } from "./stock-swap";
import { wagmiConfig } from "./wagmi";

/**
 * Buy stocks on Testnet.
 *
 * There is no AMM on Base Sepolia, so a "swap" is two open test-token calls:
 * the paid side leaves the wallet (tUSDC to a burn address, or the test stock
 * burned) and the received side is minted, at the real stock's Chainlink price
 * on Base mainnet. Nothing here has value; it exists so the Mainnet path
 * (USDC → stock → deposit → Rips) can be clicked end to end with test assets.
 */

export const TEST_SWAP_CHAIN = 84532 as const;
export const TEST_USDC = BASE_SEPOLIA.quote!.token;
/** What "Get test USDC" mints per click. */
export const TEST_USDC_GRANT = parseUnits("1000", 6);
const BURN = "0x000000000000000000000000000000000000dEaD" as Address;
const TEST_TOKEN_ABI = parseAbi(["function mint(address to, uint256 amount)", "function burnBlocked(address from, uint256 amount)"]);

/** The test stocks the Rips pool lists in its active batch, as a swap catalog. */
export async function testCatalog(client: PublicClient): Promise<Catalog> {
  const pool = DEPLOYMENT.contracts.ripPool;
  if (!pool) throw new Error("No Testnet pool is configured, so there are no test stocks.");
  const batch = await client.readContract({ address: pool, abi: MarketRipPoolAbi, functionName: "activeBatchId" });
  const ids = batch === 0n ? [] : await client.readContract({ address: pool, abi: MarketRipPoolAbi, functionName: "batchPositions", args: [batch] });
  const rows = await Promise.all(ids.map(id => client.readContract({ address: pool, abi: MarketRipPoolAbi, functionName: "position", args: [id] }) as Promise<{ stock: Address }>));
  const stocks = [...new Set(rows.map(r => r.stock))];
  const tokens = await Promise.all(stocks.map(async address => {
    const [symbol, name] = await client.multicall({ allowFailure: false, contracts: [
      { address, abi: erc20Abi, functionName: "symbol" },
      { address, abi: erc20Abi, functionName: "name" },
    ] });
    return { chainId: TEST_SWAP_CHAIN, address, symbol, name, issuer: "Test token", source: "rips-pool", sourceId: address, disclosures: "https://erodoro.xyz/#risk" };
  }));
  const now = Date.now();
  return { chainId: TEST_SWAP_CHAIN, fetchedAt: now, expiresAt: now + 10 * 60_000, partial: false, tokens: tokens.sort((a, b) => a.symbol.localeCompare(b.symbol)),
    sources: [{ id: "rips-pool", issuer: "Testnet Rips pool", url: `${DEPLOYMENT.explorer}/address/${pool}`, count: tokens.length, status: "ok" }] };
}

export type TestQuote = { buyAmount: bigint; minBuyAmount: bigint; price: number };

/** Fills at the reference price: no pool, so no slippage and no fee. */
export async function testQuote({ side, symbol, sellAmount, stockDecimals }: { side: "buy" | "sell"; symbol: string; sellAmount: bigint; stockDecimals: number }): Promise<TestQuote> {
  const reference = await stockPrice(symbol);
  if (!reference) throw new Error(`No reference price for ${symbol}.`);
  // Price in 1e8 fixed point, so the arithmetic stays in integers.
  const price = BigInt(Math.round(reference.price * 1e8));
  const buyAmount = side === "buy"
    ? sellAmount * 10n ** BigInt(stockDecimals) * 10n ** 8n / (price * 10n ** 6n)
    : sellAmount * price * 10n ** 6n / (10n ** BigInt(stockDecimals) * 10n ** 8n);
  if (buyAmount === 0n) throw new Error("Amount too small for one unit.");
  return { buyAmount, minBuyAmount: buyAmount, price: reference.price };
}

async function send(request: { account: Address; address: Address; abi: readonly unknown[]; functionName: string; args: readonly unknown[] }) {
  const hash = await writeContract(wagmiConfig, { ...request, chainId: TEST_SWAP_CHAIN } as never);
  const receipt = await waitForTransactionReceipt(wagmiConfig, { hash, chainId: TEST_SWAP_CHAIN });
  if (receipt.status !== "success") throw new Error("Transaction reverted.");
  return hash;
}

/** Pays the input side, then mints the output side. Two wallet confirmations. */
export async function executeTestSwap({ side, stock, account, sellAmount, quote, progress }: {
  side: "buy" | "sell"; stock: Address; account: Address; sellAmount: bigint; quote: TestQuote; progress: (text: string, hash?: `0x${string}`) => void;
}) {
  progress("Confirm the payment in your wallet (1 of 2)…");
  const paid = side === "buy"
    ? await send({ account, address: TEST_USDC, abi: erc20Abi, functionName: "transfer", args: [BURN, sellAmount] })
    : await send({ account, address: stock, abi: TEST_TOKEN_ABI, functionName: "burnBlocked", args: [account, sellAmount] });
  progress("Payment confirmed. Confirm receiving in your wallet (2 of 2)…", paid);
  const received = await send({ account, address: side === "buy" ? stock : TEST_USDC, abi: TEST_TOKEN_ABI, functionName: "mint", args: [account, quote.buyAmount] });
  progress("Swap complete.", received);
}

export async function mintTestUsdc(account: Address) {
  return send({ account, address: TEST_USDC, abi: TEST_TOKEN_ABI, functionName: "mint", args: [account, TEST_USDC_GRANT] });
}
