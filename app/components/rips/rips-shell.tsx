"use client";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { createContext, useContext, type ReactNode } from "react";
import { AppChrome } from "../app-chrome";
import { ConnectButton } from "../connect-button";
import { useRipsState } from "@/lib/rips/use-rips";
import { DEPLOYMENT } from "@/lib/deployment";
import { RIPS_ONLY_APP, RIPS_SHOW_DEMO, RIPS_SHOW_EXTRAS } from "@/lib/rips/ui";
import { Button } from "@/components/ui/button";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";

const Ctx = createContext<ReturnType<typeof useRipsState> | null>(null);
export function useRips() { const v = useContext(Ctx); if (!v) throw new Error("useRips outside RipsShell"); return v; }
function State({ children }: { children: ReactNode }) {
  const state = useRipsState();
  const path = usePathname();
  return <Ctx.Provider value={state}>
    <AppChrome active={path.startsWith("/rips") ? "/rips" : "/market-rip"} />
    <main className="mx-auto w-full max-w-3xl flex-1 px-4 pb-16">
      {/* AppChrome already links Market Rip and My Rips. */}
      {RIPS_SHOW_EXTRAS && <nav aria-label="Rips" className="flex flex-wrap items-center justify-between gap-3 border-b border-line py-4">
        <div className="flex gap-4"><Link href="/market-rip" aria-current={path === "/market-rip" ? "page" : undefined}>Rip</Link><Link href="/rips" aria-current={path.startsWith("/rips") ? "page" : undefined}>My Rips</Link></div>
        {RIPS_SHOW_DEMO && state.canSwitch && <ToggleGroup aria-label="Rip pool" value={state.modeReady ? [state.mode] : []} onValueChange={value => { if (value[0]) state.setMode(value[0] as "live" | "demo"); }} disabled={state.buy.phase !== "idle"} className="gap-2">
          {(["live", "demo"] as const).map(m => <ToggleGroupItem key={m} value={m} variant="outline" size="sm" className="border-line text-muted data-pressed:border-text data-pressed:bg-text data-pressed:text-bg h-7 rounded-full px-3 font-normal shadow-none hover:bg-transparent data-pressed:hover:bg-text">{m === "live" ? "Live Sepolia" : "Demo pool"}</ToggleGroupItem>)}
        </ToggleGroup>}
      </nav>}
      {state.mode === "live" && state.buy.wrongNetwork && <div role="alert" className="mt-4 border border-danger p-4"><p className="mb-3 text-sm">Your wallet must use {DEPLOYMENT.chainName} before buying. Your holdings are read from that network.</p><ConnectButton /></div>}
      {state.mode === "live" && state.error && <div role="alert" className="mt-4 border border-danger p-4 text-sm">{state.error} <Button variant="link" className="text-text inline h-auto p-0 align-baseline font-normal underline underline-offset-auto" onClick={() => void state.refresh()}>Retry pool read</Button></div>}
      {children}
    </main>
    <footer className="text-dim mx-auto max-w-3xl px-4 pb-8 text-center text-xs leading-5">{state.mode === "demo" ? "Demo pool: simulated prices and positions. Nothing is bought and no funds move." : `${RIPS_ONLY_APP ? "" : `${DEPLOYMENT.chainName} `}Rips buy fractional ERC-6909 upside (N) claims. They can expire worth nothing. No resale liquidity is guaranteed.`} <Link href="/#risk" className="underline">Risks</Link></footer>
  </Ctx.Provider>;
}
export function RipsShell({ children }: { children: ReactNode }) { return <State>{children}</State>; }
/** Rips state without the app chrome, for embedding the live pool elsewhere (the landing). */
export function RipsProvider({ children }: { children: ReactNode }) {
  const state = useRipsState();
  return <Ctx.Provider value={state}>{children}</Ctx.Provider>;
}
