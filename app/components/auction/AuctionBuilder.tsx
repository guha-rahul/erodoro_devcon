"use client";

import { useMemo, useState } from "react";
import { useAccount } from "wagmi";
import type { StockRow } from "@/lib/use-stock-balances";
import { useSeriesBalances } from "@/lib/use-balances";
import { useActions } from "@/lib/use-actions";
import { intentAvailable, useIntent } from "@/lib/use-intent";
import { useReferencePrices } from "@/lib/use-market-rows";
import { isMatured } from "@/lib/market-status";
import { useNow } from "@/lib/use-now";
import { DEPLOYMENT } from "@/lib/deployment";
import { assetFor, type IssuerAsset } from "@/lib/issuers";
import { formatDate, fromRaw, toRaw } from "@/lib/format";
import { nId, type Hex, type Series } from "@/lib/types";
import { AmountInput, Button, TxStatus } from "../ui";
import { AssetSelector } from "./AssetSelector";
import { ExpirySelector } from "./Selectors";

/**
 * Screen 1 — Sell Your Upside.
 *
 * Ribbon-simple setup over the real protocol: pick a stock, a listed
 * cap/expiry, a quantity and a floor, then START AUCTION splits (if needed),
 * signs the intent (no gas) and registers the auction. Language is auction
 * throughout — never order, limit, or ask.
 */
export function AuctionBuilder({
  rows,
  series,
  onListed,
}: {
  rows: StockRow[];
  series: Series[];
  onListed: (seriesId: bigint, intentHash: Hex) => void;
}) {
  const { address, isConnected } = useAccount();
  const now = useNow();
  const quote = DEPLOYMENT.quote;
  const active = useMemo(() => series.filter((s) => !isMatured(s, now)), [series, now]);
  const references = useReferencePrices(active);
  const { state: splitState, approveAndSplit } = useActions();
  const { state: intentState, signAndList } = useIntent();

  const [token, setToken] = useState<string>("");
  const [expiryDays, setExpiryDays] = useState(30);
  const [cap, setCap] = useState("");
  const [qty, setQty] = useState("");
  const [floor, setFloor] = useState("");
  const [busy, setBusy] = useState(false);
  const [stage, setStage] = useState<"split" | "intent">("split");
  const [error, setError] = useState<string | null>(null);

  // Picker options come from live listed series — not a static registry. An
  // asset with no listed market cannot be auctioned, so showing it would be a
  // dead end. Registry metadata is display-only; the factory is the authority.
  const options = useMemo(() => {
    const byToken = new Map<string, { decimals: number }>();
    for (const s of active) {
      const key = s.config.collateral.toLowerCase();
      if (!byToken.has(key)) byToken.set(key, { decimals: s.config.collateralDecimals });
    }
    // Plus anything the wallet actually holds: it should show up with its
    // balance even before a market exists for it.
    for (const r of rows) {
      const key = r.token.toLowerCase();
      if (r.balance > 0n && !byToken.has(key)) byToken.set(key, { decimals: r.decimals });
    }
    return [...byToken].map(([key, { decimals }]) => {
      const known = rows.find((r) => r.token.toLowerCase() === key);
      const meta: IssuerAsset = known ?? assetFor(key) ?? {
        token: key as IssuerAsset["token"],
        chainlinkFeed: null,
        symbol: `${key.slice(0, 6)}…${key.slice(-4)}`,
        name: "Unverified asset — check the token contract",
        issuer: "Unknown",
        decimals,
      };
      return { ...meta, balance: known?.balance ?? 0n, multiplier: known?.multiplier ?? null };
    });
  }, [active, rows]);

  const asset = token ? (options.find((o) => o.token.toLowerCase() === token.toLowerCase()) ?? null) : null;
  const stock = asset;
  const pool = useMemo(
    () => active.filter((s) => token && s.config.collateral.toLowerCase() === token.toLowerCase()),
    [active, token],
  );
  const liveSpot = useMemo(() => {
    const first = pool[0];
    return first ? references.spotFor(first) : null;
  }, [pool, references]);
  // Use a clearly labeled simulated reference derived from a listed strike
  // when the test feed is unavailable. Production assets
  // never take this path — no feed means no price, full stop.
  const demoStrike = pool[0]
    ? Number(pool[0].config.strike) / 10 ** pool[0].config.priceDecimals
    : null;
  const spot = liveSpot ?? (asset?.isTestAsset && demoStrike !== null ? demoStrike / 1.1 : null);
  const spotIsSimulated = liveSpot === null && spot !== null;

  // Nearest listed market to the chosen cap/expiry. The protocol only trades
  // listed series, so the builder matches rather than invents.
  const match = useMemo(() => {
    if (pool.length === 0 || !cap || Number(cap) <= 0) return null;
    const target = Number(cap);
    const window = expiryDays * 86_400;
    const scored = pool.map((s) => {
      const strikeUsd = Number(s.config.strike) / 10 ** s.config.priceDecimals;
      const dStrike = Math.abs(strikeUsd - target) / target;
      const dTime = Math.abs(Number(s.config.maturity) - (Number(now) + window)) / window;
      return { s, score: dStrike * 2 + dTime };
    });
    scored.sort((a, b) => a.score - b.score);
    return scored[0].score < 0.08 ? scored[0].s : null;
  }, [pool, cap, expiryDays, now]);

  const matchStrikeUsd = match ? Number(match.config.strike) / 10 ** match.config.priceDecimals : null;
  const bal = useSeriesBalances(match?.id ?? null, match?.config.collateral);

  const dp = match?.config.collateralDecimals ?? asset?.decimals ?? 8;
  const validQty = isDecimal(qty, dp);
  const validFloor = isDecimal(floor, quote?.decimals ?? 6);
  const qtyRaw = validQty ? toRaw(qty, dp) : 0n;
  const floorPerShareRaw = validFloor && quote ? toRaw(floor, quote.decimals) : 0n;
  const unit = 10n ** BigInt(dp);
  const floorRaw = floorPerShareRaw > 0n && qtyRaw > 0n
    ? (floorPerShareRaw * qtyRaw + unit - 1n) / unit
    : 0n;

  // This screen starts from stock the seller currently owns. Existing P/N
  // claims are portfolio positions and must not inflate the displayed stock
  // balance or the quantity slider.
  const maxQtyRaw = match ? bal.collateral : (stock?.balance ?? 0n);
  const maxQty = Number(maxQtyRaw) / 10 ** dp;
  const shortage = qtyRaw > maxQtyRaw;
  const selectListedTerms = (listed: Series) => {
    setCap((Number(listed.config.strike) / 10 ** listed.config.priceDecimals).toFixed(2));
    const days = Number(listed.config.maturity - now) / 86_400;
    setExpiryDays([7, 30, 60, 90].sort((a, b) => Math.abs(a - days) - Math.abs(b - days))[0]);
  };
  const disabledReason = !isConnected ? "Connect your wallet to start an auction."
    : !quote ? "Premium payments are not configured on this network."
    : !intentAvailable() ? "Auctions are not configured on this network."
    : !token ? "Choose a stock to begin."
    : !validQty || qtyRaw <= 0n ? "Enter a quantity greater than zero."
    : shortage ? "Lower the quantity to your wallet balance."
    : !match ? "Choose an available cap and expiry."
    : !validFloor || floorRaw <= 0n ? "Enter your minimum premium."
    : null;
  const canStart = disabledReason === null && !busy;
  const transactionState = stage === "split" ? splitState : intentState;

  const start = async () => {
    if (!canStart || !match || !address || !quote) return;
    setBusy(true);
    setError(null);
    try {
      // Split first when the wallet holds stock but not enough upside claims.
      if (qtyRaw > bal.n) {
        setStage("split");
        const need = qtyRaw - bal.n;
        const hash = await approveAndSplit(match.id, match.config.collateral, need);
        if (!hash) throw new Error("Split cancelled or failed. No auction was started.");
        await bal.refetch();
      }
      setStage("intent");
      const listed = await signAndList({
        series: match,
        amount: qtyRaw,
        floor: floorRaw,
        validHours: 24,
        allowPartial: false,
        allowRollover: true,
      });
      if (!listed) throw new Error("Signing cancelled or refused. No auction was started.");
      onListed(match.id, listed.hash);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not start the auction.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="grid items-start gap-6 lg:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]">
      <div className="border-line bg-panel rounded-md border p-4 sm:p-6">
        <fieldset disabled={busy} className="min-w-0 space-y-7 disabled:opacity-70">
          <section>
            <StepLabel n="1" label="Choose your stock" />
            <div className="mt-4">
              <AssetSelector
                assets={options}
                value={token}
                onChange={(t) => {
                  setToken(t);
                  setQty("");
                  setError(null);
                  const targetMaturity = Number(now) + expiryDays * 86_400;
                  const listed = active
                    .filter((candidate) => candidate.config.collateral.toLowerCase() === t.toLowerCase())
                    .sort(
                      (a, b) =>
                        Math.abs(Number(a.config.maturity) - targetMaturity)
                        - Math.abs(Number(b.config.maturity) - targetMaturity),
                    )[0];
                  if (listed) {
                    selectListedTerms(listed);
                  } else {
                    setCap("");
                  }
                }}
              />
            </div>
            {stock && (
              <p className="text-dim mt-2 text-xs">
                {spot !== null
                  ? spotIsSimulated
                    ? `Test reference $${spot.toFixed(2)} (simulated)`
                    : `Current reference $${spot.toFixed(2)}`
                  : "Price unavailable"}
              </p>
            )}
            <fieldset disabled={!token} className="mt-5 min-w-0">
              <AmountInput label="Quantity" value={qty} onChange={setQty} placeholder="0" suffix={asset?.symbol}
                note={`Balance ${fromRaw(maxQtyRaw, dp, 4)}`}
                onMax={() => setQty(fromRaw(maxQtyRaw, dp, dp))} invalid={shortage || Boolean(qty && !validQty)} />
              <input type="range" aria-label="Stock quantity" min={0} max={maxQty} step={maxQty > 0 ? maxQty / 200 : 1}
                value={Math.min(validQty ? Number(qty) : 0, maxQty)} disabled={maxQty <= 0}
                onChange={(event) => setQty(Number(event.target.value).toFixed(Math.min(dp, 4)))}
                className="mt-3 w-full disabled:opacity-40" />
            </fieldset>
            {shortage && <p role="alert" className="text-danger mt-1.5 text-sm">Amount exceeds your balance.</p>}
            {qty && !validQty && <p role="alert" className="text-danger mt-1.5 text-sm">Enter a valid quantity with up to {dp} decimal places.</p>}
          </section>

          <section className="border-line-soft border-t pt-6">
            <StepLabel n="2" label="Set your terms" />
            <fieldset disabled={!token} className="mt-4 min-w-0 space-y-5">
              <div>
                <AmountInput label="Sell upside above" value={cap} onChange={setCap} suffix="USD" placeholder="340.00" />
                <p className="text-dim mt-2 text-xs">You keep the value up to this cap. The buyer gets the gains above it.</p>
              </div>
              <div>
                <p className="text-dim mb-2 text-xs">Expiry</p>
                <ExpirySelector value={expiryDays} onChange={setExpiryDays} />
                {match && <p className="text-muted mt-2 text-xs">Available terms: ${matchStrikeUsd?.toFixed(2)} cap · {formatDate(match.config.maturity)}</p>}
                {token && !match && (
                  <div className="mt-3 text-sm" role="status">
                    <p className="text-muted">{pool.length ? "This combination is not available. Try these terms:" : "No active auction terms for this stock yet."}</p>
                    <div className="mt-2 flex flex-wrap gap-2">
                      {pool.slice(0, 3).map((listed) => (
                        <button type="button" key={listed.id.toString()} onClick={() => selectListedTerms(listed)}
                          className="border-line hover:border-accent rounded-sm border px-3 py-2 text-left text-xs">
                          ${(Number(listed.config.strike) / 10 ** listed.config.priceDecimals).toFixed(2)} · {formatDate(listed.config.maturity)}
                        </button>
                      ))}
                    </div>
                  </div>
                )}
              </div>
              <div>
                <AmountInput label="Minimum premium per share" value={floor} onChange={setFloor} suffix={quote?.symbol} placeholder="10.00"
                  invalid={Boolean(floor && !validFloor)} />
                <p className="text-dim mt-2 text-xs">Your upside cannot sell below this minimum.</p>
                <p className="text-dim mt-1 text-xs">Each auction round lasts 10 minutes. If no valid bid wins, a new round starts automatically.</p>
                {floor && !validFloor && <p role="alert" className="text-danger mt-2 text-xs">Enter a valid premium with up to {quote?.decimals ?? 6} decimal places.</p>}
              </div>
            </fieldset>
          </section>
        </fieldset>
      </div>

      <aside className="border-line bg-panel rounded-md border p-4 sm:p-6">
        <StepLabel n="3" label="Review your auction" />
        <p className="text-muted mt-4 text-sm leading-6">
          {match && qtyRaw > 0n
            ? `Sell the upside on ${fromRaw(qtyRaw, dp, 4)} ${asset?.symbol ?? "stock"} above $${matchStrikeUsd?.toFixed(2)}.`
            : "Choose your stock and terms to preview your auction."}
        </p>
        <dl className="mt-5 space-y-3 text-sm">
          <ReviewRow label="Stock" value={asset?.symbol ?? "—"} />
          <ReviewRow label="Quantity" value={qtyRaw > 0n ? fromRaw(qtyRaw, dp, 4) : "—"} />
          <ReviewRow label="Cap" value={matchStrikeUsd !== null ? `$${matchStrikeUsd.toFixed(2)}` : "—"} />
          <ReviewRow label="Expiry" value={match ? formatDate(match.config.maturity) : "—"} />
          <ReviewRow label="Auction" value="10 min · auto-rollover" />
        </dl>
        <div className="border-line-soft mt-5 border-t pt-5">
          <p className="text-muted text-xs">Minimum premium you receive</p>
          <p className="mt-2 font-mono text-2xl tabular-nums" aria-live="polite">
            {floorRaw > 0n ? fromRaw(floorRaw, quote?.decimals ?? 6, 2) : "—"} <span className="text-muted text-sm">{quote?.symbol}</span>
          </p>
          <p className="text-dim mt-2 text-xs">Paid when a buyer purchases your upside.</p>
        </div>
        <div className="mt-6">
            <Button
              tone="primary"
              size="lg"
              full
              busy={busy}
              disabled={!canStart}
              disabledReason={disabledReason ?? undefined}
              onClick={start}
            >
              {busy ? stage === "split" ? "Preparing your position…" : "Opening your auction…" : "Start auction"}
            </Button>
            {!busy && disabledReason && <p className="text-dim mt-2 text-xs">{disabledReason}</p>}
            {busy && <p role="status" className="text-muted mt-3 text-sm">{stage === "split" ? "Approve the stock and confirm the split in your wallet." : "Approve the upside claim if needed, then sign to list your auction."}</p>}
            {error && <p role="alert" className="text-danger mt-3 text-sm">{error}</p>}
            <TxStatus state={transactionState} />
        </div>
        <p className="text-dim mt-4 text-xs leading-5">You keep the capped position and the stock’s downside risk until expiry.</p>
      </aside>
    </div>
  );
}

function StepLabel({ n, label }: { n: string; label: string }) {
  return (
    <h2 className="flex items-center gap-3 text-base font-medium">
      <span className="bg-accent/10 text-accent-ink grid size-7 shrink-0 place-items-center rounded-full font-mono text-xs">{n}</span>
      {label}
    </h2>
  );
}

function ReviewRow({ label, value }: { label: string; value: string }) {
  return <div className="flex items-start justify-between gap-4"><dt className="text-dim shrink-0">{label}</dt><dd className="text-right font-mono tabular-nums">{value}</dd></div>;
}

function isDecimal(value: string, decimals: number): boolean {
  return /^(?:\d+\.?\d*|\.\d+)$/.test(value) && (value.split(".")[1]?.length ?? 0) <= decimals;
}

// Re-exported for the detail page handoff.
export type { Hex };
export { nId };
