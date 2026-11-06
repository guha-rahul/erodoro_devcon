"use client";

import { useSyncExternalStore } from "react";
import { ACTIVE_CHAIN_ID, BUILD_CHAIN_ID, DEPLOYMENT, DEPLOYMENTS, NETWORK_STORAGE_KEY } from "./deployment";

export type AppChainId = 8453 | 84532;
const subscribe = () => () => {};

/**
 * The network the app is on: the header toggle's saved choice, which
 * `DEPLOYMENT` already read when the page loaded. The prerendered page shows
 * the build default until hydration, so it reports that first.
 */
export function useAppNetwork() {
  const chainId = useSyncExternalStore(subscribe, () => ACTIVE_CHAIN_ID, () => BUILD_CHAIN_ID) as AppChainId;
  return { chainId, name: chainId === 8453 ? "Base Mainnet" : "Base Sepolia", isTestnet: chainId !== 8453 };
}

/**
 * The deployment to render with. Static pages are prerendered for the build's
 * network, so this returns that one while hydrating and the selected one right
 * after; reading `DEPLOYMENT` during render instead makes a page whose network
 * was switched disagree with its own HTML.
 */
export function useDeployment() {
  const id = useSyncExternalStore(subscribe, () => ACTIVE_CHAIN_ID, () => BUILD_CHAIN_ID);
  const deployment = DEPLOYMENTS[id] ?? DEPLOYMENT;
  return { deployment, isLive: deployment.status === "live" && deployment.contracts.vault !== null, isTestnet: deployment.chainId !== 8453 };
}

export function selectAppNetwork(chainId: AppChainId) {
  // A new document discards queries, amounts and asynchronous transaction
  // continuations BEFORE the wallet is asked to change networks, and lets every
  // module read the new chain from the start.
  try { localStorage.setItem(NETWORK_STORAGE_KEY, String(chainId)); } catch {
    window.alert("Allow browser storage to remember your network selection.");
    return;
  }
  window.location.reload();
}
