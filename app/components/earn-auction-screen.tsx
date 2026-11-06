"use client";

import { useRouter } from "next/navigation";
import { useAccount } from "wagmi";
import { useStockBalances } from "@/lib/use-stock-balances";
import { useSeriesList } from "@/lib/use-series";
import { useRole } from "@/lib/use-role";
import { Panel } from "@/components/ui";
import { AuctionBuilder } from "@/components/auction/AuctionBuilder";
import type { Hex } from "@/lib/types";

/** Screen 1 — the seller entry point, rebuilt as an auction builder. */
export function EarnAuctionScreen() {
  const router = useRouter();
  const [, setRole] = useRole();
  const { rows, loading } = useStockBalances();
  const { data: series, loading: marketsLoading, error: marketsError } = useSeriesList();

  if (marketsError) {
    return (
      <Panel title="Could not load markets">
        <p role="alert" className="text-muted text-sm">{marketsError}</p>
      </Panel>
    );
  }
  if (marketsLoading || loading) {
    return (
      <Panel title="Sell Your Upside">
        <p role="status" className="text-muted text-sm">Loading your stocks and listed caps…</p>
      </Panel>
    );
  }
  if (series.length === 0) {
    return (
      <Panel title="No listed markets">
        <p className="text-muted text-sm">
          No canonical markets exist on this network yet, so there is nothing to auction against.
        </p>
      </Panel>
    );
  }
  return (
    <AuctionBuilder
      rows={rows}
      series={series}
      onListed={(seriesId: bigint, intentHash: Hex) => {
        setRole("seller");
        router.push(`/app?market=${seriesId.toString(16)}&auction=${intentHash}`);
      }}
    />
  );
}

export function EarnConnectHint() {
  const { isConnected } = useAccount();
  if (isConnected) return null;
  return (
    <p className="text-muted mt-4 text-sm">
      Connect a wallet to see your balances — you can still browse caps and expiries first.
    </p>
  );
}
