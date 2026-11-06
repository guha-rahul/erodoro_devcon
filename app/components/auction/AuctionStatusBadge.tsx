"use client";

/** Auction lifecycle badge. No red/green semantics — state, not price action. */
const STYLES: Record<string, string> = {
  LIVE: "border-accent text-accent-ink",
  Bidding: "border-accent text-accent-ink",
  Winner: "border-bid text-bid",
  Settled: "border-p text-p",
  Filled: "border-p text-p",
  Ended: "border-line text-muted",
  Cancelled: "border-line text-muted",
  Expired: "border-line text-muted",
  Failed: "border-danger text-danger",
};

export function AuctionStatusBadge({ status }: { status: string }) {
  const tone = STYLES[status] ?? STYLES.Ended;
  const pulse = status === "LIVE" || status === "Bidding";
  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-sm border px-2 py-0.5 text-[0.72rem] font-medium tracking-[0.08em] uppercase ${tone}`}
    >
      <span aria-hidden className={`h-1.5 w-1.5 rounded-full bg-current ${pulse ? "animate-pulse" : ""}`} />
      {status}
    </span>
  );
}

/** Map a coordinator auction state to a display step. */
export function auctionDisplayState(state: string | undefined): string {
  switch (state) {
    case "FastAuction":
    case "DiscoveryAuction":
    case "BidReceived":
      return "Bidding";
    case "SettlementPending":
      return "Winner";
    case "Filled":
    case "Settled":
      return "Settled";
    case "Cancelled":
      return "Cancelled";
    case "Expired":
      return "Expired";
    case "Failed":
      return "Failed";
    case "PartiallyFilled":
      return "Bidding";
    default:
      return "Bidding";
  }
}
