"use client";

import { erc20Abi } from "viem";
import { useAccount, useReadContract, useReadContracts } from "wagmi";
import { ErodoroVaultAbi } from "./abis";
import { DEPLOYMENT } from "./deployment";
import { REQUIRED_CHAIN_ID } from "./wagmi";
import { nId, pId, type Address, type Series } from "./types";

/** What the connected account holds for one series. */
export function useSeriesBalances(seriesId: bigint | null, collateral?: Address) {
  const { address } = useAccount();
  const vault = DEPLOYMENT.contracts.vault as Address;
  const enabled = Boolean(address && seriesId !== null && vault);

  const claims = useReadContracts({
    contracts:
      enabled && seriesId !== null
        ? [
            {
              address: vault,
              abi: ErodoroVaultAbi,
              functionName: "balanceOf",
              args: [address as Address, pId(seriesId)],
            },
            {
              address: vault,
              abi: ErodoroVaultAbi,
              functionName: "balanceOf",
              args: [address as Address, nId(seriesId)],
            },
          ]
        : [],
    query: { enabled, refetchInterval: 12_000 },
  });

  const collateralBalance = useReadContract({
    address: collateral,
    abi: erc20Abi,
    functionName: "balanceOf",
    args: address ? [address] : undefined,
    query: { enabled: Boolean(address && collateral), refetchInterval: 12_000 },
  });

  return {
    p: (claims.data?.[0]?.result as bigint | undefined) ?? 0n,
    n: (claims.data?.[1]?.result as bigint | undefined) ?? 0n,
    collateral: (collateralBalance.data as bigint | undefined) ?? 0n,
    refetch: () => {
      void claims.refetch();
      void collateralBalance.refetch();
    },
  };
}

/** Read all P and N balances in one request for the portfolio page. */
export function usePortfolioBalances(series: Series[]) {
  const { address } = useAccount();
  const vault = DEPLOYMENT.contracts.vault as Address;
  const enabled = Boolean(address && vault && series.length > 0);
  const contracts = enabled
    ? series.flatMap((item) => [
        {
          chainId: REQUIRED_CHAIN_ID,
          address: vault,
          abi: ErodoroVaultAbi,
          functionName: "balanceOf" as const,
          args: [address as Address, pId(item.id)] as const,
        },
        {
          chainId: REQUIRED_CHAIN_ID,
          address: vault,
          abi: ErodoroVaultAbi,
          functionName: "balanceOf" as const,
          args: [address as Address, nId(item.id)] as const,
        },
      ])
    : [];

  const balances = useReadContracts({
    contracts,
    query: { enabled, refetchInterval: 12_000 },
  });

  const incomplete = enabled && !balances.isLoading && (
    balances.data?.length !== contracts.length ||
    balances.data.some((entry) => entry.status !== "success" || typeof entry.result !== "bigint")
  );
  const error = balances.error?.message ?? (incomplete ? "Some position balances could not be read. Refresh to try again." : null);

  return {
    rows: error ? [] : series.map((item, index) => ({
      series: item,
      p: (balances.data?.[index * 2]?.result as bigint | undefined) ?? 0n,
      n: (balances.data?.[index * 2 + 1]?.result as bigint | undefined) ?? 0n,
    })),
    loading: enabled && balances.isLoading,
    error,
  };
}
