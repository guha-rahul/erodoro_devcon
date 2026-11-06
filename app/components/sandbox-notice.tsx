"use client";

import Link from "next/link";
import { useState } from "react";
import { IS_TESTNET } from "@/lib/deployment";

/**
 * A quiet reminder that none of this is worth anything, with the way to get
 * started right next to it.
 *
 * Dismissible, because it is a reminder rather than a warning — the banner in
 * the header already carries the warning and cannot be dismissed.
 */
export function SandboxNotice() {
  const [visible, setVisible] = useState(true);
  if (!IS_TESTNET || !visible) return null;
  return (
    <aside
      data-tour="test-stock-entry"
      className="border-line text-muted mt-5 flex flex-wrap items-center justify-between gap-3 border-y py-3 text-[0.8125rem]"
    >
      <span>Test network · these assets have no real value.</span>
      <span className="flex items-center gap-4">
        <Link href="/faucet" className="text-accent hover:underline">
          Get test assets
        </Link>
        <button type="button" onClick={() => setVisible(false)} className="text-dim hover:text-text">
          Dismiss
        </button>
      </span>
    </aside>
  );
}
