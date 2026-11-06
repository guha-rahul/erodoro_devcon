import type { Metadata } from "next";
import { AppChrome } from "@/components/app-chrome";
import { PositionsPanel } from "@/components/positions-panel";
import { AuctionPortfolio } from "@/components/auction/Portfolio";
import { TokenBalances } from "@/components/token-balances";
import { NetworkBoundary } from "@/components/network-boundary";
import { PremiumHistory } from "@/components/premium-history";

export const metadata: Metadata = { title: "Portfolio · erodoro" };

export default function PortfolioPage() {
  return (
    <>
      <AppChrome active="/portfolio" />
      <main className="mx-auto w-full max-w-5xl flex-1 px-4 py-8 sm:px-6">
        <h1 className="font-display mt-6 text-3xl tracking-[-0.045em]">Your portfolio</h1>
        <p className="text-muted mt-3 max-w-[60ch]">
          Your positions, premiums, and tokens.
        </p>
        <div data-tour="portfolio-positions" className="mt-6 grid items-start gap-6 lg:grid-cols-[minmax(0,1fr)_18rem]">
          <NetworkBoundary>
            <PositionsPanel />
          </NetworkBoundary>
          <TokenBalances />
        </div>
        <div className="mt-6"><NetworkBoundary><PremiumHistory /></NetworkBoundary></div>
        <div className="mt-6"><NetworkBoundary><AuctionPortfolio /></NetworkBoundary></div>
      </main>
    </>
  );
}
