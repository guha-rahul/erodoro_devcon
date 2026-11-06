"use client";

import { useSearchParams } from "next/navigation";
import { StockSwap } from "./stock-swap";

export function SwapScreen() {
  const params = useSearchParams();
  const side = params.get("direction") === "sell" ? "sell" : "buy";
  // Shallow URL update: no navigation, so the chosen stock survives the reversal
  // even where the static export would otherwise reload the page.
  return <StockSwap side={side} onReverse={() => window.history.replaceState(null, "", side === "buy" ? "/swap?direction=sell" : "/swap")} />;
}
