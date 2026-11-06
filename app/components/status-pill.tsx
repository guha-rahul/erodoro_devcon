import type { DisplayStatus } from "@/lib/market-status";

const TONE: Record<DisplayStatus, string> = {
  Open: "border-p/40 text-p",
  Paused: "border-n/40 text-n",
  "Awaiting settlement": "border-n/40 text-n",
  Redeemable: "border-accent/45 text-accent",
};

export function StatusPill({ status }: { status: DisplayStatus }) {
  return (
    <span
      className={`shrink-0 rounded-sm border px-2 py-1 font-mono text-[0.72rem] tracking-[0.08em] whitespace-nowrap uppercase ${TONE[status]}`}
    >
      {status}
    </span>
  );
}
