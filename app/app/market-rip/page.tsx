import type { Metadata } from "next";
import { RipsShell } from "@/components/rips/rips-shell";
import { MarketRipScreen } from "@/components/market-rip-screen";

export const metadata: Metadata = {
  title: "Market Rip · erodoro",
  description: "Pull one live stock move for $1 USDC.",
};

export default function MarketRipPage() {
  return (
    <RipsShell><MarketRipScreen /></RipsShell>
  );
}
