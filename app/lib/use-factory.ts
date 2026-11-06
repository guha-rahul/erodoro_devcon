"use client";

import { useAccount, useReadContract, useReadContracts } from "wagmi";
import { FactoryAbi } from "./abis";
import { useDeployment } from "./use-app-network";
import type { Address, Hex } from "./types";

export type Bounds = {
  minHorizon: bigint;
  maxHorizon: bigint;
  minSettlementDelay: bigint;
  maxSettlementDelay: bigint;
  minPriceLag: bigint;
  maxPriceLag: bigint;
  maxConfBps: number;
  maxFeeBps: number;
  priceDecimals: number;
};

export type SettlementConfiguration = {
  id: Hex;
  collateral: Address;
  oracle: Address;
  fallbackOracle: Address;
  feedId: Hex;
  settlementModel: number;
  fallbackDelay: bigint;
  priceDecimals: number;
  enabled: boolean;
};

/**
 * The registry's rules, and whether you are the one who sets them.
 *
 * A market has to satisfy these before the factory will list it. Reading them
 * lets the form say no *before* a wallet opens, rather than letting the user
 * discover it as a revert.
 */
export function useFactory() {
  const { address } = useAccount();
  const factory = useDeployment().deployment.contracts.factory as Address | null;

  const reads = useReadContracts({
    contracts: factory
      ? [
          { address: factory, abi: FactoryAbi, functionName: "bounds" },
          { address: factory, abi: FactoryAbi, functionName: "admin" },
          { address: factory, abi: FactoryAbi, functionName: "creationPaused" },
        ]
      : [],
    query: { enabled: Boolean(factory), refetchInterval: 30_000 },
  });

  const raw = reads.data?.[0]?.result as readonly [bigint, bigint, bigint, bigint, bigint, bigint, number, number, number] | undefined;
  const bounds: Bounds | null = raw
    ? {
        minHorizon: raw[0],
        maxHorizon: raw[1],
        minSettlementDelay: raw[2],
        maxSettlementDelay: raw[3],
        minPriceLag: raw[4],
        maxPriceLag: raw[5],
        maxConfBps: raw[6],
        maxFeeBps: raw[7],
        priceDecimals: raw[8],
      }
    : null;

  const admin = reads.data?.[1]?.result as Address | undefined;

  return {
    factory,
    bounds,
    admin: admin ?? null,
    creationPaused: (reads.data?.[2]?.result as boolean | undefined) ?? false,
    isAdmin: Boolean(address && admin && address.toLowerCase() === admin.toLowerCase()),
    loading: reads.isLoading,
  };
}

/** The one complete settlement configuration active for this collateral. */
export function useSettlementConfiguration(collateral?: Address) {
  const factory = useDeployment().deployment.contracts.factory as Address | null;
  const read = useReadContract({
    address: factory ?? undefined,
    abi: FactoryAbi,
    functionName: "activeSettlementConfiguration",
    args: collateral ? [collateral] : undefined,
    query: { enabled: Boolean(factory && collateral), refetchInterval: 30_000 },
  });

  const raw = read.data as
    | readonly [
        Hex,
        Omit<SettlementConfiguration, "id">,
      ]
    | undefined;
  const c = raw?.[1];
  const configuration: SettlementConfiguration | null = raw && c
    ? {
        id: raw[0],
        collateral: c.collateral,
        oracle: c.oracle,
        fallbackOracle: c.fallbackOracle,
        feedId: c.feedId,
        settlementModel: c.settlementModel,
        fallbackDelay: c.fallbackDelay,
        priceDecimals: c.priceDecimals,
        enabled: c.enabled,
      }
    : null;

  return {
    configuration,
    loading: read.isLoading,
    error: read.error,
    refetch: read.refetch,
  };
}

export function useCanonicalCount() {
  const factory = useDeployment().deployment.contracts.factory as Address | null;
  return useReadContract({
    address: factory ?? undefined,
    abi: FactoryAbi,
    functionName: "canonicalCount",
    query: { enabled: Boolean(factory), refetchInterval: 30_000 },
  });
}
