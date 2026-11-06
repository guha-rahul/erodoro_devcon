"use client";

import { useInfiniteQuery } from "@tanstack/react-query";
import { useAccount } from "wagmi";
import { ErodoroRFQAbi } from "./abis";
import { publicClient } from "./chain";
import { DEPLOYMENT } from "./deployment";

// Bound each RPC request. Older pages retain their original block boundaries.
const PAGE_BLOCKS = 2_000n;

export function usePremiumHistory() {
  const { address } = useAccount();
  const rfq = DEPLOYMENT.contracts.rfq;
  return useInfiniteQuery({
    queryKey: ["premium-history", DEPLOYMENT.chainId, rfq, address],
    enabled: Boolean(address && rfq),
    initialPageParam: null as bigint | null,
    queryFn: async ({ pageParam }) => {
      if (!address || !rfq) throw new Error("Connect a wallet to load premium history.");
      const toBlock = pageParam ?? await publicClient.getBlockNumber();
      const fromBlock = toBlock >= PAGE_BLOCKS - 1n ? toBlock - PAGE_BLOCKS + 1n : 0n;
      const common = { address: rfq, abi: ErodoroRFQAbi, eventName: "Filled" as const, fromBlock, toBlock, strict: true as const };
      const [sales, purchases] = await Promise.all([
        publicClient.getContractEvents({ ...common, args: { taker: address } }),
        publicClient.getContractEvents({ ...common, args: { maker: address } }),
      ]);
      // A self-fill matches both filters. Keep one row while retaining both cash legs.
      const events = [...new Map([...sales, ...purchases].map((event) =>
        [`${event.transactionHash}:${event.logIndex}`, event],
      )).values()].sort((a, b) => a.blockNumber === b.blockNumber
        ? b.logIndex - a.logIndex : a.blockNumber > b.blockNumber ? -1 : 1);
      return { events, fromBlock, toBlock };
    },
    getNextPageParam: (last) => last.fromBlock === 0n ? undefined : last.fromBlock - 1n,
    staleTime: Infinity,
    retry: 1,
  });
}
