"use client";

import { useEffect, useState } from "react";
import { useAccount } from "wagmi";
import { SWAP_API } from "./swap-api";
import { intentHashOf, type AuctionView, type SellIntentWire } from "./use-intent";

export type AuctionActivity = { paid: bigint; bought: bigint; earned: bigint };
const EMPTY_ACTIVITY = new Map<string, AuctionActivity>();

/** Actual auction cash flows associated with the connected wallet. */
export function useAuctionActivity() {
  const { address } = useAccount();
  const [snapshot, setSnapshot] = useState<{ address: string; bySeries: Map<string, AuctionActivity> } | null>(null);

  useEffect(() => {
    if (!address) return;
    let live = true;
    const load = async () => {
      try {
        const response = await fetch(`${SWAP_API}/api/intents?status=all`);
        const body = await response.json();
        if (!response.ok || !Array.isArray(body?.intents)) return;
        const rows = await Promise.all((body.intents as SellIntentWire[]).map(async (intent) => {
          const result = await fetch(`${SWAP_API}/api/auctions/${intentHashOf(intent)}`);
          if (!result.ok) return null;
          const detail = await result.json();
          return { intent, auction: detail.auction as AuctionView | null };
        }));
        const next = new Map<string, AuctionActivity>();
        for (const row of rows) {
          if (!row?.auction || !["Filled", "Settled", "PartiallyFilled"].includes(row.auction.state)) continue;
          const { intent, auction } = row;
          const seriesId = (BigInt(intent.claimId) & ~1n).toString();
          const current = next.get(seriesId) ?? { paid: 0n, bought: 0n, earned: 0n };
          const inferredBuyer = auction.buyer
            ?? auction.winner?.bidder
            ?? (auction.bids.length === 1 ? auction.bids[0].bidder : null);
          const premium = BigInt(auction.winningPremium ?? "0");
          if (intent.seller.toLowerCase() === address.toLowerCase()) current.earned += premium;
          if (inferredBuyer?.toLowerCase() === address.toLowerCase()) {
            current.paid += premium;
            current.bought += BigInt(auction.filledAmount ?? "0");
          }
          next.set(seriesId, current);
        }
        if (live) setSnapshot({ address: address.toLowerCase(), bySeries: next });
      } catch {
        // Holdings remain authoritative even if local auction history is offline.
      }
    };
    void load();
    const timer = setInterval(load, 12_000);
    return () => { live = false; clearInterval(timer); };
  }, [address]);

  return address && snapshot?.address === address.toLowerCase() ? snapshot.bySeries : EMPTY_ACTIVITY;
}
