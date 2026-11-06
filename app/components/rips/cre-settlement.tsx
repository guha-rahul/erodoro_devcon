"use client";
import { useEffect, useState } from "react";
import { BaseError, formatUnits, type Address, type Hash } from "viem";
import { useAccount, useConfig, useWriteContract } from "wagmi";
import { waitForTransactionReceipt } from "wagmi/actions";
import { Button } from "@/components/ui/button";
import { CreSettlementOracleAbi } from "@/lib/abis/CreSettlementOracle";
import { ErodoroVaultAbi } from "@/lib/abis/ErodoroVault";
import { MarketRipPoolAbi } from "@/lib/abis/MarketRipPool";
import { publicClient } from "@/lib/chain";
import { DEPLOYMENT, txExplorer } from "@/lib/deployment";

type Reading = {
  vault: Address;
  oracle: Address;
  maturity: number;
  settleAfter: number;
  latest: { price: bigint; observedAt: number; feedUpdatedAt: number } | null;
  /** The price settlement would use now, or null while no CRE report falls inside the window. */
  settlement: { price: bigint; publishTime: number } | null;
  priceDecimals: number;
  /** When this was read, for deciding whether the settlement delay has passed. */
  readAt: number;
};

/** The series' oracle reading, or null unless it settles through CreSettlementOracle. */
async function readSettlement(seriesId: bigint): Promise<Reading | null> {
  const pool = DEPLOYMENT.contracts.ripPool;
  if (!pool) return null;
  const vault = await publicClient.readContract({ address: pool, abi: MarketRipPoolAbi, functionName: "vault" });
  const cfg = await publicClient.readContract({ address: vault, abi: ErodoroVaultAbi, functionName: "seriesConfig", args: [seriesId] });
  const isCre = await publicClient.readContract({ address: cfg.oracle, abi: CreSettlementOracleAbi, functionName: "observationCount", args: [cfg.feedId] }).then(() => true, () => false);
  if (!isCre) return null;
  const [latest, settlement, block] = await Promise.all([
    publicClient.readContract({ address: cfg.oracle, abi: CreSettlementOracleAbi, functionName: "latest", args: [cfg.feedId] }).catch(() => null),
    publicClient.simulateContract({
      address: cfg.oracle, abi: CreSettlementOracleAbi, functionName: "settlementPrice",
      args: [cfg.feedId, cfg.maturity, cfg.maturity + cfg.maxPriceLag, 0n, []],
    }).then(({ result }) => ({ price: result[0], publishTime: Number(result[2]) }), () => null),
    publicClient.getBlock(),
  ]);
  return {
    vault, oracle: cfg.oracle, maturity: Number(cfg.maturity), settleAfter: Number(cfg.maturity + cfg.settlementDelay),
    latest: latest && { price: latest.price, observedAt: Number(latest.observedAt), feedUpdatedAt: Number(latest.feedUpdatedAt) },
    settlement, priceDecimals: cfg.priceDecimals, readAt: Number(block.timestamp),
  };
}

/**
 * Settlement of a Rips series from Chainlink's stock feed, delivered by the CRE `rips-prices` workflow to
 * CreSettlementOracle. Anyone may settle once the delay has passed; the vault takes the first CRE observation at
 * or after maturity.
 */
export function CreSettlement({ claimId, onSettled }: { claimId: string; onSettled: () => void }) {
  const { address } = useAccount();
  const config = useConfig();
  const { writeContractAsync } = useWriteContract();
  const [reading, setReading] = useState<Reading | null>(null);
  const [status, setStatus] = useState<{ kind: "idle" | "busy" | "done" | "error"; message?: string; hash?: Hash }>({ kind: "idle" });
  const seriesId = BigInt(claimId) & ~1n;

  const [nonce, setNonce] = useState(0);
  useEffect(() => {
    let live = true;
    readSettlement(seriesId).then((r) => { if (live) setReading(r); }, () => undefined);
    return () => { live = false; };
  }, [seriesId, nonce]);

  if (!reading) return null;
  const usd = (raw: bigint) => `$${Number(formatUnits(raw, reading.priceDecimals)).toFixed(2)}`;
  const at = (s: number) => new Date(s * 1000).toLocaleString();
  const ready = reading.settlement !== null && reading.readAt >= reading.settleAfter;

  const settle = async () => {
    setStatus({ kind: "busy" });
    try {
      const request = { address: reading.vault, abi: ErodoroVaultAbi, functionName: "settle" as const, args: [seriesId, []] as const, account: address };
      await publicClient.simulateContract(request);
      const hash = await writeContractAsync({ ...request, chainId: DEPLOYMENT.chainId as 84532 });
      const receipt = await waitForTransactionReceipt(config, { hash, chainId: DEPLOYMENT.chainId as 84532 });
      if (receipt.status !== "success") throw new Error(`Settlement reverted: ${hash}`);
      setStatus({ kind: "done", hash });
      setNonce(n => n + 1);
      onSettled();
    } catch (cause) {
      setStatus({ kind: "error", message: /reject|denied|4001/i.test(String(cause)) ? "Signing was cancelled." : cause instanceof BaseError ? cause.shortMessage : String(cause).slice(0, 200) });
    }
  };

  return <div className="mt-4 text-sm">
    <p className="text-muted">
      {reading.settlement
        ? <>Chainlink via CRE: <span className="text-text font-medium">{usd(reading.settlement.price)}</span> · {at(reading.settlement.publishTime)}</>
        : <>Chainlink via CRE{reading.latest && <>: <span className="text-text font-medium">{usd(reading.latest.price)}</span> · {at(reading.latest.observedAt)}</>}</>}
    </p>
    {address && <Button className="mt-3 w-full" onClick={() => void settle()} disabled={!ready || status.kind === "busy"}>
      {status.kind === "busy" ? "Settling…" : "Settle at the Chainlink price"}
    </Button>}
    {status.kind === "done" && status.hash && <p role="status" className="mt-2">Settled. <a className="underline" href={txExplorer(status.hash)} target="_blank" rel="noreferrer">Receipt</a></p>}
    {status.kind === "error" && <p role="alert" className="text-danger mt-2">{status.message}</p>}
  </div>;
}
