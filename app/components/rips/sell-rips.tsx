"use client";

import Link from "next/link";
import { useMemo, useState, useSyncExternalStore } from "react";
import { formatUnits, parseUnits } from "viem";
import { AppChrome } from "../app-chrome";
import { ConnectButton } from "../connect-button";
import { txExplorer } from "@/lib/deployment";
import { useDeployment } from "@/lib/use-app-network";
import { shortDate, usd } from "@/lib/rips/model";
import { useSeller, type SellMarket, type SellerListing } from "@/lib/rips/use-seller";
import { toShareEquivalent } from "@/lib/use-b20";
import { useNow } from "@/lib/use-now";
import { TickerMark } from "./bits";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Combobox } from "@base-ui/react/combobox";
import { ChevronDown } from "lucide-react";

/** Raw N units sold per $1 at a seller's price per whole claim. */
function unitsForPrice(price: number, decimals: number) {
  if (!(price > 0)) return 0n;
  return BigInt(Math.floor(10 ** decimals / price));
}
/** The pool's MIN_LISTING_DOLLARS: a listing holds at least this much N at the house quote. */
const MIN_LISTING_DOLLARS = 5n;
const priceOf = (unitsPerRip: bigint, decimals: number) => unitsPerRip > 0n ? 10 ** decimals / Number(unitsPerRip) : 0;
const claims = (raw: bigint, decimals: number) => Number(formatUnits(raw, decimals)).toLocaleString("en-US", { maximumFractionDigits: 4 });
/** Token units; adds shares only once a dividend or split makes the two read differently. */
const tokens = (raw: bigint, m: SellMarket) => {
  const amount = claims(raw, m.decimals);
  const shares = m.multiplier ? claims(toShareEquivalent(raw, m.multiplier), m.decimals) : amount;
  return `${amount} ${m.tokenSymbol}${shares !== amount ? ` (${shares} shares)` : ""}`;
};

type Result = { ok: boolean; message: string } | null;

/** The stock a swap linked here with. Read outside render-time state, so it
 *  hydrates as empty and settles on the real URL, not the previous page's. */
const swapStock = () => new URLSearchParams(window.location.search).get("stock")?.toLowerCase() ?? "";
const subscribeUrl = (onChange: () => void) => {
  window.addEventListener("popstate", onChange);
  return () => window.removeEventListener("popstate", onChange);
};

export function SellRips() {
  const seller = useSeller();
  const { deployment, isTestnet } = useDeployment();
  const now = useNow();
  const { address, markets: allMarkets, listings, usdcBalance, state, phase, transaction } = seller;
  // A market past its expiry cannot take new listings.
  const markets = useMemo(() => allMarkets.filter(m => now === 0n || m.expiryTs > now), [allMarkets, now]);
  const [templateId, setTemplateId] = useState<string>("");
  const [amount, setAmount] = useState("1");
  const [price, setPrice] = useState("10");
  const [result, setResult] = useState<Result>(null);
  const [repricing, setRepricing] = useState<Record<string, string>>({});
  const busy = phase !== null;

  // Arriving from a swap (?stock=0x…) opens that stock's market until another is picked.
  const fromSwap = useSyncExternalStore(subscribeUrl, swapStock, () => "") || undefined;
  const market = markets.find(m => m.templateId.toString() === templateId)
    ?? (templateId ? undefined : markets.find(m => m.stock.toLowerCase() === fromSwap)) ?? markets[0];
  let collateral = 0n;
  try { collateral = market ? parseUnits(amount || "0", market.decimals) : 0n; } catch { collateral = 0n; }
  const unitsPerRip = market ? unitsForPrice(Number(price), market.decimals) : 0n;
  const fullSale = unitsPerRip > 0n ? Number(collateral / unitsPerRip) : 0;
  const minCollateral = market ? market.houseUnitsPerRip * MIN_LISTING_DOLLARS : 0n;
  const belowHouse = !!market && market.houseUnitsPerRip > 0n && unitsPerRip < market.houseUnitsPerRip;
  const listWhy = !market ? "No market is open for listing."
    : collateral <= 0n ? "Enter how much stock to lock."
    : collateral > market.stockBalance ? `You hold ${tokens(market.stockBalance, market)}.`
    : unitsPerRip <= 0n ? "Enter a price above zero."
    : collateral < unitsPerRip ? "Lock enough stock for at least one $1 sale at this price."
    : collateral < minCollateral ? `Lock at least ${tokens(minCollateral, market)} ($${MIN_LISTING_DOLLARS} at the house price).`
    : null;

  // Stable across the clock's per-second re-render, or the open search list resets.
  const marketItems = useMemo(() => markets.map(m => ({
    value: m.templateId.toString(),
    label: `${m.symbol} · above ${usd(m.strike)}`,
    search: `${m.symbol} ${m.tokenSymbol} ${m.name}`.toLowerCase(),
  })), [markets]);
  const field = "border-line bg-panel h-10 rounded-sm px-3 text-sm tabular-nums shadow-none md:text-sm";
  const pill = "border-line h-auto rounded-full bg-transparent px-3 py-1.5 shadow-none hover:bg-transparent hover:border-text";

  const act = async (work: Promise<{ ok: boolean; message: string }>) => setResult(await work);
  // A listing withdrawn before anything sold has nothing left to show, unless
  // it is the only place this stock's claims in the wallet can be unlocked.
  const live = (l: SellerListing) => l.remaining > 0n || l.buyers > 0n;
  const shown = listings.filter(l => live(l) || ((l.pHeld > 0n || l.nHeld > 0n) && !listings.some(o => o.seriesId === l.seriesId && live(o))));
  const holder = new Map<string, bigint>();
  for (const l of shown) if (!holder.has(l.seriesId.toString())) holder.set(l.seriesId.toString(), l.id);

  return (
    <>
      <AppChrome active="/rips/sell" />
      <main className="mx-auto w-full max-w-3xl flex-1 px-4 pt-8 pb-16">
        <div className="flex items-start justify-between gap-4">
          <div>
            <h1 className="font-display text-4xl font-semibold tracking-[-0.05em]">Deposit stock</h1>
            <p className="text-muted mt-2 max-w-md text-sm leading-6">
              Lock stock and keep its downside claim (P). Buyers pay you {deployment.quote?.symbol} directly for each upside claim (N) they take.
            </p>
          </div>
          {address && usdcBalance !== null && <p className="text-muted text-sm tabular-nums">{usd(Number(formatUnits(usdcBalance, 6)), 2)} {deployment.quote?.symbol}</p>}
        </div>

        {!address ? (
          <div className="mt-8"><ConnectButton /></div>
        ) : state === "loading" ? (
          <p role="status" className="mt-8">Reading the pool…</p>
        ) : state === "unsupported" ? (
          <p className="text-muted mt-8 text-sm">This pool does not accept seller listings. It needs the upgraded Rips pool.</p>
        ) : (
          <>
            {state === "error" && <p role="alert" className="border-danger mt-6 border p-3 text-sm">Could not refresh the pool. Showing the last successful read. <Button variant="link" className="text-text inline h-auto p-0 align-baseline font-normal underline underline-offset-auto" onClick={() => void seller.refresh()}>Retry</Button></p>}

            <section className="border-line/70 bg-panel mt-8 rounded-3xl border p-5" aria-labelledby="list-title">
              <div className="flex items-baseline justify-between gap-3">
                <h2 id="list-title" className="font-display text-xl font-semibold">List upside</h2>
                {market && <span className="text-dim text-xs">Expires {shortDate(market.expiryTs)}</span>}
              </div>
              {markets.length === 0 ? <p className="text-muted mt-3 text-sm">No market is open for listing right now.</p> : (
                <div className="mt-4 grid min-w-0 gap-4">
                  <div className="grid min-w-0 gap-2">
                    <Label id="market-label">Market</Label>
                    <Combobox.Root
                      items={marketItems}
                      value={marketItems.find(item => item.value === market?.templateId.toString()) ?? null}
                      onValueChange={item => { if (item) { setTemplateId(item.value); setResult(null); } }}
                      itemToStringLabel={item => item.label}
                      isItemEqualToValue={(a, b) => a.value === b.value}
                      filter={(item, query) => { const q = query.trim().toLowerCase(); return !q || item.search.includes(q) || item.label.toLowerCase().includes(q); }}
                      disabled={busy}
                    >
                      <div className="relative">
                        <Combobox.Input aria-labelledby="market-label" placeholder="Search stocks" className={`${field} border w-full pr-9`} />
                        <Combobox.Trigger aria-label="Show stocks" className="text-muted absolute inset-y-0 right-0 flex w-9 items-center justify-center"><ChevronDown aria-hidden className="size-4" /></Combobox.Trigger>
                      </div>
                      <Combobox.Portal>
                        <Combobox.Positioner sideOffset={4} className="isolate z-50">
                          <Combobox.Popup className="bg-popover text-popover-foreground ring-foreground/10 max-h-[min(20rem,var(--available-height))] w-(--anchor-width) overflow-y-auto rounded-sm p-1 shadow-md ring-1">
                            <Combobox.Empty className="text-muted px-2 py-1.5 text-sm empty:hidden">No stock matches.</Combobox.Empty>
                            <Combobox.List>
                              {(item: (typeof marketItems)[number]) => <Combobox.Item key={item.value} value={item} className="data-highlighted:bg-panel-2 flex cursor-default items-center rounded-sm px-2 py-1.5 text-sm outline-hidden select-none">{item.label}</Combobox.Item>}
                            </Combobox.List>
                          </Combobox.Popup>
                        </Combobox.Positioner>
                      </Combobox.Portal>
                    </Combobox.Root>
                  </div>
                  <div className="grid grid-cols-2 gap-3 [&>*]:min-w-0">
                    <div className="grid gap-2">
                      <Label htmlFor="lock-amount">Amount ({market?.tokenSymbol ?? market?.symbol})</Label>
                      <Input id="lock-amount" inputMode="decimal" value={amount} onChange={e => { setAmount(e.target.value); setResult(null); }} disabled={busy} className={field} />
                    </div>
                    <div className="grid gap-2">
                      <Label htmlFor="claim-price">Price per claim ($)</Label>
                      <Input id="claim-price" inputMode="decimal" value={price} onChange={e => { setPrice(e.target.value); setResult(null); }} disabled={busy} className={field} />
                    </div>
                  </div>
                  {market && !listWhy && <p className="text-muted text-sm">
                    Buyers get {claims(unitsPerRip, market.decimals)} claims per $1. If everything sells you receive about {usd(fullSale)}.
                    {market.houseUnitsPerRip > 0n && ` House price: ${usd(priceOf(market.houseUnitsPerRip, market.decimals))} per claim.`}
                    {belowHouse && " Packs only draw listings priced at or under the house price, so yours sells only to buyers who pick it."}
                  </p>}
                  <Button variant="rip" className="h-14 w-full text-lg" disabled={!!listWhy || busy}
                    onClick={() => market && void act(seller.list(market, collateral, unitsPerRip))}>
                    {busy ? "Working…" : "Lock & list"}
                  </Button>
                  {listWhy && <p className="text-dim text-center text-xs">{listWhy}</p>}
                  {isTestnet && market && (
                    <Button variant="outline" className="border-line h-10 w-full shadow-none" disabled={busy}
                      onClick={() => void act(seller.getTestStock(market, 10))}>
                      Get 10 test {market.symbol} (testnet, no value)
                    </Button>
                  )}
                </div>
              )}
            </section>

            {result && <p role={result.ok ? "status" : "alert"} className={`mt-4 text-center text-sm ${result.ok ? "text-p" : "text-danger"}`}>{result.message}</p>}
            {transaction && <a className="mt-2 block text-center text-sm underline" href={txExplorer(transaction)} target="_blank" rel="noreferrer">View last transaction</a>}

            <section className="mt-10" aria-labelledby="listings-title">
              <h2 id="listings-title" className="font-display text-2xl font-semibold tracking-[-0.04em]">Your listings</h2>
              {shown.length === 0 ? <p className="text-muted border-line mt-4 rounded-2xl border border-dashed p-6 text-center text-sm">Nothing listed yet.</p> : (
                <ul className="mt-4 grid gap-3">
                  {shown.map(l => {
                    const key = l.id.toString();
                    const expired = l.settled || (now > 0 && l.expiryTs <= now);
                    // P and N are the wallet's, per stock: its first listing carries them.
                    const holds = holder.get(l.seriesId.toString()) === l.id;
                    const unlockable = !holds ? 0n : l.pHeld < l.nHeld ? l.pHeld : l.nHeld;
                    const newUnits = unitsForPrice(Number(repricing[key] ?? ""), l.decimals);
                    return (
                      <li key={key} className="rip-card p-5">
                        <div className="flex items-center justify-between gap-3">
                          <div className="flex items-center gap-3">
                            <TickerMark symbol={l.symbol} size={36} />
                            <div>
                              <p className="font-display text-xl font-semibold">{l.symbol} <span className="text-p">↑</span></p>
                              <p className="text-dim text-xs">above {usd(l.strike)} · {expired ? "Expired" : `expires ${shortDate(l.expiryTs)}`}</p>
                            </div>
                          </div>
                          <div className="text-right">
                            <p className="font-display text-2xl font-semibold tabular-nums">{usd(Number(formatUnits(l.earnedRaw, 6)), 2)}</p>
                            <p className="text-dim text-xs">earned · {l.buyers.toString()} {l.buyers === 1n ? "buyer" : "buyers"}</p>
                          </div>
                        </div>
                        <dl className="mt-4 grid grid-cols-3 gap-2 text-sm">
                          <div><dt className="text-dim text-xs">Price</dt><dd className="tabular-nums">{usd(priceOf(l.unitsPerRip, l.decimals), 2)} / claim</dd></div>
                          <div><dt className="text-dim text-xs">Left for sale</dt><dd className="tabular-nums">{claims(l.remaining, l.decimals)} of {claims(l.total, l.decimals)}</dd></div>
                          {holds && <div><dt className="text-dim text-xs">You hold</dt><dd className="tabular-nums">{claims(l.pHeld, l.decimals)} P · {claims(l.nHeld, l.decimals)} N</dd></div>}
                        </dl>
                        <div className="mt-4 flex flex-wrap items-center gap-2 text-sm">
                          {!expired && l.remaining > 0n && <>
                            <Input aria-label={`New price for ${l.symbol}`} inputMode="decimal" placeholder="New $ / claim" value={repricing[key] ?? ""} disabled={busy}
                              onChange={e => setRepricing(r => ({ ...r, [key]: e.target.value }))}
                              className={`${field} h-8 w-32 px-2`} />
                            <Button variant="outline" className={pill} disabled={busy || newUnits <= 0n || newUnits === l.unitsPerRip}
                              onClick={() => void act(seller.reprice(l, newUnits)).then(() => setRepricing(r => ({ ...r, [key]: "" })))}>Change price</Button>
                            <Button variant="outline" className={pill} disabled={busy}
                              onClick={() => void act(seller.withdraw(l))}>Withdraw unsold</Button>
                          </>}
                          {expired && l.remaining > 0n && <Button variant="outline" className={pill} disabled={busy}
                            onClick={() => void act(seller.reclaim(l))}>Reclaim unsold</Button>}
                          {!expired && unlockable > 0n && <Button variant="outline" className={pill} disabled={busy}
                            onClick={() => void act(seller.unlock(l, unlockable))}>Unlock {claims(unlockable, l.decimals)} {l.symbol}</Button>}
                          {holds && l.settled && (l.pHeld > 0n || l.nHeld > 0n) && <Button variant="outline" className={pill} disabled={busy}
                            onClick={() => void act(seller.redeem(l))}>Redeem for {l.symbol}</Button>}
                          {holds && expired && !l.settled && (l.pHeld > 0n || l.nHeld > 0n) && <p className="text-dim text-xs">Waiting for the price at expiry to settle. Then redeem your claims here for {l.symbol}.</p>}
                        </div>
                      </li>
                    );
                  })}
                </ul>
              )}
            </section>
          </>
        )}
      </main>
      <footer className="text-dim mx-auto max-w-3xl px-4 pb-8 text-center text-xs leading-5">
        Locked stock backs the claims you sell. If the price ends above the strike, buyers receive that upside from your collateral; P pays you the rest. <Link href="/#risk" className="underline">Risks</Link>
      </footer>
    </>
  );
}
