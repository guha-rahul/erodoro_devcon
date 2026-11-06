"use client";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { CredentialRequest, IDKitErrorCodes, IDKitRequestWidget, type IDKitResult, type RpContext } from "@worldcoin/idkit";
import { formatUnits, zeroAddress, type Address } from "viem";
import { useAccount } from "wagmi";
import { Button } from "@/components/ui/button";
import { HumanRegistryAbi } from "@/lib/abis/HumanRegistry";
import { MarketRipPoolAbi } from "@/lib/abis/MarketRipPool";
import { publicClient } from "@/lib/chain";
import { DEPLOYMENT } from "@/lib/deployment";

/** World ID settings the browser needs. The RP signing key stays with the verifier (app/scripts/world-verifier.mjs). */
const WORLD = {
  appId: (process.env.NEXT_PUBLIC_WLD_APP_ID ?? "") as `app_${string}`,
  rpId: process.env.NEXT_PUBLIC_WLD_RP_ID ?? "",
  action: process.env.NEXT_PUBLIC_WLD_ACTION ?? "buy-rips",
  environment: (process.env.NEXT_PUBLIC_WLD_ENV ?? "staging") as "production" | "staging",
  verifier: process.env.NEXT_PUBLIC_WORLD_VERIFIER_URL ?? "http://localhost:8790",
};

type Status = { registry: Address; verified: boolean; expiresAt: bigint; remaining: bigint; cap: bigint };
type Outcome = "idle" | "verifying" | "verified" | "cancelled" | "ineligible" | "rejected" | "error";

const MESSAGES: Record<Exclude<Outcome, "idle" | "verifying">, string> = {
  verified: "Verified.",
  cancelled: "Cancelled.",
  ineligible: "This World ID can't verify here.",
  rejected: "Proof rejected.",
  error: "Verification failed. Try again.",
};
// Verifier error codes we can explain better than the generic outcome.
const DETAILS: Record<string, string> = {
  signal_mismatch: "The proof is for a different wallet.",
  wrong_credential: "Proof of Human is required.",
  environment_mismatch: "Wrong World ID environment.",
  not_recorded: "Not recorded: this wallet belongs to someone else, or the person was removed.",
  rp_not_configured: "World ID isn't configured on the verifier.",
};

/** The wallet's World ID standing on the pool's gate, or null when the pool has no gate. */
async function readStatus(pool: Address | null, address: Address | undefined): Promise<Status | null> {
  if (!pool || !address) return null;
  const registry = await publicClient.readContract({ address: pool, abi: MarketRipPoolAbi, functionName: "humanGate" }).catch(() => zeroAddress);
  if (registry === zeroAddress) return null;
  const batchId = await publicClient.readContract({ address: pool, abi: MarketRipPoolAbi, functionName: "activeBatchId" });
  const [human, remaining, cap, verified] = await Promise.all([
    publicClient.readContract({ address: registry, abi: HumanRegistryAbi, functionName: "humans", args: [address] }),
    publicClient.readContract({ address: registry, abi: HumanRegistryAbi, functionName: "remainingSpend", args: [address, pool, batchId] }),
    publicClient.readContract({ address: registry, abi: HumanRegistryAbi, functionName: "maxSpendPerBatch" }),
    publicClient.readContract({ address: registry, abi: HumanRegistryAbi, functionName: "isVerified", args: [address] }),
  ]);
  return { registry, verified, expiresAt: human[2], remaining, cap };
}

/**
 * Rips are for verified humans: one person, one allowance per batch, whichever wallets they use. The pool asks
 * HumanRegistry before every sale; a Chainlink CRE workflow checks the World ID proof and writes the registry.
 */
export function HumanCheck() {
  const { address } = useAccount();
  const [status, setStatus] = useState<Status | null>(null);
  const [outcome, setOutcome] = useState<Outcome>("idle");
  const [detail, setDetail] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  const [rpContext, setRpContext] = useState<RpContext | null>(null);
  const settled = useRef(false);
  const pool = DEPLOYMENT.contracts.ripPool;

  const [nonce, setNonce] = useState(0);
  // Purchases elsewhere on the page spend the allowance; re-read it every 15 seconds.
  useEffect(() => {
    const timer = setInterval(() => setNonce(n => n + 1), 15_000);
    return () => clearInterval(timer);
  }, []);
  useEffect(() => {
    let live = true;
    readStatus(pool, address).then((r) => { if (live) setStatus(r); }, () => undefined);
    return () => { live = false; };
  }, [pool, address, nonce]);

  // v4 Proof of Human with the wallet as the signal: a proof made for one wallet can't verify another.
  const constraints = useMemo(() => address ? CredentialRequest("proof_of_human", { signal: address }) : null, [address]);

  const start = useCallback(async () => {
    settled.current = false;
    setDetail(null);
    const res = await fetch(`${WORLD.verifier}/rp-context`, { method: "POST" }).catch(() => null);
    const body = await res?.json().catch(() => ({}));
    if (!res?.ok) {
      setOutcome("error");
      setDetail(DETAILS[body?.code] ?? "The World ID verifier isn't reachable.");
      return;
    }
    setRpContext({ rp_id: WORLD.rpId, nonce: body.nonce, created_at: body.created_at, expires_at: body.expires_at, signature: body.sig });
    setOutcome("verifying");
    setOpen(true);
  }, []);

  const handleVerify = useCallback(async (result: IDKitResult) => {
    const res = await fetch(`${WORLD.verifier}/verify`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ wallet: address, idkitResponse: result }),
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) {
      // onError only receives "failed_by_host_app", so keep the reason here.
      setDetail(DETAILS[body.code] ?? body.code ?? "verification_failed");
      throw new Error(body.code ?? "verification_failed");
    }
  }, [address]);

  if (!status || !address) return null;
  const capText = status.cap === 0n ? null : `$${formatUnits(status.remaining, 6)} of $${formatUnits(status.cap, 6)} left this batch`;

  return <section aria-label="World ID" className="mt-4 border border-line p-4 text-sm">
    {status.verified ? <p>
      <span className="font-medium">Verified human</span>
      {capText && <span className="text-muted"> · {capText}</span>}
    </p> : <div className="flex flex-wrap items-center justify-between gap-3">
      <p>
        <span className="font-medium">Verify you&apos;re human to buy Rips</span>
        {status.cap !== 0n && <span className="text-muted"> · ${formatUnits(status.cap, 6)} per person per batch</span>}
      </p>
      <Button onClick={() => void start()} disabled={outcome === "verifying" || !constraints}>
        {outcome === "verifying" ? "Verifying…" : "Verify with World ID"}
      </Button>
    </div>}
    {rpContext && constraints && <IDKitRequestWidget
      key={rpContext.nonce}
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        // Closing the widget doesn't fire onError, so an unsettled close is a cancel.
        if (!next && !settled.current) { settled.current = true; setOutcome("cancelled"); }
      }}
      app_id={WORLD.appId}
      action={WORLD.action}
      rp_context={rpContext}
      allow_legacy_proofs={false}
      constraints={constraints}
      environment={WORLD.environment}
      handleVerify={handleVerify}
      onSuccess={() => { settled.current = true; setOutcome("verified"); setNonce(n => n + 1); }}
      onError={(code) => {
        settled.current = true;
        switch (code) {
          case IDKitErrorCodes.UserRejected:
          case IDKitErrorCodes.VerificationRejected:
          case IDKitErrorCodes.Cancelled: setOutcome("cancelled"); break;
          case IDKitErrorCodes.CredentialUnavailable:
          case IDKitErrorCodes.WorldId4NotAvailable:
          case IDKitErrorCodes.NullifierReplayed:
          case IDKitErrorCodes.MaxVerificationsReached: setOutcome("ineligible"); break;
          case IDKitErrorCodes.FailedByHostApp: setOutcome("rejected"); break;
          default: setOutcome("error");
        }
      }}
    />}
    {outcome !== "idle" && outcome !== "verifying" && <p role="status" className="mt-2">
      {MESSAGES[outcome]}{detail && <span className="block text-muted">{detail}</span>}
    </p>}
  </section>;
}
