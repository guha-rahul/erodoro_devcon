"use client";

import Link from "next/link";
import { Logo } from "./logo";
import { NavMenu, type NavItem } from "./nav-menu";
import { ThemeToggle } from "./theme-toggle";
import { ConnectButton } from "./connect-button";
import { TourButton } from "./tour";
import { selectAppNetwork, useAppNetwork, type AppChainId } from "@/lib/use-app-network";
import { PreviewBanner } from "./preview-banner";
import { useRole } from "@/lib/use-role";
import { RIPS_ONLY_APP } from "@/lib/rips/ui";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";

const NETWORKS = [
  { value: "8453", label: "Mainnet" },
  { value: "84532", label: "Testnet" },
];

const LEARN: NavItem[] = [
  { href: "/#how", label: "How it works", hint: "Create P and N, then trade the upside" },
  { href: "/#payoff", label: "Payoff", hint: "See how each claim settles" },
  { href: "/#risk", label: "Risk", hint: "Understand seller and buyer losses" },
  { href: "/#faq", label: "FAQ" },
];

const TABS: NavItem[] = [
  { href: "/earn", label: "Earn", hint: "Start from a stock you hold" },
  { href: "/auctions", label: "Auctions", hint: "Bid on live upside auctions" },
  { href: "/app", label: "Markets", hint: "Browse every available upside market" },
  { href: "/rips", label: "My Rips", hint: "Your purchased upside claims" },
  { href: "/market-rip", label: "Market Rip", hint: "Pull one funded stock move for $1" },
  { href: "/rips/sell", label: "Deposit stock", hint: "Lock stock and get paid for upside buyers take" },
  { href: "/swap", label: "Swap", hint: "Swap USDC and wallet stocks on Base" },
  { href: "/portfolio", label: "Portfolio", hint: "What you hold" },
  { href: "/rewards", label: "Rewards", hint: "Points and reward-program status" },
];

// Only where the testnet registry and faucet are deployed. On mainnet there is
// no registry to list against and no test assets to hand out, and either link
// would be a promise the network cannot keep.
const TESTNET_TABS: NavItem[] = [
  { href: "/create", label: "List", hint: "Open a new market" },
  { href: "/faucet", label: "Get test assets" },
];
// What a Rips user needs. Everything else stays routable but unlinked.
const RIPS_TABS: NavItem[] = [
  { href: "/rips/sell", label: "Deposit stock", hint: "Lock stock and get paid for upside buyers take" },
  { href: "/market-rip", label: "Buy Rips", hint: "Pull a $1 Rip or buy a position" },
  { href: "/rips", label: "My Rips", hint: "Your purchased upside claims" },
  { href: "/swap", label: "Buy stocks", hint: "Buy or sell stock tokens with USDC (test tokens on Testnet)" },
];
// `Docs` is deliberately absent until there is a docs page. A nav item pointing
// at a 404 is the exact mistake the early-access link was.

/**
 * The in-app header.
 *
 * Distinct from the landing page's `Nav`: this one carries the network state
 * and the wallet, because everything below it can move money.
 */
export function AppChrome({ active }: { active?: string }) {
  const [, setRole] = useRole();
  const { chainId, name } = useAppNetwork();
  const isTestnet = chainId === 84532;
  const tabs = RIPS_ONLY_APP ? RIPS_TABS : [...TABS, ...(isTestnet ? TESTNET_TABS : [])];
  const selectRole = (href: string) => {
    if (href === "/earn") setRole("seller");
  };
  return (
    <header className="border-line/80 bg-bg/88 sticky top-0 z-50 border-b backdrop-blur-md">
      {/* Persistent, not per-page: a warning that scrolls away is a warning
          somebody misses. */}
      {!isTestnet ? <div className="border-n/30 bg-n/10 text-n border-b px-4 py-2 text-center text-[0.8125rem]">Base Mainnet · Real funds{RIPS_ONLY_APP ? "" : " · Earn deposits are not open"}</div>
        : RIPS_ONLY_APP ? <div className="border-line bg-panel text-muted border-b px-4 py-2 text-center text-[0.8125rem]">Testnet · Base Sepolia · Test USDC and test stocks with no value</div> : <PreviewBanner />}
      <nav className="mx-auto flex min-h-[4.5rem] max-w-7xl flex-wrap items-center justify-between gap-3 px-4 py-3 sm:px-6" aria-label="App">
        <div className="flex items-center gap-6">
          <Logo />
          <div className="hidden items-center gap-1 2xl:flex">
            {tabs.map((t) => (
              <Link
                key={t.href}
                href={t.href}
                onClick={() => selectRole(t.href)}
                aria-current={active === t.href ? "page" : undefined}
                data-tour={t.href === "/portfolio" ? "nav-portfolio" : undefined}
                // Underlined rather than a filled pill: the same square
                // language the landing page uses, and it marks the active tab
                // without moving the row.
                className={`border-b-2 px-3 py-2 text-[0.875rem] transition-colors ${
                  active === t.href
                    ? "border-accent text-text"
                    : "text-muted hover:text-text border-transparent"
                }`}
              >
                {t.label}
              </Link>
            ))}
            {!RIPS_ONLY_APP && <NavMenu label="Learn" items={LEARN} />}
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-3">
          {!RIPS_ONLY_APP && <TourButton />}
          {/* Switching saves the choice and reloads, so every read and wallet
              request starts on the new network. */}
          <Select items={NETWORKS} value={String(chainId)}
            onValueChange={(value) => { if (value) selectAppNetwork(Number(value) as AppChainId); }}>
            <SelectTrigger aria-label="App network" size="sm" className="border-line bg-bg text-text h-auto px-2 py-2 text-xs shadow-none data-[size=sm]:h-auto">
              <SelectValue />
            </SelectTrigger>
            <SelectContent align="end" alignItemWithTrigger={false} className="border-line bg-panel w-auto border shadow-lg ring-0">
              {NETWORKS.map((n) => <SelectItem key={n.value} value={n.value} className="text-xs">{n.label}</SelectItem>)}
            </SelectContent>
          </Select>
          {!RIPS_ONLY_APP && <ThemeToggle />}
          <ConnectButton requiredChainId={chainId} chainName={name} />
        </div>
      </nav>

      {/*
        The row above hides its links below `2xl`, which would leave every app route
        unreachable from a phone — the header offered a wallet and a theme
        toggle and no way to get to Markets, Portfolio or anything else.

        The menus flatten here rather than collapsing into a dropdown. The row
        scrolls inside its own bounds so a long testnet label cannot widen the
        whole page and clip the wallet control above it.
      */}
      <nav
        // Rips has four sections: an even grid on phones, so none hides off-screen.
        className={`border-line/80 max-w-full border-t px-4 py-3 2xl:hidden ${RIPS_ONLY_APP ? "grid grid-cols-4 gap-1.5 sm:flex sm:gap-2" : "flex gap-2 overflow-x-auto"}`}
        aria-label="App sections"
      >
        {(RIPS_ONLY_APP ? tabs : [...tabs, { href: "/#how", label: "Learn" }]).map(
          (t) => (
            <Link
              key={t.href}
              href={t.href}
              onClick={() => selectRole(t.href)}
              aria-current={active === t.href ? "page" : undefined}
              data-tour={t.href === "/portfolio" ? "nav-portfolio-mobile" : undefined}
              className={`shrink-0 rounded-sm border py-1.5 transition-colors ${RIPS_ONLY_APP ? "px-1 text-center text-[0.75rem] leading-tight sm:px-3 sm:text-[0.8125rem]" : "px-3 text-[0.8125rem]"} ${
                active === t.href ? "border-accent text-accent-ink" : "border-line text-muted"
              }`}
            >
              {t.label}
            </Link>
          ),
        )}
      </nav>
    </header>
  );
}
