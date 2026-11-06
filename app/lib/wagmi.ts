import { createConfig, http } from "wagmi";
import { base, baseSepolia } from "wagmi/chains";
import { injected } from "wagmi/connectors/injected";
import { baseAccount } from "wagmi/connectors/baseAccount";
import { ACTIVE_CHAIN_ID, rpcUrlFor } from "./deployment";
import { devTestWallets } from "./dev-test-wallet";

/**
 * Wallet configuration.
 *
 * Browser-extension wallets stay the default. Base Account is offered beside
 * them for passkey/social onboarding and EIP-5792 atomic batching; it is never
 * selected on the user's behalf, so nobody is silently moved off the wallet
 * they already trust.
 */
export const wagmiConfig = createConfig({
  // Base blocks every ~2s; the 4s default made every receipt wait up to two extra blocks.
  pollingInterval: 1_000,
  chains: [baseSepolia, base],
  connectors: [
    injected(),
    // Base Account attributes its calls with a deterministic ERC-8021 suffix
    // derived from the app origin, so Smart Wallet activity is credited even
    // before a Builder Code is registered. Its own analytics stay off: no
    // visitor data goes to Coinbase until a wallet is actually used.
    baseAccount({ appName: "Erodoro", preference: { attribution: { auto: true }, telemetry: false } }),
    // Local Base Sepolia development only; null everywhere else.
    ...devTestWallets(),
  ],
  transports: {
    [baseSepolia.id]: http(rpcUrlFor(baseSepolia.id)),
    [base.id]: http(rpcUrlFor(base.id)),
  },
  ssr: true,
});

/** The chain Earn/vault writes must be on. Stock swaps separately pin 8453.
 *  A wallet on anything else is asked to
 *  switch before it can sign, because a transaction sent to the wrong chain is
 *  not recoverable by the app. */
export const REQUIRED_CHAIN_ID: (typeof wagmiConfig)["chains"][number]["id"] =
  ACTIVE_CHAIN_ID === base.id ? base.id : baseSepolia.id;

declare module "wagmi" {
  interface Register {
    config: typeof wagmiConfig;
  }
}
