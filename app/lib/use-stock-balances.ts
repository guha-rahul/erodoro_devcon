"use client";

import { erc20Abi } from "viem";
import { useAccount, useReadContracts } from "wagmi";
import { IB20AssetAbi } from "./abis";
import { toShareEquivalent } from "./use-b20";
import { productionAssets, listedAssets, type IssuerAsset } from "./issuers";
import { IS_TESTNET } from "./deployment";
import type { Address } from "./types";

export type StockRow = IssuerAsset & {
  /** Raw units held. Exact, for approvals and max-quantity checks. */
  balance: bigint;
  /** Share-equivalent units, as the token reports them via `scaledBalanceOf`. */
  shares?: bigint;
  /** The multiplier in force, so any raw figure can be re-expressed. */
  multiplier: bigint | null;
};

/**
 * What the connected account holds across the stock universe.
 *
 * On a testnet the production stocks do not exist, so the list falls back to
 * whatever is actually deployed there — otherwise every card would read "you
 * hold none" for a reason that has nothing to do with the user.
 *
 * Two balance reads per token, deliberately. `scaledBalanceOf` is the
 * share-equivalent number the issuer's own book agrees with; `balanceOf` is the
 * raw number an approval or a split must use. Deriving the raw figure from the
 * scaled one would round it down and can strand a unit. The UI shows shares and
 * keeps raw units for advanced detail.
 */
export function useStockBalances(): { rows: StockRow[]; loading: boolean } {
  const { address } = useAccount();
  const assets = IS_TESTNET ? listedAssets() : productionAssets();
  const zero = "0x0000000000000000000000000000000000000000" as Address;

  const reads = useReadContracts({
    contracts: assets.flatMap((a) => [
      {
        address: a.token,
        abi: erc20Abi,
        functionName: "balanceOf" as const,
        args: [address ?? zero],
      },
      { address: a.token, abi: IB20AssetAbi, functionName: "multiplier" as const },
      {
        address: a.token,
        abi: IB20AssetAbi,
        functionName: "scaledBalanceOf" as const,
        args: [address ?? zero],
      },
    ]),
    query: { enabled: assets.length > 0, refetchInterval: 30_000 },
  });

  const rows = assets.map((a, i) => {
    const raw = (reads.data?.[i * 3]?.result as bigint | undefined) ?? 0n;
    const multiplier = (reads.data?.[i * 3 + 1]?.result as bigint | undefined) ?? null;
    const scaled = reads.data?.[i * 3 + 2]?.result as bigint | undefined;
    return {
      ...a,
      balance: address ? raw : 0n,
      multiplier,
      shares: address ? (scaled ?? toShareEquivalent(raw, multiplier)) : 0n,
    };
  });

  return { rows, loading: reads.isLoading };
}
