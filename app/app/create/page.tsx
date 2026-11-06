import type { Metadata } from "next";
import { AppChrome } from "@/components/app-chrome";
import { CreatePanel } from "@/components/create-panel";
import { NetworkBoundary } from "@/components/network-boundary";

export const metadata: Metadata = { title: "List a market · erodoro" };

export default function CreatePage() {
  return (
    <>
      <AppChrome active="/create" />
      <main className="mx-auto w-full max-w-6xl flex-1 px-4 py-8 sm:px-6">
        <h1 className="font-display text-3xl tracking-[-0.045em]">List a market</h1>
        <p className="text-muted mt-3 max-w-[64ch] leading-7">
          A market is one stock, one strike and one expiry. Listing it through the registry is what
          makes it canonical and visible here.
        </p>
        <div className="mt-8">
          <NetworkBoundary>
            <CreatePanel />
          </NetworkBoundary>
        </div>
      </main>
    </>
  );
}
