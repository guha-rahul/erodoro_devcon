import type { Metadata } from "next";
import { AppChrome } from "@/components/app-chrome";
import { EarnAuctionScreen, EarnConnectHint } from "@/components/earn-auction-screen";

export const metadata: Metadata = {
  title: "Earn · erodoro",
  description: "Auction your stock upside for an upfront USDC premium.",
};

export default function EarnPage() {
  return (
    <>
      <AppChrome active="/earn" />
      <main className="mx-auto w-full max-w-6xl flex-1 px-4 py-8 sm:px-6">
        <h1 className="font-display text-3xl tracking-[-0.045em]">Earn premium on your stocks</h1>
        <p className="text-muted mt-3 max-w-[58ch]">
          Choose your terms. Receive a premium when a buyer takes your upside.
        </p>
        <div className="mt-8">
          <EarnAuctionScreen />
          <EarnConnectHint />
        </div>
      </main>
    </>
  );
}
