import type { Metadata } from "next";
import { Suspense } from "react";
import { AppChrome } from "@/components/app-chrome";
import { MarketsScreen } from "@/components/markets-screen";
import { MarketplaceIntro } from "@/components/marketplace-intro";

export const metadata: Metadata = { title: "Markets · erodoro" };

export default function MarketsPage() {
  return (
    <>
      <AppChrome active="/app" />
      <main className="mx-auto w-full max-w-7xl flex-1 px-4 py-8 sm:px-6">
        <MarketplaceIntro />

        <div className="mt-6">
          <Suspense fallback={<p className="text-muted py-8 text-sm">Loading markets…</p>}>
            <MarketsScreen />
          </Suspense>
        </div>
      </main>
    </>
  );
}
