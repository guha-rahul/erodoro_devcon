"use client";

import { useState, useSyncExternalStore } from "react";
import {
  useAccount,
  useConnect,
  useConnections,
  useDisconnect,
  useSwitchChain,
  useSwitchConnection,
} from "wagmi";
import { REQUIRED_CHAIN_ID } from "@/lib/wagmi";
import { useBatchMode } from "@/lib/use-batching";
import { DEPLOYMENT } from "@/lib/deployment";
import { shortAddress } from "@/lib/format";
import { useAppNetwork } from "@/lib/use-app-network";
import { MainnetAccount, MainnetConnect } from "./mainnet-wallet";
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

const subscribeNever = () => () => {};

/**
 * Connect, and stay honest about the chain.
 *
 * A wallet connected to the wrong network is the single easiest way to lose a
 * transaction, so the wrong-chain state is louder than the disconnected one —
 * it is the only state here that can cost someone money.
 */
export function ConnectButton({ requiredChainId = REQUIRED_CHAIN_ID, chainName = DEPLOYMENT.chainName }: { requiredChainId?: 8453 | 84532; chainName?: string }) {
  const { address, isConnected, chainId } = useAccount();
  const { connect, connectors, isPending } = useConnect();
  const connections = useConnections();
  const { disconnect } = useDisconnect();
  const { switchChain, isPending: switching } = useSwitchChain();
  const { switchConnection } = useSwitchConnection();
  const [open, setOpen] = useState(false);
  const [walletError, setWalletError] = useState<string | null>(null);
  const batchMode = useBatchMode(requiredChainId);
  // The server never knows the wallet, and wagmi can restore one before
  // hydration; render the disconnected button until hydrated so both agree.
  const hydrated = useSyncExternalStore(subscribeNever, () => true, () => false);
  // Mainnet gets the Base-guideline menu (mainnet-wallet.tsx); Testnet keeps
  // this one, with its test wallets and multi-wallet switching.
  const { isTestnet } = useAppNetwork();

  const base = "h-auto rounded-sm px-3 py-2 text-[0.8125rem] sm:px-4";
  const connectTo = (connector: (typeof connectors)[number]) => {
    setWalletError(null);
    connect({ connector }, { onSuccess: () => setOpen(false), onError: (error) => setWalletError(/reject|denied|cancel/i.test(error.message) ? "Wallet connection was cancelled. Choose a wallet to retry." : "Could not connect. Open your wallet and try again.") });
  };

  if ((!hydrated || !isConnected) && !isTestnet) return <MainnetConnect className={base} />;
  if (!hydrated || !isConnected) {
    return (
      <div className="relative">
        <DropdownMenu open={open} onOpenChange={setOpen}>
          <DropdownMenuTrigger
            disabled={!connectors.length || isPending}
            render={<Button className={`${base} bg-text hover:bg-accent text-bg border-0 font-medium`} />}
          >
            {isPending ? "Connecting…" : connectors.length ? "Connect wallet" : "No wallet found"}
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" sideOffset={8} className="border-line bg-panel grid w-auto min-w-52 gap-1 border p-2 shadow-lg ring-0">
            {connectors.map((connector) => (
              <DropdownMenuItem key={connector.uid} closeOnClick={false} onClick={() => connectTo(connector)} className="px-3 py-2">
                {connector.name}
              </DropdownMenuItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
        {isPending && <p role="status" className="text-muted mt-2 max-w-64 text-xs">Open your wallet extension to approve or cancel the connection request.</p>}
        {walletError && <p role="alert" className="text-danger mt-2 max-w-64 text-xs">{walletError}</p>}
      </div>
    );
  }

  if (chainId !== requiredChainId) {
    return (
      <div>
      <Button
        variant="destructive"
        disabled={switching}
        onClick={() => { setWalletError(null); switchChain({ chainId: requiredChainId }, { onError: () => setWalletError("Network switch was not completed. Try again in your wallet.") }); }}
        className={`${base} border-danger/50 bg-danger/10 text-danger border font-medium`}
      >
        {switching ? "Switching…" : `Switch to ${chainName}`}
      </Button>
      {walletError && <p role="alert" className="text-danger mt-2 max-w-64 text-xs">{walletError}</p>}
      </div>
    );
  }

  if (!isTestnet) return <MainnetAccount className={base} />;

  const currentConnection = connections.find((connection) =>
    connection.accounts.some((account) => account.toLowerCase() === address?.toLowerCase()),
  );
  const connectedUids = new Set(connections.map((connection) => connection.connector.uid));
  const available = connectors.filter((connector) => !connectedUids.has(connector.uid));

  const chooseAnotherAccount = async () => {
    setWalletError(null);
    try {
      const provider = (await currentConnection?.connector.getProvider()) as
        | { request(args: { method: string; params?: unknown[] }): Promise<unknown> }
        | undefined;
      if (!provider) throw new Error("Wallet provider is unavailable.");
      await provider.request({ method: "wallet_requestPermissions", params: [{ eth_accounts: {} }] });
      setOpen(false);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Open your wallet and choose another account.";
      setWalletError(/reject|denied|cancel/i.test(message) ? "Account selection was cancelled. You can try again." : "Use the account picker in your wallet.");
    }
  };

  return (
    <DropdownMenu open={open} onOpenChange={setOpen}>
      <DropdownMenuTrigger
        title={address}
        render={<Button variant="outline" className={`${base} border-line text-muted hover:border-text hover:text-text bg-transparent font-mono shadow-none hover:bg-transparent aria-expanded:bg-transparent`} />}
      >
        {shortAddress(address ?? "", 4)} ⌄
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" sideOffset={8} className="border-line bg-panel grid w-auto min-w-64 gap-1 border p-2 shadow-lg ring-0">
        <DropdownMenuGroup>
          <DropdownMenuLabel className="text-dim px-3 py-1 font-mono text-[0.72rem] tracking-wide uppercase">Connected wallets</DropdownMenuLabel>
          <div className="text-dim px-3 pb-1 text-[0.72rem]">
            {batchMode === "atomic"
              ? "Approvals batched into one confirmation"
              : batchMode === "checking"
                ? "Checking wallet batching…"
                : "Two-step approvals on this wallet"}
          </div>
          {connections.map((connection) => {
            const account = connection.accounts[0];
            const current = account.toLowerCase() === address?.toLowerCase();
            return (
              <DropdownMenuItem
                key={connection.connector.uid}
                disabled={current}
                onClick={() => switchConnection({ connector: connection.connector })}
                className="flex items-center justify-between px-3 py-2 data-disabled:opacity-60"
              >
                <span>{connection.connector.name}</span>
                <span className="font-mono text-xs">{shortAddress(account, 4)}{current ? " · active" : ""}</span>
              </DropdownMenuItem>
            );
          })}
        </DropdownMenuGroup>
        <DropdownMenuItem closeOnClick={false} onClick={() => void chooseAnotherAccount()} className="px-3 py-2">
          Choose another account
        </DropdownMenuItem>
        {available.map((connector) => (
          <DropdownMenuItem key={connector.uid} closeOnClick={false} onClick={() => connectTo(connector)} className="px-3 py-2">
            Add {connector.name}
          </DropdownMenuItem>
        ))}
        {isPending && <p role="status" className="text-muted px-3 py-1 text-xs">Open your wallet extension to approve or cancel the connection request.</p>}
        {walletError && <p role="alert" className="text-danger px-3 py-1 text-xs">{walletError}</p>}
        <DropdownMenuSeparator />
        <DropdownMenuItem
          variant="destructive"
          onClick={() => {
            if (currentConnection) disconnect({ connector: currentConnection.connector });
            else disconnect();
          }}
          className="px-3 py-2"
        >
          Disconnect active wallet
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
