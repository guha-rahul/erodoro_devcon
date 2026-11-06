"use client";

import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { MarketsTable } from "./markets-table";
import { SandboxNotice } from "./sandbox-notice";
import { SeriesDetail } from "./series-detail";

/**
 * Keep every market detail on the permanent `/app` static route.
 *
 * Markets are listed onchain after the frontend has been built. A static
 * `/app/:id` page cannot exist for a newly listed id, but a query-selected
 * client view can open any id without waiting for another deployment.
 */
export function MarketsScreen() {
  const searchParams = useSearchParams();
  const market = searchParams.get("market");

  if (market !== null) {
    const id = /^[0-9a-fA-F]{64}$/.test(market) ? BigInt(`0x${market}`) : null;
    const auctionParam = searchParams.get("auction");
    const auction = auctionParam && /^0x[0-9a-fA-F]{64}$/.test(auctionParam) ? (auctionParam as `0x${string}`) : null;
    return (
      <>
        <Link href="/app" className="text-muted hover:text-text text-sm underline underline-offset-4">
          ← All markets
        </Link>
        <div className="mt-6">
          <SeriesDetail id={id} auctionHash={auction} positionView={searchParams.get("position") === "1"} />
        </div>
      </>
    );
  }

  return (
    <div className="space-y-4">
      <div data-tour="series-list">
        <MarketsTable />
      </div>
      <SandboxNotice />
    </div>
  );
}
