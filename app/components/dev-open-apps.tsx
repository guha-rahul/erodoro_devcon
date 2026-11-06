"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useState } from "react";

// Every route, including the ones the Rips-only header hides. Local dev only.
const GROUPS: { title: string; links: [string, string][] }[] = [
  { title: "Rips", links: [["Landing", "/"], ["Deposit stock", "/rips/sell"], ["Buy Rips", "/market-rip"], ["My Rips", "/rips"]] },
  { title: "Protocol", links: [["Markets", "/app"], ["Earn", "/earn"], ["Portfolio", "/portfolio"], ["Auctions", "/auctions"], ["Rewards", "/rewards"]] },
  { title: "Trade", links: [["Swap", "/swap"], ["Swap · sell", "/swap?direction=sell"]] },
  { title: "Design", links: [["Motion lab", "/lab/motion"]] },
  { title: "Testnet", links: [["List a market", "/create"], ["Get test assets", "/faucet"]] },
];

/** A floating "Open apps" panel linking every page, shown only by `next dev`. */
export function DevOpenApps() {
  const [open, setOpen] = useState(false);
  const path = usePathname();
  if (process.env.NODE_ENV !== "development") return null;
  return (
    <div className="fixed right-4 bottom-4 z-[90] flex flex-col items-end gap-2 font-mono text-xs">
      {open && (
        <nav aria-label="Open apps" className="border-line bg-panel w-56 border p-3 shadow-xl">
          {GROUPS.map((g) => (
            <div key={g.title} className="mb-2.5 last:mb-0">
              <p className="text-dim mb-1 text-[0.625rem] tracking-[0.14em] uppercase">{g.title}</p>
              <ul>
                {g.links.map(([label, href]) => (
                  <li key={href}>
                    <Link
                      href={href}
                      onClick={() => setOpen(false)}
                      className={`hover:bg-panel-2 block px-1.5 py-1 ${path === href.split("?")[0] ? "text-accent-ink" : "text-text"}`}
                    >
                      {label} <span className="text-dim">{href}</span>
                    </Link>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </nav>
      )}
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        className="border-line bg-panel text-text hover:border-text border px-3 py-2 tracking-[0.1em] uppercase shadow-md"
      >
        {open ? "Close" : "Open apps"}
      </button>
    </div>
  );
}
