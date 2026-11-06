"use client";

import { useState, type ReactNode } from "react";
import { useAccount, useConnect, useConnections, useDisconnect, useSwitchConnection, type Connector } from "wagmi";
import { Check, Copy, ExternalLink } from "lucide-react";
import { shortAddress } from "@/lib/format";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

/**
 * The Mainnet wallet menu, following Base's wallet guidance
 * (docs.cdp.coinbase.com/coinbase-wallet): "Sign in with Base" first and no
 * smaller than any other option, the Base square in its brand colours, one
 * line on why, and browser wallets by their real names. Disconnect signs out
 * of every wallet, so no other connection silently takes over. Local test wallets
 * exist only under `next dev` and sit apart at the bottom.
 */

const DEV_PREFIX = "erodoroDevTest";
const BASE_ACCOUNT = "baseAccount";

/** The Base square: Base Blue on light, white on dark, radius kept. */
function BaseSquare() {
  return <span aria-hidden className="size-4 shrink-0 rounded-[3px] bg-[#0000FF] dark:bg-white" />;
}

function WalletIcon({ connector }: { connector: Connector }) {
  if (connector.id === BASE_ACCOUNT) return <BaseSquare />;
  // eslint-disable-next-line @next/next/no-img-element -- EIP-6963 icons are data URIs from the extension.
  if (connector.icon) return <img src={connector.icon} alt="" className="size-4 shrink-0 rounded-sm" />;
  return <span aria-hidden className="border-line size-4 shrink-0 rounded-sm border" />;
}

/** Browser wallets by name (EIP-6963); the generic entry only when none announced themselves. */
function walletGroups(connectors: readonly Connector[]) {
  const browser = connectors.filter(c => c.type === "injected" && !c.id.startsWith(DEV_PREFIX));
  const named = browser.filter(c => c.id !== "injected");
  return {
    baseAccount: connectors.find(c => c.id === BASE_ACCOUNT),
    browser: named.length ? named : browser,
    dev: connectors.filter(c => c.id.startsWith(DEV_PREFIX)),
  };
}

const label = (c: Connector) => c.id === "injected" ? "Browser wallet" : c.name;

function useConnectTo(onDone: () => void) {
  const { connect, isPending } = useConnect();
  const [error, setError] = useState<string | null>(null);
  const connectTo = (connector: Connector) => {
    setError(null);
    connect({ connector }, {
      onSuccess: onDone,
      onError: e => setError(/reject|denied|cancel/i.test(e.message) ? "Connection cancelled. Choose a wallet to try again." : "Could not connect. Open your wallet and try again."),
    });
  };
  return { connectTo, isPending, error };
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return <DropdownMenuGroup>
    <DropdownMenuLabel className="text-dim px-3 pt-2 pb-1 text-[0.72rem]">{title}</DropdownMenuLabel>
    {children}
  </DropdownMenuGroup>;
}

export function MainnetConnect({ className }: { className: string }) {
  const { connectors } = useConnect();
  const [open, setOpen] = useState(false);
  const { connectTo, isPending, error } = useConnectTo(() => setOpen(false));
  const { baseAccount, browser, dev } = walletGroups(connectors);
  return (
    <DropdownMenu open={open} onOpenChange={setOpen}>
      <DropdownMenuTrigger disabled={isPending} render={<Button className={`${className} bg-text hover:bg-accent text-bg border-0 font-medium`} />}>
        {isPending ? "Connecting…" : "Connect wallet"}
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" sideOffset={8} className="border-line bg-panel grid w-72 gap-1 border p-2 shadow-lg ring-0">
        {baseAccount && <>
          <DropdownMenuItem closeOnClick={false} onClick={() => connectTo(baseAccount)}
            className="h-11 justify-center gap-2 rounded-lg border border-black/10 bg-white text-[0.9375rem] font-medium text-black data-highlighted:bg-white/90 dark:border-white/15 dark:bg-black dark:text-white dark:data-highlighted:bg-black/80">
            <BaseSquare />Sign in with Base
          </DropdownMenuItem>
          <p className="text-dim px-3 pb-1 text-[0.72rem] leading-snug">A passkey wallet: no extension or seed phrase, and approvals go through in one tap.</p>
        </>}
        {browser.length > 0 && <Section title="Browser wallets">
          {browser.map(c => <DropdownMenuItem key={c.uid} closeOnClick={false} onClick={() => connectTo(c)} className="h-11 gap-2 px-3"><WalletIcon connector={c} />{label(c)}</DropdownMenuItem>)}
        </Section>}
        {dev.length > 0 && <Section title="Local test wallets (this machine only)">
          {dev.map(c => <DropdownMenuItem key={c.uid} closeOnClick={false} onClick={() => connectTo(c)} className="text-muted gap-2 px-3 py-1.5 text-xs">{c.name}</DropdownMenuItem>)}
        </Section>}
        {isPending && <p role="status" className="text-muted px-3 py-1 text-xs">Approve or cancel the request in your wallet.</p>}
        {error && <p role="alert" className="text-danger px-3 py-1 text-xs">{error}</p>}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

export function MainnetAccount({ className }: { className: string }) {
  const { address, connector } = useAccount();
  const { connectors } = useConnect();
  const connections = useConnections();
  const { disconnect } = useDisconnect();
  const { switchConnection } = useSwitchConnection();
  const [open, setOpen] = useState(false);
  const [copied, setCopied] = useState(false);
  const { connectTo, isPending, error } = useConnectTo(() => setOpen(false));
  const connected = new Set(connections.map(c => c.connector.uid));
  const { baseAccount, browser, dev } = walletGroups(connectors);
  const others = [baseAccount, ...browser, ...dev].filter((c): c is Connector => !!c && c.uid !== connector?.uid);
  const copy = async () => {
    try { await navigator.clipboard.writeText(address ?? ""); setCopied(true); setTimeout(() => setCopied(false), 1500); } catch { /* Clipboard blocked; the address stays visible. */ }
  };
  return (
    <DropdownMenu open={open} onOpenChange={setOpen}>
      <DropdownMenuTrigger title={address} render={<Button variant="outline" className={`${className} border-line text-muted hover:border-text hover:text-text bg-transparent font-mono shadow-none hover:bg-transparent aria-expanded:bg-transparent`} />}>
        {shortAddress(address ?? "", 4)} ⌄
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" sideOffset={8} className="border-line bg-panel grid w-72 gap-1 border p-2 shadow-lg ring-0">
        <div className="flex items-center gap-2 px-3 py-2">
          {connector && <WalletIcon connector={connector} />}
          <div className="min-w-0">
            <p className="text-sm font-medium">{connector ? label(connector) : "Wallet"}</p>
            <p className="text-muted font-mono text-xs">{shortAddress(address ?? "", 6)}</p>
          </div>
        </div>
        <DropdownMenuItem closeOnClick={false} onClick={() => void copy()} className="gap-2 px-3 py-2">
          {copied ? <Check aria-hidden /> : <Copy aria-hidden />}{copied ? "Copied" : "Copy address"}
        </DropdownMenuItem>
        <DropdownMenuItem render={<a href={`https://basescan.org/address/${address}`} target="_blank" rel="noreferrer" />} className="gap-2 px-3 py-2">
          <ExternalLink aria-hidden />View on BaseScan
        </DropdownMenuItem>
        {others.length > 0 && <Section title="Switch wallet">
          {others.map(c => <DropdownMenuItem key={c.uid} closeOnClick={false}
            onClick={() => connected.has(c.uid) ? (switchConnection({ connector: c }), setOpen(false)) : connectTo(c)}
            className={`gap-2 px-3 ${c.id.startsWith(DEV_PREFIX) ? "text-muted py-1.5 text-xs" : "py-2"}`}>
            {!c.id.startsWith(DEV_PREFIX) && <WalletIcon connector={c} />}{c.id === BASE_ACCOUNT ? "Sign in with Base" : label(c)}
          </DropdownMenuItem>)}
        </Section>}
        {isPending && <p role="status" className="text-muted px-3 py-1 text-xs">Approve or cancel the request in your wallet.</p>}
        {error && <p role="alert" className="text-danger px-3 py-1 text-xs">{error}</p>}
        <DropdownMenuSeparator />
        <DropdownMenuItem variant="destructive" onClick={() => { for (const c of connections) disconnect({ connector: c.connector }); }} className="px-3 py-2">Disconnect</DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
