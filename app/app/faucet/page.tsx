import type { Metadata } from "next";
import { AppChrome } from "@/components/app-chrome";
import { FaucetScreen } from "@/components/faucet-screen";

export const metadata: Metadata = { title: "Get test assets · erodoro" };

export default function FaucetPage() {
  return (
    <>
      <AppChrome active="/faucet" />
      <main className="mx-auto w-full max-w-5xl flex-1 px-4 py-8 sm:px-6">
        <h1 className="font-display text-3xl tracking-[-0.045em]">Get test assets</h1>
        <p className="text-muted mt-3 max-w-[58ch]">
          Claim a test stock and some test cash, then run the whole flow end to end.
        </p>
        <div className="mt-8">
          <FaucetScreen />
        </div>
      </main>
    </>
  );
}
