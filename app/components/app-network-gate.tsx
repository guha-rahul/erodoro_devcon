"use client";

import type { ReactNode } from "react";
import { usePathname } from "next/navigation";
import { useAccount } from "wagmi";
import { useAppNetwork } from "@/lib/use-app-network";
import { AppChrome } from "./app-chrome";
import { ConnectButton } from "./connect-button";
import Link from "next/link";

export function AppNetworkGate({ children }: { children: ReactNode }) {
  const path = usePathname();
  const { chainId, name } = useAppNetwork();
  const wallet = useAccount();
  const appRoute = /^\/(swap|earn|app|portfolio|rewards|create|faucet)(\/|$)/.test(path);
  if (!appRoute) return children;
  const swap = path === "/swap";
  const rewards = path === "/rewards";
  const mainnetReadOnly = chainId === 8453 && (path === "/earn" || path === "/portfolio");
  // Swap runs on both: real stocks on Mainnet, test stocks for test USDC on
  // Sepolia. Earn and the markets are deployed on Sepolia only.
  const unavailable = !swap && !rewards && chainId === 8453;
  const wrongWallet = !rewards && wallet.isConnected && wallet.chainId !== chainId;
  if (!unavailable && !wrongWallet) return children;
  if (mainnetReadOnly && !wrongWallet) {
    const earn = path === "/earn";
    return <>
      <AppChrome active={path} />
      <main className="mx-auto w-full max-w-2xl flex-1 px-6 py-16">
        <p className="text-n text-xs tracking-[0.12em] uppercase">Base Mainnet</p>
        <h1 className="font-display mt-3 text-3xl tracking-[-0.045em]">
          {earn ? "Earn on Base Mainnet" : "Base Mainnet portfolio"}
        </h1>
        <p className="text-muted mt-4 max-w-[62ch] leading-7">
          {earn
            ? "Mainnet deposits are not open yet. The deployed factory currently has no canonical market, so there is no cap and expiry that can safely accept a stock deposit."
            : "There are no Erodoro positions to display on Base Mainnet because no canonical Mainnet market has been listed yet."}
        </p>
        <div className="border-line bg-panel mt-8 rounded-sm border p-5">
          <h2 className="font-medium">{earn ? "What you can do now" : "Nothing is hidden"}</h2>
          <p className="text-muted mt-2 text-sm leading-6">
            {earn
              ? "You can swap supported tokenized stocks on Base Mainnet, or switch to Base Sepolia to try the complete Earn lifecycle with test assets."
              : "This page will read Mainnet P and N claims once a canonical market exists. Sepolia positions remain separate and appear only when Base Sepolia is selected."}
          </p>
          <div className="mt-5 flex flex-wrap gap-3">
            <Link href="/swap" className="bg-text text-bg hover:bg-accent rounded-sm px-4 py-2 text-sm font-medium transition-colors">
              Swap on Mainnet
            </Link>
            <button
              type="button"
              onClick={() => {
                localStorage.setItem("erodoro.network", "84532");
                window.location.reload();
              }}
              className="border-line hover:border-text rounded-sm border px-4 py-2 text-sm font-medium transition-colors"
            >
              Try Sepolia
            </button>
          </div>
        </div>
      </main>
    </>;
  }
  return <>
    <AppChrome active={path.startsWith("/app/") ? "/app" : path} />
    <main className="mx-auto w-full max-w-xl px-6 py-20 text-center">
      <h1 className="text-2xl font-medium">{unavailable
        ? "This feature is not available on Base Mainnet"
        : `Switch your wallet to ${name}`}</h1>
      <p className="text-muted my-6">{unavailable
        ? "Choose Base Sepolia to try the configured testnet markets. Mainnet Earn is not enabled in this app yet."
        : "Your app and wallet must use the same network before continuing. Switching networks does not move your tokens."}</p>
      {wrongWallet && <ConnectButton requiredChainId={chainId} chainName={name} />}
    </main>
  </>;
}
