"use client";

const STEPS = ["Created", "Live", "Buyer found", "Settling", "Complete"] as const;
const MOMENTS = [
  "Your offer is ready.",
  "Your upside is live.",
  "A buyer has entered.",
  "Confirming the trade on Base.",
  "Trade complete.",
] as const;

/** Created → Live → Clearing → Settling → Settled. */
export function AuctionTimeline({ state }: { state: string | undefined }) {
  const current = (() => {
    switch (state) {
      case "SettlementPending":
        return 3;
      case "Filled":
      case "Settled":
        return 4;
      case "FastAuction":
      case "DiscoveryAuction":
        return 1;
      case "BidReceived":
      case "PartiallyFilled":
        return 2;
      default:
        return 0;
    }
  })();
  return (
    <div className="rounded-sm border border-line-soft bg-panel-2 p-4">
      <div className="mb-3 flex items-center justify-between gap-3">
        <p className="font-medium">{MOMENTS[current]}</p>
        <span className="text-accent-ink font-mono text-[0.72rem]">{current + 1}/{STEPS.length}</span>
      </div>
      <ol className="flex items-center gap-1" aria-label="Auction progress">
      {STEPS.map((label, i) => {
        const reached = i <= current;
        const active = i === current && current < STEPS.length - 1;
        return (
          <li key={label} className="flex flex-1 items-center gap-1 last:flex-none">
            <div className="flex items-center gap-2">
              <span
                aria-hidden
                className={`h-2 w-2 rounded-full ${
                  reached ? "bg-accent" : "border-line bg-transparent border"
                } ${active ? "animate-pulse" : ""}`}
              />
              <span
                className={`text-[0.72rem] tracking-[0.06em] uppercase ${
                  reached ? "text-text font-medium" : "text-dim"
                }`}
              >
                {label}
              </span>
            </div>
            {i < STEPS.length - 1 && <span aria-hidden className={`mx-2 h-px flex-1 ${i < current ? "bg-accent" : "bg-line-soft"}`} />}
          </li>
        );
      })}
      </ol>
    </div>
  );
}
