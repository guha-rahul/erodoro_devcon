"use client";

import { useState } from "react";
import { useAccount, useConfig, useReadContract, useWriteContract } from "wagmi";
import { waitForTransactionReceipt } from "wagmi/actions";
import { TestIssuerControlsAbi } from "@/lib/abis";
import { useDeployment } from "@/lib/use-app-network";
import type { Address } from "@/lib/types";
import { Button, Panel } from "./ui";

/**
 * Pull the issuer's levers, on purpose.
 *
 * The issuer controls are the part of this protocol most likely to be wrong and
 * the hardest to test, because in the real world they belong to the issuer and
 * fire without warning. Here a tester can fire them deliberately and watch what
 * happens.
 *
 * A simulated split is the one that matters. It is what the strike adjustment
 * exists for: get it wrong and a market's upside is wiped out by an event in
 * which nobody lost a penny.
 */
export function IssuerSandbox() {
  const { isConnected } = useAccount();
  const config = useConfig();
  const { writeContractAsync } = useWriteContract();
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const { deployment, isTestnet } = useDeployment();
  const controls = deployment.contracts.issuerControls as Address | null;

  const state = useReadContract({
    address: controls ?? undefined,
    abi: TestIssuerControlsAbi,
    functionName: "state",
    query: { enabled: Boolean(controls), refetchInterval: 15_000 },
  });

  if (!isTestnet || !controls) return null;

  const [multiplier, paused] = (state.data as readonly [bigint, boolean] | undefined) ?? [10n ** 18n, false];
  const rebased = multiplier !== 10n ** 18n;

  const run = async (label: string, fn: () => Promise<`0x${string}`>) => {
    setBusy(label);
    setError(null);
    try {
      const hash = await fn();
      await waitForTransactionReceipt(config, { hash });
      void state.refetch();
    } catch (e) {
      setError(e instanceof Error ? e.message : "That failed.");
    } finally {
      setBusy(null);
    }
  };

  // Written out rather than behind a generic helper: a `functionName: string`
  // discards the ABI's type narrowing, which is the reason these are generated.
  const split = (n: bigint, d: bigint) =>
    writeContractAsync({ address: controls, abi: TestIssuerControlsAbi, functionName: "simulateSplit", args: [n, d] });
  const reset = () =>
    writeContractAsync({ address: controls, abi: TestIssuerControlsAbi, functionName: "resetMultiplier" });
  const setPaused = (next: boolean) =>
    writeContractAsync({ address: controls, abi: TestIssuerControlsAbi, functionName: "setTransfersPaused", args: [next] });

  return (
    <Panel title="Simulate issuer control" subtitle="Fire the levers a real issuer holds, and watch what the protocol does">
      <dl className="grid gap-2 text-[0.875rem]">
        <Row label="Multiplier" value={rebased ? `${Number(multiplier) / 1e18}× — rebased` : "1× — unchanged"} />
        <Row label="Transfers" value={paused ? "Paused" : "Live"} />
      </dl>

      <div className="mt-4 flex flex-wrap gap-2">
        <Button size="sm" busy={busy === "split"} disabled={!isConnected} onClick={() => run("split", () => split(2n, 1n))}>
          2-for-1 split
        </Button>
        <Button size="sm" busy={busy === "reverse"} disabled={!isConnected} onClick={() => run("reverse", () => split(1n, 2n))}>
          1-for-2 reverse
        </Button>
        <Button size="sm" tone="ghost" busy={busy === "reset"} disabled={!isConnected || !rebased} onClick={() => run("reset", () => reset())}>
          Reset
        </Button>
        <Button size="sm" tone="ghost" busy={busy === "pause"} disabled={!isConnected} onClick={() => run("pause", () => setPaused(!paused))}>
          {paused ? "Resume transfers" : "Pause transfers"}
        </Button>
      </div>

      {error && (
        <p className="border-danger/40 bg-danger/8 text-danger mt-3 rounded-sm border px-3 py-2 text-[0.82rem]">{error}</p>
      )}

      <p className="text-dim mt-4 text-[0.78rem] leading-5">
        A split rebases every balance and halves the quoted price. A market&rsquo;s strike is
        adjusted by the same ratio at settlement, so a pure split moves no value between the two
        sides — that is what this is here to let you check. Pausing transfers must delay
        redemption, never strand it.
      </p>
      <p className="text-dim mt-2 text-[0.78rem] leading-5">
        Seizure is not here. On this release it needs the vault denied under a transfer policy
        first, which would also stop it paying redeemers — a policy change, not a role, so it is
        left out rather than faked.
      </p>
    </Panel>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="border-line-soft flex items-baseline justify-between gap-4 border-t pt-2 first:border-t-0 first:pt-0">
      <dt className="text-dim">{label}</dt>
      <dd className="font-mono tabular-nums">{value}</dd>
    </div>
  );
}
