"use client";
import { useEffect, useMemo, useState } from "react";
import { BaseError, erc20Abi, formatUnits, maxUint256, parseUnits, type Address, type Hash } from "viem";
import { useAccount, useConfig, useWriteContract } from "wagmi";
import { waitForTransactionReceipt } from "wagmi/actions";
import { Button } from "@/components/ui/button";
import { ClaimWrapperAbi } from "@/lib/abis/ClaimWrapper";
import { ErodoroVaultAbi } from "@/lib/abis/ErodoroVault";
import { publicClient } from "@/lib/chain";
import { DEPLOYMENT, txExplorer } from "@/lib/deployment";
import { HumanRegistryAbi } from "@/lib/abis/HumanRegistry";
import { RipsResaleHookAbi } from "@/lib/abis/RipsResaleHook";
import { NOT_VERIFIED_MESSAGE, humanRevertMessage } from "@/lib/rips/human-errors";
import { buildSwap, permit2Abi, poolKey, universalRouterAbi, v4QuoterAbi, zeroForOne, type ResaleSide } from "@/lib/rips/resale";
import { ETHGLOBAL, resalePoolFor } from "@/lib/rips/resale-deployment";

const SLIPPAGE_BPS = 100n; // 1%

function parseAmount(input: string, decimals: number) {
  try { return parseUnits(input || "0", decimals); } catch { return 0n; }
}
const MAX160 = (1n << 160n) - 1n;
const MAX48 = Number((1n << 48n) - 1n);

/**
 * Sell a Rip before expiry, or buy more after the pool sells out, on Uniswap v4. The claim is wrapped 1:1 as an
 * ERC-20 for the pool and unwrapped back into the vault claim after a buy, so redemption works the same.
 */
export function ResalePanel({ positionId, unitDecimals, heldRaw, onTraded }: {
  positionId: string; unitDecimals: number; heldRaw: bigint; onTraded: () => void;
}) {
  const { address } = useAccount();
  const config = useConfig();
  const { writeContractAsync } = useWriteContract();
  const pool = useMemo(() => resalePoolFor(DEPLOYMENT.contracts.ripPool, positionId), [positionId]);
  const usdc = DEPLOYMENT.quote;
  const [side, setSide] = useState<ResaleSide>(heldRaw > 0n ? "sell" : "buy");
  const [input, setInput] = useState(heldRaw > 0n ? formatUnits(heldRaw, unitDecimals) : "1");
  const [quote, setQuote] = useState<{ key: string; out: bigint } | null>(null);
  const [status, setStatus] = useState<{ kind: "idle" | "busy" | "done" | "error"; message?: string; hash?: Hash }>({ kind: "idle" });
  // Bumped after each trade, so the quote and the wrapped balance reflect the pool's new state.
  const [nonce, setNonce] = useState(0);
  /** Wrapped claims left in the wallet, e.g. after a buy whose unwrap didn't go through. */
  const [wrapped, setWrapped] = useState(0n);
  /** The wallet's vault claims for this position, however they were acquired (the pool or Uniswap). */
  const [held, setHeld] = useState(heldRaw);

  const decimalsIn = side === "sell" ? unitDecimals : (usdc?.decimals ?? 6);
  const amountIn = parseAmount(input, decimalsIn);
  const key = `${side}:${amountIn}`;

  // V4Quoter is exempt from the World ID hook, so anyone can see a price before verifying.
  useEffect(() => {
    if (!pool || amountIn === 0n) return;
    const timer = setTimeout(async () => {
      try {
        const { result } = await publicClient.simulateContract({
          address: ETHGLOBAL.uniswap.v4Quoter, abi: v4QuoterAbi, functionName: "quoteExactInputSingle",
          args: [{ poolKey: poolKey(pool), zeroForOne: zeroForOne(pool, side), exactAmount: amountIn, hookData: "0x" }],
        });
        setQuote({ key, out: result[0] });
      } catch { setQuote(null); }
    }, 300);
    return () => clearTimeout(timer);
  }, [pool, side, amountIn, key, nonce]);
  useEffect(() => {
    if (!pool || !address) return;
    publicClient.readContract({ address: pool.wrapper, abi: erc20Abi, functionName: "balanceOf", args: [address] }).then(setWrapped, () => setWrapped(0n));
    publicClient.readContract({ address: pool.wrapper, abi: ClaimWrapperAbi, functionName: "vault" })
      .then(vault => publicClient.readContract({ address: vault, abi: ErodoroVaultAbi, functionName: "balanceOf", args: [address, BigInt(pool.claimId)] }))
      .then(setHeld, () => undefined);
  }, [pool, address, nonce]);

  if (!pool || !usdc) return null;
  const out = quote?.key === key ? quote.out : undefined;
  const unitsPerDollar = BigInt(pool.unitsPerDollar);
  const send = async (request: Parameters<typeof writeContractAsync>[0]) => {
    let hash: Hash | undefined;
    // A key shared with another sender (the testnet house and its quote keeper) can lose a nonce race; resend.
    for (let attempt = 1; !hash; attempt++) {
      try { hash = await writeContractAsync({ ...request, chainId: DEPLOYMENT.chainId as 84532 } as never); }
      catch (e) { if (attempt >= 3 || !/nonce/i.test(String(e))) throw e; await new Promise(r => setTimeout(r, 2000)); }
    }
    const receipt = await waitForTransactionReceipt(config, { hash, chainId: DEPLOYMENT.chainId as 84532 });
    if (receipt.status !== "success") throw new Error(`Transaction reverted: ${hash}`);
    return hash;
  };

  const trade = async () => {
    if (!address || !out) return;
    // The pool's hook refuses unverified traders (bar the house it exempts); say so before asking for any approval.
    const [verified, exempt] = await Promise.all([
      publicClient.readContract({ address: ETHGLOBAL.registry, abi: HumanRegistryAbi, functionName: "isVerified", args: [address] }),
      publicClient.readContract({ address: ETHGLOBAL.hook, abi: RipsResaleHookAbi, functionName: "exempt", args: [address] }),
    ]);
    if (!verified && !exempt) return setStatus({ kind: "error", message: NOT_VERIFIED_MESSAGE });
    setStatus({ kind: "busy", message: "Confirm in your wallet…" });
    try {
      const router = ETHGLOBAL.uniswap.universalRouter;
      const permit2 = ETHGLOBAL.uniswap.permit2;
      const tokenIn: Address = side === "sell" ? pool.wrapper : usdc.token;
      if (side === "sell") {
        const vault = await publicClient.readContract({ address: pool.wrapper, abi: ClaimWrapperAbi, functionName: "vault" });
        const operator = await publicClient.readContract({ address: vault, abi: ErodoroVaultAbi, functionName: "isOperator", args: [address, pool.wrapper] });
        if (!operator) await send({ address: vault, abi: ErodoroVaultAbi, functionName: "setOperator", args: [pool.wrapper, true] });
        await send({ address: pool.wrapper, abi: ClaimWrapperAbi, functionName: "wrap", args: [amountIn] });
      }
      const allowance = await publicClient.readContract({ address: tokenIn, abi: erc20Abi, functionName: "allowance", args: [address, permit2] });
      if (allowance < amountIn) await send({ address: tokenIn, abi: erc20Abi, functionName: "approve", args: [permit2, maxUint256] });
      const [permitted, expiration] = await publicClient.readContract({ address: permit2, abi: permit2Abi, functionName: "allowance", args: [address, tokenIn, router] });
      if (permitted < amountIn || expiration * 1000 < Date.now()) await send({ address: permit2, abi: permit2Abi, functionName: "approve", args: [tokenIn, router, MAX160, MAX48] });

      // Re-quote now: the pool may have moved since the quote on screen.
      const { result: [fresh] } = await publicClient.simulateContract({
        address: ETHGLOBAL.uniswap.v4Quoter, abi: v4QuoterAbi, functionName: "quoteExactInputSingle",
        args: [{ poolKey: poolKey(pool), zeroForOne: zeroForOne(pool, side), exactAmount: amountIn, hookData: "0x" }],
      });
      const minOut = (fresh * (10_000n - SLIPPAGE_BPS)) / 10_000n;
      const { commands, inputs } = buildSwap(pool, side, amountIn, minOut);
      const before = side === "buy" ? await publicClient.readContract({ address: pool.wrapper, abi: erc20Abi, functionName: "balanceOf", args: [address] }) : 0n;
      const deadline = BigInt(Math.floor(Date.now() / 1000) + 600);
      // Simulate first so a World ID refusal from the pool's hook is explained before anything is signed.
      await publicClient.simulateContract({ address: router, abi: universalRouterAbi, functionName: "execute", args: [commands, inputs, deadline], account: address });
      let hash = await send({ address: router, abi: universalRouterAbi, functionName: "execute", args: [commands, inputs, deadline] });
      if (side === "buy") {
        // Back to the vault claim, which is what My Rips shows and what redeems.
        const bought = (await publicClient.readContract({ address: pool.wrapper, abi: erc20Abi, functionName: "balanceOf", args: [address] })) - before;
        if (bought > 0n) hash = await send({ address: pool.wrapper, abi: ClaimWrapperAbi, functionName: "unwrap", args: [bought] });
      }
      setStatus({ kind: "done", hash, message: side === "sell" ? `Sold for ${formatUnits(fresh, usdc.decimals)} ${usdc.symbol}.` : `Bought ${formatUnits(fresh, unitDecimals)} claims.` });
      setNonce(n => n + 1);
      onTraded();
    } catch (cause) {
      const message = humanRevertMessage(cause)
        ?? (/reject|denied|4001/i.test(String(cause)) ? "Signing was cancelled." : cause instanceof BaseError ? cause.shortMessage : String(cause).slice(0, 200));
      setStatus({ kind: "error", message });
      setNonce(n => n + 1);
    }
  };

  const unwrap = async () => {
    setStatus({ kind: "busy", message: "Unwrapping…" });
    try {
      const hash = await send({ address: pool.wrapper, abi: ClaimWrapperAbi, functionName: "unwrap", args: [wrapped] });
      setStatus({ kind: "done", hash, message: "Unwrapped." });
      setNonce(n => n + 1);
      onTraded();
    } catch (cause) {
      setStatus({ kind: "error", message: cause instanceof BaseError ? cause.shortMessage : String(cause).slice(0, 200) });
    }
  };

  return <section aria-label="Uniswap resale" className="border-line/70 bg-panel mt-6 rounded-3xl border p-5 text-sm">
    <h2 className="font-medium">Trade on Uniswap</h2>
    <p className="text-muted mt-1">House price {formatUnits(unitsPerDollar, unitDecimals)} claims per $1 · verified humans only</p>
    <div className="mt-3 flex gap-2">
      {(["sell", "buy"] as const).map(s => <Button key={s} variant={side === s ? "default" : "outline"} size="sm" onClick={() => { setSide(s); setInput(s === "sell" ? formatUnits(held, unitDecimals) : "1"); setStatus({ kind: "idle" }); }} disabled={s === "sell" && held === 0n}>
        {s === "sell" ? "Sell claims" : "Buy claims"}
      </Button>)}
    </div>
    <label className="mt-3 flex flex-col gap-1">
      <span className="text-dim text-xs">You pay ({side === "sell" ? "claims" : usdc.symbol}){side === "sell" ? ` · you hold ${formatUnits(held, unitDecimals)}` : ""}</span>
      <input value={input} onChange={e => setInput(e.target.value.replace(/[^0-9.]/g, ""))} inputMode="decimal" className="border-line rounded-xl border bg-transparent px-3 py-2 font-mono" />
    </label>
    <p className="mt-2">You receive about <span className="font-mono">{out === undefined ? "…" : side === "sell" ? `${formatUnits(out, usdc.decimals)} ${usdc.symbol}` : `${formatUnits(out, unitDecimals)} claims`}</span></p>
    <Button className="mt-3 w-full" onClick={() => void trade()} disabled={!address || !out || status.kind === "busy" || (side === "sell" && amountIn > held)}>
      {status.kind === "busy" ? status.message : side === "sell" ? "Sell on Uniswap" : "Buy on Uniswap"}
    </Button>
    {wrapped > 0n && side === "buy" && <p className="mt-2">{formatUnits(wrapped, unitDecimals)} wrapped claims. <Button variant="link" className="h-auto p-0 align-baseline underline" onClick={() => void unwrap()} disabled={status.kind === "busy"}>Unwrap</Button></p>}
    {status.kind === "done" && <p role="status" className="mt-2">{status.message} {status.hash && <a className="underline" href={txExplorer(status.hash)} target="_blank" rel="noreferrer">Receipt</a>}</p>}
    {status.kind === "error" && <p role="alert" className="text-danger mt-2">{status.message}</p>}
  </section>;
}
