"use client";

import { useEffect, useState } from "react";
import { useAccount, useConfig } from "wagmi";
import { canBatchAtomically } from "./batching";

export type BatchMode = "checking" | "atomic" | "sequential";

/**
 * What the connected wallet can do on `chainId`.
 *
 * `atomic` means it can bundle the approval and the action into one signature
 * prompt; `sequential` means the two-step fallback is in use. The UI shows this
 * so a user can tell which path their wallet took.
 */
export function useBatchMode(chainId: number): BatchMode {
  const { address } = useAccount();
  const config = useConfig();
  const [resolved, setResolved] = useState<{ key: string; supported: boolean } | null>(null);

  const key = address ? `${address.toLowerCase()}:${chainId}` : null;

  useEffect(() => {
    if (!address) return;
    const requestKey = `${address.toLowerCase()}:${chainId}`;
    let live = true;
    canBatchAtomically(config, address, chainId).then((supported) => {
      if (live) setResolved({ key: requestKey, supported });
    });
    return () => {
      live = false;
    };
  }, [address, chainId, config]);

  if (!address) return "sequential";
  if (resolved?.key === key) return resolved.supported ? "atomic" : "sequential";
  return "checking";
}
