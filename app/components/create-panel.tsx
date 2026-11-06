"use client";

import { useState } from "react";
import { useAccount, useConfig, useWriteContract } from "wagmi";
import { waitForTransactionReceipt } from "wagmi/actions";
import { FactoryAbi, IFallbackSettlementOracleAbi } from "@/lib/abis";
import { useDeployment } from "@/lib/use-app-network";
import { listedAssets } from "@/lib/issuers";
import { useFactory, useSettlementConfiguration } from "@/lib/use-factory";
import { toRaw } from "@/lib/format";
import { useNow } from "@/lib/use-now";
import { publicClient } from "@/lib/chain";
import type { Address } from "@/lib/types";
import { AmountInput, Button, EmptyState, Panel, TxStatus } from "./ui";
import type { SendState } from "@/lib/tx";

/**
 * List a market.
 *
 * Creating a market on the vault is permissionless — anyone can. What this does
 * is list one through the registry, which is what makes it *canonical* and
 * therefore visible in the app. The registry's bounds are read and enforced
 * here so the form can refuse before a wallet opens, rather than letting the
 * user find out as a revert.
 *
 * The registry steps are only shown to whoever holds the registry. A trader
 * seeing four approval steps they cannot perform learns nothing except that the
 * product is not for them.
 */
export function CreatePanel() {
  const { address, isConnected } = useAccount();
  const config = useConfig();
  const { writeContractAsync } = useWriteContract();
  const { factory, bounds, isAdmin, creationPaused, loading } = useFactory();

  const { isTestnet } = useDeployment();
  const assets = isTestnet ? listedAssets() : listedAssets().filter((a) => !a.isTestAsset);
  const [token, setToken] = useState<Address | "">("");
  const [strike, setStrike] = useState("");
  const [days, setDays] = useState("30");
  const [state, setState] = useState<SendState>({ kind: "idle" });
  // A subscribable clock rather than Date.now(): reading the clock during
  // render is impure, and this ticks so the computed expiry stays current.
  const now = useNow();

  const asset = assets.find((a) => a.token === token) ?? null;
  const settlement = useSettlementConfiguration(token || undefined);

  const problem = (() => {
    if (!bounds) return "Reading the registry…";
    if (creationPaused) return "The registry is not accepting new listings.";
    if (!token) return "Choose a stock.";
    if (!strike || Number(strike) <= 0) return "Set a strike.";
    const d = Number(days);
    if (!d || d <= 0) return "Set an expiry.";
    const seconds = BigInt(Math.floor(d * 86_400));
    if (seconds < bounds.minHorizon) return `Expiry must be at least ${Number(bounds.minHorizon) / 86_400} days out.`;
    if (seconds > bounds.maxHorizon) return `Expiry must be within ${Math.floor(Number(bounds.maxHorizon) / 86_400)} days.`;
    if (settlement.loading) return "Reading this stock's settlement configuration…";
    if (settlement.error || !settlement.configuration) return "This stock is not enabled with a readable settlement configuration.";
    if (!settlement.configuration.enabled) return "This stock's settlement configuration is disabled.";
    return null;
  })();

  // In a callback, not the render body: reading the clock during render is
  // impure, and the value wanted here is the time at the click anyway.
  const create = async () => {
    // Guarded here rather than relying on the early returns below: this
    // runs above them, so nothing is narrowed yet.
    const terms = settlement.configuration;
    if (!bounds || !asset || !factory || !terms?.enabled || !address) return;
    try {
      setState({ kind: "sending", phase: "approval" });
      const maturity = now + BigInt(Math.floor(Number(days) * 86_400));
      // The primary window must remain open until settlement can begin. Using
      // minPriceLag directly can produce a one-second window even when the
      // registry requires a much longer settlement delay.
      const maxPriceLag =
        bounds.minSettlementDelay > bounds.minPriceLag
          ? bounds.minSettlementDelay
          : bounds.minPriceLag;
      const recoveryTime = maturity + maxPriceLag + terms.fallbackDelay;
      const hasFallback = terms.fallbackOracle !== "0x0000000000000000000000000000000000000000";
      const fallbackRequestId = hasFallback
        ? await publicClient.readContract({
            address: terms.fallbackOracle,
            abi: IFallbackSettlementOracleAbi,
            functionName: "requestIdFor",
            args: [maturity, recoveryTime],
          })
        : "0x0000000000000000000000000000000000000000000000000000000000000000";
      const hash = await writeContractAsync({
        address: factory,
        abi: FactoryAbi,
        functionName: "createSeries",
        args: [
          {
            collateral: asset.token,
            oracle: terms.oracle,
            fallbackOracle: terms.fallbackOracle,
            feeRecipient: address,
            feedId: terms.feedId,
            fallbackRequestId,
            settlementModel: terms.settlementModel,
            strike: toRaw(strike, terms.priceDecimals),
            minSplitAmount: 0n,
            maturity,
            // Taken from the registry's own floor rather than invented, so a
            // listing cannot be created with terms the registry would reject.
            settlementDelay: bounds.minSettlementDelay,
            maxPriceLag,
            fallbackDelay: terms.fallbackDelay,
            maxConfBps: terms.settlementModel === 0 ? bounds.maxConfBps : 0,
            feeBps: 0,
            priceDecimals: terms.priceDecimals,
            admin: address,
          },
          address,
        ],
      });
      setState({ kind: "sending", phase: "confirming", hash });
      await waitForTransactionReceipt(config, { hash });
      setState({ kind: "ok", hash });
      setStrike("");
    } catch (e) {
      const message = e instanceof Error ? e.message : "Listing failed.";
      setState(/user rejected|denied/i.test(message) ? { kind: "cancelled", message: "Rejected in the wallet." } : { kind: "error", message });
    }
  };

  if (loading) return <Panel title="List a market"><p className="text-muted text-sm">Reading the registry…</p></Panel>;
  if (!factory) {
    return <EmptyState title="No registry here" body="Nothing is deployed on this network to list against." />;
  }



  return (
    <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_20rem]">
      <Panel title="List a market" subtitle="Choose the stock, the strike and the expiry">
        <label className="block">
          <span className="text-dim text-[0.8125rem] tracking-[0.08em] uppercase">Stock</span>
          <select
            value={token}
            onChange={(e) => setToken(e.target.value as Address)}
            className="border-line bg-panel focus:border-accent mt-1.5 w-full rounded-sm border px-3 py-2 text-[0.9rem] outline-none transition-colors"
          >
            <option value="">Choose a stock…</option>
            {assets.map((a) => (
              <option key={a.token} value={a.token}>
                {a.symbol} · {a.name}
              </option>
            ))}
          </select>
        </label>

        <div className="mt-4 grid gap-3 sm:grid-cols-2">
          <AmountInput label="Strike price (USD)" value={strike} onChange={setStrike} placeholder="0.00" />
          <AmountInput label="Days until expiry" value={days} onChange={setDays} placeholder="30" />
        </div>

        <div className="mt-5">
          <Button
            busy={state.kind === "sending"}
            disabled={!isConnected || problem !== null}
            disabledReason={!isConnected ? "Connect a wallet to list." : (problem ?? undefined)}
            onClick={create}
          >
            List market
          </Button>
          {problem && isConnected && <p className="text-dim mt-2 text-[0.82rem]">{problem}</p>}
        </div>

        <TxStatus state={state} />

        <p className="text-dim mt-4 text-[0.78rem] leading-5">
          The strike is quoted in the registry&rsquo;s units, not the price feed&rsquo;s. Anyone can
          open a market directly against the vault; listing here is what makes it canonical and
          visible in this app.
        </p>
      </Panel>

      <div className="grid content-start gap-6">
        <Panel title="Registry rules">
          {bounds ? (
            <dl className="grid gap-2 text-[0.875rem]">
              <Row label="Expiry" value={`${Number(bounds.minHorizon) / 86_400}–${Math.floor(Number(bounds.maxHorizon) / 86_400)} days`} />
              <Row label="Settlement delay" value={`${bounds.minSettlementDelay}s`} />
              <Row label="Price window" value={`${bounds.minPriceLag}s`} />
              <Row label="Confidence ceiling" value={`${bounds.maxConfBps} bp`} />
              <Row label="Strike decimals" value={String(bounds.priceDecimals)} />
              <Row label="New listings" value={creationPaused ? "Paused" : "Open"} />
            </dl>
          ) : (
            <p className="text-muted text-sm">Unavailable.</p>
          )}
        </Panel>

        {isAdmin && <AdminPanel />}
      </div>
    </div>
  );
}

/**
 * The registry's own controls, shown only to whoever holds it.
 *
 * The registry decides what may become canonical. It has no power over a market
 * once created — it cannot settle one, pause one, or touch its collateral.
 */
function AdminPanel() {
  const { creationPaused } = useFactory();
  return (
    <Panel title="Registry controls" subtitle="You hold this registry">
      <p className="text-muted text-[0.875rem] leading-6">
        New listings are {creationPaused ? "paused" : "open"}. Activating one complete stock,
        oracle, feed, model and fallback configuration permits only that exact combination. It
        does not list anything by itself or grant power over a market once created.
      </p>
      <p className="text-dim mt-3 text-[0.78rem] leading-5">
        Configurations are activated from the deployment scripts today. Wiring them into this panel is
        tracked in todo.md.
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
