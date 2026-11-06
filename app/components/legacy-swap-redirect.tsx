"use client";

import { useEffect } from "react";

export function LegacySwapRedirect({ side }: { side: "buy" | "sell" }) {
  const target = side === "sell" ? "/swap?direction=sell" : "/swap";
  useEffect(() => { window.location.replace(target); }, [target]);
  return <p className="p-6">Opening Swap… <a href={target}>Continue to Swap</a></p>;
}
