import type { Metadata } from "next";
import { AppChrome } from "@/components/app-chrome";
import { LiveAuctionTable } from "@/components/auction/LiveAuctionTable";

export const metadata: Metadata = {
  title: "Live Auctions · erodoro",
  description: "Bid on tokenized-stock upside. The highest valid premium wins when time expires.",
};

export default function AuctionsPage() {
  return (
    <>
      <AppChrome active="/auctions" />
      <main className="mx-auto w-full max-w-7xl flex-1 px-4 py-8 sm:px-6">
        <h1 className="font-display text-3xl tracking-[-0.045em]">Live auctions</h1>
        <p className="text-muted mt-3 max-w-[64ch]">
          Choose the upside you want and enter your maximum premium. The highest valid bid wins.
        </p>
        <div className="mt-8">
          <LiveAuctionTable />
        </div>
      </main>
    </>
  );
}
