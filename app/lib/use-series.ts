"use client";

import { useQuery } from "@tanstack/react-query";
import { publicClient } from "./chain";
import { DEPLOYMENT, IS_LIVE } from "./deployment";
import { useDeployment } from "./use-app-network";
import { ErodoroVaultAbi, FactoryAbi } from "./abis";
import type { Address, Series, SeriesConfig, SeriesRecord, Settlement } from "./types";

export type Query<T> = { data: T; loading: boolean; error: string | null };

/** Contract structs arrive as named objects; this names the type once so a
 *  field change in Solidity surfaces here rather than as a wrong column. */
function toConfig(raw: unknown): SeriesConfig {
  return raw as SeriesConfig;
}

async function readSeries(seriesId: bigint): Promise<Series | null> {
  const vault = DEPLOYMENT.contracts.vault as Address;
  const factory = DEPLOYMENT.contracts.factory as Address;

  const [config, settlement, locked, record] = await Promise.all([
    publicClient.readContract({ address: vault, abi: ErodoroVaultAbi, functionName: "seriesConfig", args: [seriesId] }),
    publicClient.readContract({ address: vault, abi: ErodoroVaultAbi, functionName: "settlementOf", args: [seriesId] }),
    publicClient.readContract({ address: vault, abi: ErodoroVaultAbi, functionName: "lockedOf", args: [seriesId] }),
    publicClient
      .readContract({ address: factory, abi: FactoryAbi, functionName: "recordOf", args: [seriesId] })
      .catch(() => null),
  ]);

  const cfg = toConfig(config);
  if (!cfg.exists) return null;

  const st = settlement as unknown as Settlement;
  return {
    id: seriesId,
    config: cfg,
    record: (record as unknown as SeriesRecord) ?? null,
    settlement: st.settled ? st : null,
    locked: locked as bigint,
  };
}

async function readAll(): Promise<Series[]> {
  const factory = DEPLOYMENT.contracts.factory as Address;
  const ids = (await publicClient.readContract({
    address: factory,
    abi: FactoryAbi,
    functionName: "canonicalSeries",
  })) as readonly bigint[];

  return Promise.all(ids.map(async (id) => {
    const series = await readSeries(id);
    if (!series) throw new Error("A listed market could not be loaded. Refresh to try again.");
    return series;
  }));
}

const NOT_DEPLOYED = "No contracts are deployed on this chain.";

/**
 * Reads run in the browser because the app is a static export — there is no
 * server to read on its behalf. TanStack Query handles the caching, dedupe and
 * refetch, so this file only has to describe *what* to read.
 */
export function useSeriesList(): Query<Series[]> {
  const { isLive } = useDeployment();
  const q = useQuery({
    queryKey: ["series", DEPLOYMENT.chainId],
    queryFn: readAll,
    enabled: IS_LIVE,
    refetchInterval: 15_000,
  });
  return {
    data: q.data ?? [],
    loading: q.isLoading,
    error: isLive ? (q.error ? q.error.message : null) : NOT_DEPLOYED,
  };
}

export function useSeries(id: bigint | null): Query<Series | null> {
  const { isLive } = useDeployment();
  const q = useQuery({
    queryKey: ["series", DEPLOYMENT.chainId, id?.toString() ?? null],
    queryFn: () => (id === null ? Promise.resolve(null) : readSeries(id)),
    enabled: IS_LIVE && id !== null,
    refetchInterval: 15_000,
  });
  return {
    data: q.data ?? null,
    loading: q.isLoading,
    error: isLive ? (q.error ? q.error.message : null) : NOT_DEPLOYED,
  };
}
