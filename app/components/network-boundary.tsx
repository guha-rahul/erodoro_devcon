"use client";

import { useAccount, useSwitchChain } from "wagmi";
import { useDeployment } from "@/lib/use-app-network";
import { REQUIRED_CHAIN_ID } from "@/lib/wagmi";
import { Button, EmptyState } from "./ui";
import type { ReactNode } from "react";

/**
 * Refuses to render anything that can move money while the wallet is on the
 * wrong network.
 *
 * The connect button already offers to switch, but a header control is easy to
 * miss and the screen underneath still looks usable. A transaction sent to the
 * wrong chain is not recoverable by this app, so the page gets covered rather
 * than merely annotated.
 *
 * A disconnected wallet is *not* wrong — reading is fine without one, and every
 * write path asks for a wallet on its own.
 */
export function NetworkBoundary({ children }: { children: ReactNode }) {
  const { isConnected, chainId } = useAccount();
  const { switchChain, isPending } = useSwitchChain();
  const { deployment: DEPLOYMENT, isLive } = useDeployment();

  if (!isLive) {
    return (
      <EmptyState
        title="Nothing deployed here"
        body={`There are no contracts on ${DEPLOYMENT.chainName}, so there is nothing to show or do yet.`}
      />
    );
  }

  if (isConnected && chainId !== REQUIRED_CHAIN_ID) {
    return (
      <EmptyState
        title={`Switch to ${DEPLOYMENT.chainName}`}
        body={`Your wallet is on a different network. Nothing here will work until it is on ${DEPLOYMENT.chainName}, and a transaction sent to the wrong network cannot be recovered from this app.`}
        action={
          <Button busy={isPending} onClick={() => switchChain({ chainId: REQUIRED_CHAIN_ID })}>
            Switch network
          </Button>
        }
      />
    );
  }

  return <>{children}</>;
}
