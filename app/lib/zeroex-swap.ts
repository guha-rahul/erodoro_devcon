"use client";

import { encodeFunctionData, erc20Abi, isAddress, maxUint256, parseUnits, type Address, type Hash, type PublicClient } from "viem";
import { getAccount, sendTransaction, simulateContract, writeContract } from "wagmi/actions";
import { wagmiConfig } from "./wagmi";
import { SWAP_API } from "./swap-api";
import { SWAP_CHAIN, USDC } from "./stock-swap";
import { canBatchAtomically, sendAtomicBatch } from "./batching";

export { SWAP_CHAIN, USDC };

/**
 * 0x swap routing, proxied through the Worker.
 *
 * The browser never sees the 0x API key and never picks the spender. It asks
 * the Worker for a quote, and the Worker returns 0x's own executable
 * transaction plus the `allowanceTarget` the caller must approve. That address
 * — not a router named in a response, and not a spender copied from docs — is
 * the only approval this code will ever send.
 *
 * Two quote kinds, deliberately distinct:
 * - `price` while the user is **editing** the amount. It may move.
 * - `quote` immediately before **confirming**. It carries committed amounts
 *   and the calldata that is signed.
 */

export type ZeroExTransaction = {
  to: Address;
  data: `0x${string}`;
  value?: string;
  gas?: string;
  gasPrice?: string;
};

export type ZeroExQuote = {
  buyAmount: bigint;
  sellAmount: bigint;
  minBuyAmount: bigint;
  buyToken: Address;
  sellToken: Address;
  allowanceTarget: Address;
  transaction: ZeroExTransaction;
  /** 0x's own preflight notes, surfaced to the user. */
  issues: {
    allowance?: { spender?: Address; actual?: string; expected?: string };
    balance?: { token?: Address; actual?: string; expected?: string };
  };
  liquidityAvailable: boolean;
};

/** Slippage is bounded here as well as in the Worker; neither trusts the other. */
export const SLIPPAGE_BPS = [10, 50, 100] as const;
export type SlippageBps = (typeof SLIPPAGE_BPS)[number];

export function parseSwapAmount(value: string, decimals: number): bigint {
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 36) return 0n;
  const pattern = decimals === 0 ? /^\d+$/ : new RegExp(`^\\d+(?:\\.\\d{1,${decimals}})?$`);
  if (!pattern.test(value)) return 0n;
  try {
    const n = parseUnits(value, decimals);
    return n > 0n && n <= maxUint256 ? n : 0n;
  } catch {
    return 0n;
  }
}

/** The request the Worker expects. `side` is derived from the USDC address. */
export type QuoteRequest = {
  side: "buy" | "sell";
  token: Address;
  sellAmount: bigint;
  taker: Address;
  slippageBps: SlippageBps;
};

export function rolesFor(side: "buy" | "sell", token: Address): { sellToken: Address; buyToken: Address } {
  return side === "buy" ? { sellToken: USDC, buyToken: token } : { sellToken: token, buyToken: USDC };
}

function parseQuote(raw: unknown, request: QuoteRequest): ZeroExQuote {
  if (!raw || typeof raw !== "object") throw new Error("Swap routing returned an unreadable quote.");
  const r = raw as Record<string, unknown>;
  const { sellToken, buyToken } = rolesFor(request.side, request.token);
  if (typeof r.allowanceTarget !== "string" || !isAddress(r.allowanceTarget)) {
    throw new Error("Quote is missing an approval target. Nothing was signed.");
  }
  const tx = r.transaction as Record<string, unknown> | undefined;
  if (!tx || typeof tx.to !== "string" || !isAddress(tx.to) || typeof tx.data !== "string" || !/^0x[0-9a-fA-F]+$/.test(tx.data)) {
    throw new Error("Quote is missing executable transaction data.");
  }
  const big = (value: unknown, field: string): bigint => {
    if (typeof value !== "string" || !/^\d+$/.test(value)) throw new Error(`Quote is missing ${field}.`);
    return BigInt(value);
  };
  const quote: ZeroExQuote = {
    buyAmount: big(r.buyAmount, "buyAmount"),
    sellAmount: big(r.sellAmount, "sellAmount"),
    minBuyAmount: big(r.minBuyAmount ?? r.buyAmount, "minBuyAmount"),
    buyToken: buyToken,
    sellToken: sellToken,
    allowanceTarget: r.allowanceTarget as Address,
    transaction: {
      to: tx.to as Address,
      data: tx.data as `0x${string}`,
      value: typeof tx.value === "string" ? tx.value : undefined,
      gas: typeof tx.gas === "string" ? tx.gas : undefined,
    },
    issues: (r.issues as ZeroExQuote["issues"]) ?? {},
    liquidityAvailable: r.liquidityAvailable !== false,
  };
  if (!quote.liquidityAvailable || quote.buyAmount === 0n) throw new Error("No liquidity for this trade.");
  return quote;
}

export async function fetchZeroExQuote(request: QuoteRequest, kind: "price" | "quote"): Promise<ZeroExQuote> {
  const { sellToken, buyToken } = rolesFor(request.side, request.token);
  const url = new URL(`${SWAP_API}/api/swap/${kind}`, typeof window === "undefined" ? "http://localhost" : window.location.origin);
  url.searchParams.set("chainId", String(SWAP_CHAIN));
  url.searchParams.set("sellToken", sellToken);
  url.searchParams.set("buyToken", buyToken);
  url.searchParams.set("sellAmount", request.sellAmount.toString());
  url.searchParams.set("taker", request.taker);
  url.searchParams.set("slippageBps", String(request.slippageBps));
  const response = await fetch(url, { headers: { accept: "application/json" } });
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    throw new Error("Swap routing is temporarily unavailable.");
  }
  if (!response.ok) {
    throw new Error((body as { error?: string })?.error ?? "Swap routing failed.");
  }
  return parseQuote(body, request);
}

export type SwapProgress = (message: string, hash?: Hash) => void;

/**
 * Approve (if needed) and execute.
 *
 * Approval is a separate transaction, exactly the amount being swapped, sent
 * to the `allowanceTarget` 0x returned. The swap itself is simulated before it
 * is signed, so a token policy or an insufficient balance fails before the
 * wallet prompt rather than after.
 */
export async function executeZeroExSwap(options: {
  client: PublicClient;
  account: Address;
  quote: ZeroExQuote;
  isActive: () => boolean;
  progress: SwapProgress;
}) {
  const { client, account, quote, progress } = options;

  // Never sign against a quote that does not name an approval target and an
  // executable transaction, even if a caller hands one in directly.
  if (!isAddress(quote.allowanceTarget)) {
    throw new Error("Quote is missing an approval target. Nothing was signed.");
  }
  if (!isAddress(quote.transaction?.to) || typeof quote.transaction?.data !== "string" || !/^0x[0-9a-fA-F]+$/.test(quote.transaction.data)) {
    throw new Error("Quote is missing executable transaction data.");
  }

  const guard = () => {
    const wallet = getAccount(wagmiConfig);
    if (!options.isActive() || wallet.address?.toLowerCase() !== account.toLowerCase()) {
      throw new Error("Wallet or trade changed. Review again.");
    }
    if (wallet.chainId !== SWAP_CHAIN) throw new Error("Switch to Base mainnet before signing.");
  };

  guard();
  if ((await client.getChainId()) !== SWAP_CHAIN) throw new Error("Read provider is not Base mainnet");

  progress("Checking allowance and balance…");
  const [balance, allowance] = (await client.multicall({
    allowFailure: false,
    contracts: [
      { address: quote.sellToken, abi: erc20Abi, functionName: "balanceOf", args: [account] },
      { address: quote.sellToken, abi: erc20Abi, functionName: "allowance", args: [account, quote.allowanceTarget] },
    ],
  })) as [bigint, bigint];

  if (balance < quote.sellAmount) {
    throw new Error("Insufficient balance on Base mainnet for this trade.");
  }
  guard();

  if (allowance < quote.sellAmount) {
    const approvalCall = {
      to: quote.sellToken,
      data: encodeFunctionData({
        abi: erc20Abi,
        functionName: "approve",
        args: [quote.allowanceTarget, quote.sellAmount],
      }),
    };
    const swapCall = {
      to: quote.transaction.to,
      data: quote.transaction.data,
      value: quote.transaction.value ? BigInt(quote.transaction.value) : 0n,
    };

    // An EIP-5792 wallet can approve and swap in one confirmation. The bundle
    // is atomic, so a token policy that blocks the swap also reverts the
    // approval instead of stranding it.
    if (await canBatchAtomically(wagmiConfig, account, SWAP_CHAIN)) {
      guard();
      progress("Approve and swap in one confirmation…");
      const hash = await sendAtomicBatch(wagmiConfig, {
        account,
        chainId: SWAP_CHAIN,
        calls: [approvalCall, swapCall],
      });
      progress("Swap confirmed. The output tokens are in your wallet.", hash);
      return { kind: "swapped", hash } as const;
    }

    progress("Simulating exact-amount approval…");
    const { request } = await simulateContract(wagmiConfig, {
      chainId: SWAP_CHAIN,
      account,
      address: quote.sellToken,
      abi: erc20Abi,
      functionName: "approve",
      args: [quote.allowanceTarget, quote.sellAmount],
    });
    guard();
    progress("Approve the exact amount in your wallet…");
    const hash = await writeContract(wagmiConfig, request);
    progress("Approval submitted. Waiting for confirmation…", hash);
    const receipt = await client.waitForTransactionReceipt({ hash, confirmations: 1, timeout: 120_000 });
    if (receipt.status !== "success") throw new Error("Approval reverted. Nothing was swapped.");
    progress("Approval confirmed. Confirm the swap to continue.", hash);
    return { kind: "approved", hash } as const;
  }

  progress("Simulating the swap, including token transfer restrictions…");
  // Arbitrary calldata, so this is a raw call simulation rather than a
  // contract-function simulation. A token policy or a shortfall reverts here,
  // before the wallet prompt, instead of after.
  await client.call({
    account,
    to: quote.transaction.to,
    data: quote.transaction.data,
    value: quote.transaction.value ? BigInt(quote.transaction.value) : 0n,
  });
  guard();
  progress("Confirm the swap in your wallet…");
  const hash = await sendTransaction(wagmiConfig, {
    chainId: SWAP_CHAIN,
    account,
    to: quote.transaction.to,
    data: quote.transaction.data,
    value: quote.transaction.value ? BigInt(quote.transaction.value) : 0n,
  });
  progress("Swap submitted. Waiting for confirmation…", hash);
  const receipt = await client.waitForTransactionReceipt({ hash, confirmations: 1, timeout: 120_000 });
  if (receipt.status !== "success") throw new Error("Transaction reverted. No successful swap was confirmed.");
  progress("Swap confirmed. The output tokens are in your wallet.", hash);
  return { kind: "swapped", hash } as const;
}
