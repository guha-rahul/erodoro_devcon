"use client";

import type { ReactNode } from "react";
import { REQUIRED_CHAIN_ID } from "@/lib/wagmi";

/** Use a fresh document so the previous network's cached state is discarded. */
export function EarnEntryLink({ children, className }: { children: ReactNode; className?: string }) {
  return <a href="/earn" className={className} onClick={(event) => {
    try { localStorage.setItem("erodoro.network", String(REQUIRED_CHAIN_ID)); }
    catch {
      event.preventDefault();
      window.alert("Allow browser storage to select the Earn network, then try again.");
    }
  }}>{children}</a>;
}
