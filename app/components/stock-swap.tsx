"use client";

import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { useQuery } from "@tanstack/react-query";
import { useAccount, usePublicClient } from "wagmi";
import { erc20Abi, formatUnits, isAddress, parseAbi, type Address, type Hash, type PublicClient } from "viem";
import { AppChrome } from "./app-chrome";
import { ConnectButton } from "./connect-button";
import { ArrowDownUp, ArrowUpRight, ChevronDown, Loader2, RefreshCw, Search, ShieldCheck } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { RIPS_STOCKS } from "@/lib/rips/base-stocks";
import { SWAP_API } from "@/lib/swap-api";
import { USDC, SWAP_CHAIN, parseSwapAmount, SLIPPAGE_BPS, executeZeroExSwap } from "@/lib/zeroex-swap";
import { fetchAerodromeQuote, type AerodromeQuote } from "@/lib/aerodrome-swap";
import { BASE_STOCKS } from "@/lib/rips/base-stocks";
import { stockPrice } from "@/lib/rips/prices";
import type { Catalog } from "@/lib/stock-swap";
import { TEST_SWAP_CHAIN, TEST_USDC, TEST_USDC_GRANT, executeTestSwap, mintTestUsdc, testCatalog, testQuote, type TestQuote } from "@/lib/test-swap";
import { useAppNetwork } from "@/lib/use-app-network";
import { b20RevertMessage } from "@/lib/b20-errors";
import Link from "next/link";

const subscribeNever = () => () => {};
const FEED_ABI = parseAbi(["function latestRoundData() view returns (uint80, int256, uint256, uint256, uint80)", "function decimals() view returns (uint8)"]);

/** The stock's Coinbase Chainlink price on Base mainnet, whatever chain the rest of the app uses; null without a feed. */
async function chainlinkPrice(client: PublicClient, token: Address): Promise<{ price: number } | null> {
  const feed = BASE_STOCKS.find(s => s.address.toLowerCase() === token.toLowerCase())?.chainlink;
  if (!feed) return null;
  const [[, answer], decimals] = await Promise.all([
    client.readContract({ address: feed, abi: FEED_ABI, functionName: "latestRoundData" }),
    client.readContract({ address: feed, abi: FEED_ABI, functionName: "decimals" }),
  ]);
  return answer > 0n ? { price: Number(answer) / 10 ** decimals } : null;
}
const QUOTE_TIMEOUT_MS = 20_000;
function withTimeout<T>(work: Promise<T>, ms: number, reason: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(reason)), ms); });
  return Promise.race([work, timeout]).finally(() => clearTimeout(timer));
}
/** Largest percentage a fill may be worse than the stock's Chainlink price. */
const MAX_DEVIATION = 5;
const nowMs = () => Date.now();

const message = (e: unknown) => b20RevertMessage(e) ?? (e instanceof Error ? e.message.split("\n")[0] : "Request failed. Try again.");

async function getCatalog(): Promise<Catalog> {
  const response = await fetch(`${SWAP_API}/stocks`, { cache: "no-store" });
  if (!response.ok) throw new Error("Issuer catalog unavailable. Refresh to try again.");
  const data = await response.json() as Catalog;
  if (data.chainId !== SWAP_CHAIN || !Array.isArray(data.tokens) || !data.tokens.length || !Number.isFinite(data.expiresAt) || data.expiresAt <= Date.now()
    || data.tokens.some(t => t.chainId !== SWAP_CHAIN || !isAddress(t.address) || typeof t.symbol !== "string" || !/^https:\/\//.test(t.disclosures))) throw new Error("Invalid or expired stock catalog");
  return data;
}

async function readStock(client: PublicClient, token: Catalog["tokens"][number]) {
  const [name, symbol, decimals] = await client.multicall({ allowFailure: false, contracts: [
    { address: token.address, abi: erc20Abi, functionName: "name" },
    { address: token.address, abi: erc20Abi, functionName: "symbol" },
    { address: token.address, abi: erc20Abi, functionName: "decimals" },
  ] });
  if (decimals > 36) throw new Error("Unsupported token precision");
  return { name, symbol, decimals };
}

export function StockSwap({ side, onReverse }: { side: "buy" | "sell"; onReverse: () => void }) {
  const { address, chainId } = useAccount();
  // Testnet keeps this screen but trades test stocks for test USDC (lib/test-swap.ts).
  const { isTestnet: testnet } = useAppNetwork();
  const swapChain = testnet ? TEST_SWAP_CHAIN : SWAP_CHAIN;
  const quoteToken = testnet ? TEST_USDC : USDC;
  const quoteSymbol = testnet ? "tUSDC" : "USDC";
  const explorer = testnet ? "https://sepolia.basescan.org" : "https://basescan.org";
  const client = usePublicClient({ chainId: swapChain }) as PublicClient;
  const catalog = useQuery({ queryKey: ["stock-catalog", swapChain], queryFn: () => testnet ? testCatalog(client) : getCatalog(), staleTime: 60000, refetchInterval: 60000, retry: 1 });
  const [selected, setSelected] = useState("");
  const [search, setSearch] = useState("");
  const [amount, setAmount] = useState("");
  const [bps, setBps] = useState<(typeof SLIPPAGE_BPS)[number]>(50);
  const [eligible, setEligible] = useState(false);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState("");
  const [error, setError] = useState("");
  const [hash, setHash] = useState<Hash>();
  const [now, setNow] = useState(0);
  const [revision, setRevision] = useState(0);
  const [debouncedKey, setDebouncedKey] = useState("");
  const [picking, setPicking] = useState(false);
  const [bought, setBought] = useState(false);
  const [minting, setMinting] = useState(false);
  const lock = useRef(false);
  const generation = useRef(0);
  const token = catalog.data?.tokens.find(t => t.address === selected);
  const details = useQuery({ queryKey: ["swap-token", swapChain, selected], queryFn: () => readStock(client, token!), enabled: !!token, retry: 1, staleTime: 60000 });
  const input = side === "buy" ? quoteToken : token?.address;
  const output = side === "buy" ? token?.address : quoteToken;
  const balance = useQuery({ queryKey: ["swap-balance", input, address], queryFn: () => client.readContract({ address: input!, abi: erc20Abi, functionName: "balanceOf", args: [address!] }), enabled: !!input && !!address, refetchInterval: 15000, retry: 1 });
  const outputBalance = useQuery({ queryKey: ["swap-balance", output, address], queryFn: () => client.readContract({ address: output!, abi: erc20Abi, functionName: "balanceOf", args: [address!] }), enabled: !!output && !!address, refetchInterval: 15000, retry: 1 });
  const decimals = side === "buy" ? 6 : details.data?.decimals ?? 8;
  const outputDecimals = side === "buy" ? details.data?.decimals ?? 8 : 6;
  const stockSymbol = details.data?.symbol ?? token?.symbol;
  const inputSymbol = side === "buy" ? quoteSymbol : stockSymbol ?? "Select stock";
  const outputSymbol = side === "buy" ? stockSymbol ?? "Select stock" : quoteSymbol;
  const raw = parseSwapAmount(amount, decimals);
  const key = [side, selected, raw.toString(), bps, address, chainId, revision].join(":");
  const catalogLive = !!catalog.data && catalog.data.expiresAt > now;
  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, []);
  // A finished swap belongs to the wallet that made it: switching wallets drops its result.
  const lastAddress = useRef(address);
  useEffect(() => {
    if (lastAddress.current === address) return;
    lastAddress.current = address;
    setBought(false); setError(""); setStatus(""); setHash(undefined);
  }, [address]);
  useEffect(() => {
    generation.current += 1;
    const timer = window.setTimeout(() => setDebouncedKey(key), 500);
    return () => { generation.current += 1; window.clearTimeout(timer); };
  }, [key]);
  // Input-specific query keys prevent late responses overwriting a newer trade.
  const quotes = useQuery({
    queryKey: ["stock-swap-quote", key],
    queryFn: async () => {
      if (!catalog.data || nowMs() >= catalog.data.expiresAt) throw new Error("Refresh the issuer catalog first");
      if (testnet) return testQuote({ side, symbol: details.data!.symbol, sellAmount: raw, stockDecimals: details.data!.decimals });
      // A quote that never answers must not leave the screen on "Getting quote…".
      return withTimeout(fetchAerodromeQuote(client, { side, token: token!.address, sellAmount: raw, taker: address ?? "0x0000000000000000000000000000000000000000", slippageBps: bps }), QUOTE_TIMEOUT_MS, "The quote took too long. Try again or a smaller amount.");
    },
    enabled: debouncedKey === key && !!token && !!details.data && raw > 0n && catalogLive && !busy,
    retry: false, staleTime: Infinity, gcTime: 60000, refetchOnWindowFocus: false,
  });
  const quoting = raw > 0n && !!token && (debouncedKey !== key || quotes.isFetching);
  const current: AerodromeQuote | TestQuote | undefined = !quotes.isFetching && debouncedKey === key ? quotes.data : undefined;
  const pool = current && "pool" in current ? current : undefined;
  // A Chainlink reference where one exists (the 12 Rips stocks): never fill
  // more than MAX_DEVIATION worse than it, whatever the pool says.
  const reference = useQuery({ queryKey: ["swap-reference", swapChain, token?.address], queryFn: () => testnet ? stockPrice(token!.symbol) : chainlinkPrice(client, token!.address), enabled: !!token, staleTime: 60_000 });
  const fillPrice = current && raw > 0n
    ? side === "buy" ? Number(formatUnits(raw, decimals)) / Number(formatUnits(current.buyAmount, outputDecimals)) : Number(formatUnits(current.buyAmount, outputDecimals)) / Number(formatUnits(raw, decimals))
    : null;
  const refPrice = reference.data?.price ?? null;
  const deviation = fillPrice && refPrice ? (fillPrice / refPrice - 1) * 100 : null;
  const tooFar = deviation !== null && (side === "buy" ? deviation > MAX_DEVIATION : -deviation > MAX_DEVIATION);
  function clearTrade() {
    generation.current += 1;
    setAmount(""); setEligible(false); setBought(false); setError(""); setStatus(""); setHash(undefined); setRevision(v => v + 1);
  }
  async function trade() {
    if (lock.current || !address || !token || !(eligible || testnet) || !catalog.data || quoting || !raw || !catalogLive) return;
    const run = generation.current;
    lock.current = true; setBusy(true); setError(""); setHash(undefined);
    try {
      if (testnet) {
        const executable = await testQuote({ side, symbol: details.data!.symbol, sellAmount: raw, stockDecimals: details.data!.decimals });
        await executeTestSwap({ side, stock: token.address, account: address, sellAmount: raw, quote: executable, progress: (text, tx) => { setStatus(text); if (tx) setHash(tx); } });
        setAmount(""); setBought(side === "buy");
        void balance.refetch(); void outputBalance.refetch();
        return;
      }
      // Re-quote immediately before signing. A price quote may have moved.
      setStatus("Confirming the executable quote…");
      const swapOnce = async () => {
        const executable = await fetchAerodromeQuote(client, { side, token: token.address, sellAmount: raw, taker: address, slippageBps: bps });
        if (generation.current !== run) throw new Error("Wallet or trade changed. Review again.");
        return executeZeroExSwap({ client, account: address, quote: executable,
          isActive: () => generation.current === run,
          progress: (text, tx) => { setStatus(text); if (tx) setHash(tx); },
        });
      };
      // A separate approval comes first; then re-quote and swap in the same
      // click, so the price signed is never older than the approval.
      if ((await swapOnce()).kind === "approved") await swapOnce();
      // Done: clear the amount so the old trade is not re-quoted against the
      // new, lower balance ("Balance is short") under the confirmation.
      setAmount("");
      void balance.refetch(); void outputBalance.refetch();
    } catch (e) { setError(/user rejected|denied|cancelled/i.test(message(e)) ? "Request cancelled in your wallet." : message(e)); }
    finally { lock.current = false; setBusy(false); setRevision(v => v + 1); }
  }
  const filtered = catalog.data?.tokens.filter(t => `${t.name} ${t.symbol} ${t.issuer} ${t.address}`.toLowerCase().includes(search.toLowerCase())) ?? [];
  const disabledReason = !token ? "Select a stock" : !raw ? "Enter an amount" : !catalogLive ? "Refresh the stock list" : !details.data ? "Token details unavailable" : quoting ? "Getting quote…" : !current ? "No executable quote" : tooFar ? `Price is ${Math.abs(deviation!).toFixed(1)}% off Chainlink` : !eligible && !testnet ? "Review eligibility below" : balance.isError ? "Balance unavailable" : balance.data === undefined ? "Checking balance…" : balance.data < raw ? `Insufficient ${inputSymbol}` : "";
  // The server never knows the wallet; render the disconnected value until hydrated.
  const hydrated = useSyncExternalStore(subscribeNever, () => true, () => false);
  const showBalance = (value: bigint | undefined, precision: number, failed: boolean) => !hydrated || !address ? "—" : failed ? "Unavailable" : value === undefined ? "…" : formatUnits(value, precision);
  const featured = new Set(RIPS_STOCKS.map(s => s.symbol));
  const popular = catalog.data?.tokens.filter(t => featured.has(t.symbol)) ?? [];
  const pickStock = (address: string) => { clearTrade(); setSelected(address); setPicking(false); };
  const rate = current && raw > 0n ? Number(formatUnits(current.buyAmount, outputDecimals)) / Number(formatUnits(raw, decimals)) : 0;
  const connected = hydrated && !!address && chainId === swapChain;
  async function getTestUsdc() {
    if (!address || minting) return;
    setMinting(true); setError("");
    try { const tx = await mintTestUsdc(address); setHash(tx); setStatus(`Added ${formatUnits(TEST_USDC_GRANT, 6)} test USDC to your wallet.`); void balance.refetch(); void outputBalance.refetch(); }
    catch (e) { setError(/user rejected|denied|cancelled/i.test(message(e)) ? "Request cancelled in your wallet." : message(e)); }
    finally { setMinting(false); }
  }
  const selector = (isStock: boolean, symbol: string) => isStock
    ? <Button type="button" variant="outline" aria-label="Select stock" aria-haspopup="dialog" disabled={busy} onClick={() => { setSearch(""); setPicking(true); }}
        className="border-line bg-panel h-11 shrink-0 gap-2 rounded-full pr-3 pl-1.5 text-base font-semibold shadow-none">
        <TokenMark symbol={stockSymbol} /><span className="max-w-[9rem] truncate">{symbol}</span><ChevronDown aria-hidden className="text-muted" />
      </Button>
    : <div className="border-line bg-panel inline-flex h-11 shrink-0 items-center gap-2 rounded-full border pr-4 pl-1.5 text-base font-semibold" title={`Supported quote token: ${quoteSymbol}`}><TokenMark symbol="USDC" />{quoteSymbol}</div>;
  const panel = "rounded-2xl border border-line/70 bg-bg/60 p-4 transition-colors focus-within:border-text/40";
  return <>
    <AppChrome active="/swap" />
    <main className="mx-auto w-full max-w-[520px] flex-1 px-4 pt-8 pb-16 sm:pt-12">
      <div className="mb-6">
        <h1 className="font-display text-4xl font-semibold tracking-[-0.05em]">{side === "buy" ? "Buy stocks" : "Sell stocks"}</h1>
        <p className="text-muted mt-2 text-sm leading-6">{testnet ? "Test stocks on Base Sepolia, paid in test USDC at the real stock's Chainlink price. Nothing here has value." : "Real Coinbase stock tokens on Base, paid in USDC. Swapped on Aerodrome."}</p>
        {testnet && <Button type="button" variant="outline" className="mt-3 h-9 rounded-full text-sm" disabled={!connected || minting || busy} title={connected ? undefined : "Connect a wallet on Base Sepolia first"} onClick={() => void getTestUsdc()}>
          {minting ? <Loader2 aria-hidden className="animate-spin" /> : null}Get {Number(formatUnits(TEST_USDC_GRANT, 6)).toLocaleString()} test USDC
        </Button>}
      </div>
      <ToggleGroup aria-label="Trade direction" value={[side]} onValueChange={(v: string[]) => { if (v[0] && v[0] !== side && !busy) { clearTrade(); onReverse(); } }}
        className="border-line/70 bg-panel mb-3 grid w-full grid-cols-2 rounded-full border p-1">
        <ToggleGroupItem value="buy" className="h-9 rounded-full text-sm font-semibold data-[pressed]:bg-text data-[pressed]:text-bg">Buy</ToggleGroupItem>
        <ToggleGroupItem value="sell" className="h-9 rounded-full text-sm font-semibold data-[pressed]:bg-text data-[pressed]:text-bg">Sell</ToggleGroupItem>
      </ToggleGroup>
      <Card aria-label="Swap tokens" className="border-line/70 bg-panel gap-0 rounded-[28px] p-2 shadow-[0_1px_0_rgb(0_0_0/0.02),0_24px_60px_-28px_rgb(0_0_0/0.25)] sm:p-3">
        <div className={panel}>
          <div className="text-muted mb-3 flex items-center justify-between gap-2 text-xs"><span className="font-medium tracking-wide uppercase">You pay</span><span className="truncate tabular-nums">Balance {showBalance(balance.data, decimals, balance.isError)}</span></div>
          <div className="flex items-center gap-3">{selector(side === "sell", inputSymbol)}<input aria-label={`You pay (${inputSymbol})`} className="placeholder:text-muted/40 min-w-0 flex-1 bg-transparent text-right text-3xl font-semibold tracking-tight tabular-nums sm:text-4xl outline-none" inputMode="decimal" placeholder="0" value={amount} disabled={busy} onChange={e => { generation.current += 1; setAmount(e.target.value); setError(""); setStatus(""); }} /></div>
          {hydrated && balance.data !== undefined && balance.data > 0n && <div className="mt-3 flex justify-end gap-1.5">{(side === "buy" ? [10, 25, 100] : []).map(v => <button key={v} type="button" disabled={busy} onClick={() => { generation.current += 1; setAmount(String(v)); }} className="border-line/70 text-muted hover:text-text hover:border-text/40 rounded-full border px-2.5 py-0.5 text-xs tabular-nums">${v}</button>)}<button type="button" disabled={busy} onClick={() => { generation.current += 1; setAmount(formatUnits(balance.data!, decimals)); }} className="border-line/70 text-muted hover:text-text hover:border-text/40 rounded-full border px-2.5 py-0.5 text-xs">Max</button></div>}
        </div>
        <div className="relative z-10 -my-3 flex justify-center">
          <Button type="button" variant="outline" size="icon" aria-label="Reverse swap direction" disabled={busy} className="border-line bg-panel size-10 rounded-xl shadow-sm" onClick={() => { clearTrade(); onReverse(); }}><ArrowDownUp /></Button>
        </div>
        <div className={panel}>
          <div className="text-muted mb-3 flex items-center justify-between gap-2 text-xs"><span className="font-medium tracking-wide uppercase">You receive</span><span className="truncate tabular-nums">Balance {showBalance(outputBalance.data, outputDecimals, outputBalance.isError)}</span></div>
          <div className="flex items-center gap-3">{selector(side === "buy", outputSymbol)}<output aria-label="Estimated output" className={`min-w-0 flex-1 truncate text-right text-3xl font-semibold tracking-tight tabular-nums sm:text-4xl ${quoting ? "text-muted/50 animate-pulse" : current ? "" : "text-muted/40"}`}>{quoting ? "…" : current ? trimUnits(formatUnits(current.buyAmount, outputDecimals)) : "0"}</output></div>
        </div>

        <div className="space-y-3 px-2 pt-4 pb-2 text-xs">
          {current && <div aria-label="Swap quote" className="border-line/70 divide-line/70 divide-y rounded-2xl border">
            <Row label="Rate" value={`1 ${inputSymbol} = ${trimUnits(rate.toPrecision(6))} ${outputSymbol}`} />
            <Row label="Minimum received" value={`${trimUnits(formatUnits(current.minBuyAmount, outputDecimals))} ${outputSymbol}`} />
            {refPrice !== null && deviation !== null && <Row label="Chainlink price" value={`$${refPrice.toFixed(2)} · this fill ${deviation >= 0 ? "+" : ""}${deviation.toFixed(1)}%`} />}
            {pool ? <>
              <Row label="Route" value={`Aerodrome · USDC pool ($${Math.round(Number(formatUnits(pool.pool.usdcDepth, 6))).toLocaleString()} deep)`} />
              <Row label="Fees" value={`${(pool.pool.feePips / 10_000).toFixed(2)}% pool fee included · ETH gas extra`} />
            </> : <>
              <Row label="Route" value="Test mint at the Chainlink price · 2 confirmations" />
              <Row label="Fees" value="None · Sepolia ETH gas only" />
            </>}
          </div>}
          {pool?.issues?.balance && <p role="alert" className="text-danger">Balance is short for this trade. Reduce the amount.</p>}
          {pool?.issues?.allowance && <p className="text-muted">You approve exactly this amount first, then confirm the swap.</p>}
          {!testnet && <div className="flex items-center justify-between gap-3">
            <span className="text-muted">Max slippage</span>
            <ToggleGroup aria-label="Slippage tolerance" value={[String(bps)]} onValueChange={(v: string[]) => { if (v[0]) { generation.current += 1; setBps(Number(v[0]) as (typeof SLIPPAGE_BPS)[number]); } }} className="border-line/70 rounded-full border p-0.5">
              {SLIPPAGE_BPS.map(v => <ToggleGroupItem key={v} value={String(v)} disabled={busy} className="h-6 rounded-full px-2.5 text-xs tabular-nums data-[pressed]:bg-text data-[pressed]:text-bg">{(v / 100).toFixed(1)}%</ToggleGroupItem>)}
            </ToggleGroup>
          </div>}
          {catalog.error && <p role="alert" className="text-danger">{message(catalog.error)}</p>}
          {catalog.data?.partial && <p className="text-muted">Some issuer lists are unavailable right now.</p>}
          {!catalogLive && catalog.data && <p role="alert" className="text-danger">Stock list expired. Refresh before trading.</p>}
          {details.isError && <p role="alert" className="text-danger">Token details unavailable. <button className="underline" onClick={() => void details.refetch()}>Retry</button></p>}
          {token && raw > 0n && <p className="text-muted flex items-center gap-1.5" role="status"><span aria-hidden className={`size-1.5 rounded-full ${current && !tooFar ? "bg-emerald-500" : quoting ? "bg-amber-400 animate-pulse" : "bg-line"}`} />{testnet ? quoting ? "Pricing…" : current ? "Test swap available." : "No price for this stock." : quoting ? "Getting Aerodrome quote…" : quotes.isError ? "No Aerodrome route." : current ? "Aerodrome route available." : "No Aerodrome route for this trade."}</p>}
          {tooFar && <p role="alert" className="text-danger">This fill is {Math.abs(deviation!).toFixed(1)}% {side === "buy" ? "above" : "below"} the Chainlink price, past the {MAX_DEVIATION}% limit. A smaller amount may help; if the pool itself is off, wait for it to come back.</p>}
          {token && !reference.isLoading && refPrice === null && <p className="text-muted">No Chainlink reference for this stock: check the price yourself before trading.</p>}
          {amount && !raw && <p className="text-danger">Enter a positive amount with at most {decimals} decimal places.</p>}
          {quotes.error && <p role="alert" className="text-danger">{message(quotes.error)}</p>}
          {raw > 0n && token && <button className="text-muted hover:text-text inline-flex items-center gap-1 underline-offset-4 hover:underline" disabled={busy || quoting} onClick={() => setRevision(v => v + 1)}><RefreshCw aria-hidden className="size-3" />Refresh quote</button>}
        </div>

        {token && !testnet && <label className="border-line/70 bg-bg/60 mx-2 mb-3 flex items-start gap-3 rounded-2xl border p-3 text-xs leading-5">
          <input type="checkbox" aria-label="I have reviewed the issuer terms and am eligible, including non-US restrictions" className="accent-text mt-0.5 size-4" checked={eligible} disabled={busy} onChange={e => setEligible(e.target.checked)} />
          <span><span className="flex items-center gap-1.5 font-medium"><ShieldCheck aria-hidden className="size-3.5" />Restricted tokenized asset</span><span className="text-muted">I have reviewed the <a href={token.disclosures} target="_blank" rel="noreferrer" className="text-text underline">issuer terms</a> and am eligible, including non-US restrictions. Stock prices can fall.</span></span>
        </label>}

        <div className="px-2 pb-2">
          {!connected
            ? <div className="[&_button]:h-12 [&_button]:w-full [&_button]:rounded-2xl [&_button]:text-base [&>*]:w-full"><ConnectButton requiredChainId={swapChain} chainName={testnet ? "Base Sepolia" : "Base mainnet"} /></div>
            : <Button className="h-12 w-full rounded-2xl text-base font-semibold" disabled={!!disabledReason || quoting || busy} title={disabledReason || undefined} onClick={() => void trade()}>
                {busy ? <Loader2 aria-hidden className="animate-spin" /> : null}{disabledReason || (testnet ? "Confirm test swap" : "Review approval / confirm swap")}
              </Button>}
          {status && <p className="mt-3 text-center text-sm" role="status">{status}</p>}
          {error && <p className="text-danger mt-3 text-center text-sm" role="alert">{error}</p>}
          {hash && <a className="mt-3 flex items-center justify-center gap-1 text-sm underline underline-offset-4" href={`${explorer}/tx/${hash}`} target="_blank" rel="noreferrer">View transaction <ArrowUpRight aria-hidden className="size-3.5" /></a>}
          {testnet && bought && <Link href={`/rips/sell?stock=${selected}`} className="bg-text text-bg mt-3 flex h-11 items-center justify-center rounded-2xl text-sm font-semibold">Deposit {stockSymbol} to earn from Rips buyers →</Link>}
        </div>
      </Card>

      <details className="text-muted mt-5 px-1 text-xs"><summary className="cursor-pointer">Token &amp; list details</summary>{token && <><p className="mt-2">{details.data?.name ?? token.name} · {token.issuer}</p><a className="mt-2 block break-all underline" href={`${explorer}/token/${token.address}`} target="_blank" rel="noreferrer">{token.address}</a>{token.notice && <p className="mt-2">{token.notice}</p>}</>}<p className="mt-2">{catalog.data?.tokens.length ?? 0} verified listings. Listing does not guarantee liquidity.</p><button className="mt-2 underline" disabled={catalog.isFetching || busy} onClick={() => void catalog.refetch()}>Refresh list</button>{catalog.data?.sources.map(s => <p className="mt-2" key={s.id}><a href={s.url} className="underline" target="_blank" rel="noreferrer">{s.issuer}</a> · {s.status === "ok" ? `${s.count} listings` : "unavailable"}</p>)}</details>
      <p className="text-muted mt-4 px-1 text-xs leading-relaxed">{testnet ? "Base Sepolia test tokens. Switch to Mainnet in the header for real stocks." : "Base mainnet with real funds."} Wallet tokens only; Rips claims are not swappable here.</p>
    </main>

    <Dialog open={picking} onOpenChange={setPicking}>
      {/* A closing picker must not catch the next click: a stray tap would pick the row under it. */}
      <DialogContent className="bg-panel gap-0 overflow-hidden rounded-3xl p-0 data-closed:pointer-events-none sm:max-w-md">
        <DialogHeader className="px-5 pt-5 pb-3"><DialogTitle className="font-display text-xl">Select a stock</DialogTitle></DialogHeader>
        <div className="px-5">
          <label className="relative block"><span className="sr-only">Search stocks or issuers</span>
            <Search aria-hidden className="text-muted pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2" />
            <Input aria-label="Search stocks or issuers" autoFocus className="border-line bg-bg h-11 rounded-xl pl-9 text-sm" placeholder="Name, ticker, issuer or address" value={search} onChange={e => setSearch(e.target.value)} />
          </label>
          {!search && popular.length > 0 && <div className="mt-3 flex flex-wrap gap-1.5">{popular.map(t => <button key={t.address} type="button" onClick={() => pickStock(t.address)} className={`border-line/70 hover:border-text/40 inline-flex items-center gap-1.5 rounded-full border py-1 pr-2.5 pl-1 text-xs font-medium ${selected === t.address ? "bg-text text-bg" : ""}`}><TokenMark symbol={t.symbol} small />{t.symbol}</button>)}</div>}
          <div className="text-muted mt-3 flex justify-between text-xs"><span>{catalog.data ? `${catalog.data.tokens.length} verified listings` : "Loading stocks…"}</span><button className="underline" disabled={catalog.isFetching} onClick={() => void catalog.refetch()}>Refresh list</button></div>
          {catalog.error && <p role="alert" className="text-danger mt-2 text-sm">{message(catalog.error)}</p>}
        </div>
        <div className="mt-2 max-h-[52dvh] overflow-y-auto px-2 pb-3" aria-label="Stock catalog">
          {filtered.map(t => <button type="button" key={t.address} aria-pressed={selected === t.address} onClick={() => pickStock(t.address)}
            className="hover:bg-bg/80 aria-pressed:bg-bg flex w-full items-center gap-3 rounded-xl px-3 py-2.5 text-left">
            <TokenMark symbol={t.symbol} />
            <span className="min-w-0 flex-1"><span className="block truncate text-sm font-semibold">{t.symbol}</span><span className="text-muted block truncate text-xs">{t.name}</span></span>
            <span className="text-muted border-line/70 rounded-full border px-2 py-0.5 text-[0.6875rem]">{t.issuer}</span>
          </button>)}
          {catalog.data && !filtered.length && <p className="text-muted px-3 py-6 text-sm">No verified listing matches your search.</p>}
        </div>
      </DialogContent>
    </Dialog>
  </>;
}

function Row({ label, value }: { label: string; value: string }) {
  return <p className="flex justify-between gap-3 px-3 py-2.5"><span className="text-muted">{label}</span><span className="text-right break-all tabular-nums">{value}</span></p>;
}

/** Drops trailing zeros so 0.031250000 reads as 0.03125. */
function trimUnits(value: string) {
  return value.includes(".") ? value.replace(/\.?0+$/, "") : value;
}

const MARK_COLORS = ["bg-[#1f2937]", "bg-[#7c2d12]", "bg-[#14532d]", "bg-[#1e3a8a]", "bg-[#581c87]", "bg-[#134e4a]", "bg-[#713f12]", "bg-[#831843]"];

function TokenMark({ symbol, small = false }: { symbol?: string; small?: boolean }) {
  const size = small ? "size-5 text-[0.5625rem]" : "size-8 text-[0.6875rem]";
  if (symbol === "USDC") return <span aria-hidden className={`${size} flex shrink-0 items-center justify-center rounded-full bg-[#2775ca] font-bold text-white`}>$</span>;
  const tone = symbol ? MARK_COLORS[[...symbol].reduce((a, c) => a + c.charCodeAt(0), 0) % MARK_COLORS.length] : "bg-line";
  return <span aria-hidden className={`${size} ${tone} flex shrink-0 items-center justify-center rounded-full font-bold tracking-tight text-white`}>{symbol?.replace(/c$/, "").slice(0, small ? 2 : 4) ?? "+"}</span>;
}
