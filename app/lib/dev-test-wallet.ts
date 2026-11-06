import { createPublicClient, createWalletClient, http, toHex, type EIP1193Provider, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { base, baseSepolia } from "viem/chains";
import { injected } from "wagmi/connectors/injected";
import { ACTIVE_CHAIN_ID, BUILD_CHAIN_ID, rpcUrlFor } from "./deployment";

/**
 * Development-only embedded wallet for clicking full Base Sepolia journeys
 * without an extension. It signs locally with a throwaway test key passed to
 * `next dev` as NEXT_PUBLIC_DEV_TEST_WALLET_KEY; never set it outside local
 * development. It also runs against a local Base mainnet fork (chain 8453 with
 * NEXT_PUBLIC_RPC_URL on localhost, see scripts/rips-fork.mjs), never against
 * real mainnet. Production builds and other chains never include it. An
 * optional NEXT_PUBLIC_DEV_TEST_SELLER_KEY adds a second wallet, so a seller
 * and a buyer can both be clicked through (a seller cannot pay themselves);
 * NEXT_PUBLIC_DEV_TEST_OPERATOR_KEY adds the pool operator for /ops.
 * With the header toggle on Testnet, NEXT_PUBLIC_DEV_TEST_SEPOLIA_WALLET_KEY
 * and NEXT_PUBLIC_DEV_TEST_SEPOLIA_SELLER_KEY, when set, replace the buyer and
 * seller keys, so a fork's keys and funded Sepolia keys can share one server.
 */
export function devTestWallets() {
  if (process.env.NODE_ENV !== "development" || !walletChain()) return [];
  const sepolia = ACTIVE_CHAIN_ID === baseSepolia.id;
  return [
    devTestWallet((sepolia && process.env.NEXT_PUBLIC_DEV_TEST_SEPOLIA_WALLET_KEY || process.env.NEXT_PUBLIC_DEV_TEST_WALLET_KEY) as Hex | undefined, "erodoroDevTestWallet", "Test buyer (dev)"),
    devTestWallet((sepolia && process.env.NEXT_PUBLIC_DEV_TEST_SEPOLIA_SELLER_KEY || process.env.NEXT_PUBLIC_DEV_TEST_SELLER_KEY) as Hex | undefined, "erodoroDevTestSeller", "Test seller (dev)"),
    devTestWallet(process.env.NEXT_PUBLIC_DEV_TEST_OPERATOR_KEY as Hex | undefined, "erodoroDevTestOperator", "Test operator (dev)"),
  ].filter(c => c !== null);
}

/** The selected chain when it is Base Sepolia, or Base read from a local fork; null otherwise. */
function walletChain() {
  if (ACTIVE_CHAIN_ID === baseSepolia.id) return baseSepolia;
  const localFork = /^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?\/?$/.test(rpcUrlFor(base.id));
  return ACTIVE_CHAIN_ID === base.id && localFork ? base : null;
}

function devTestWallet(key: Hex | undefined, id: string, name: string) {
  const chain = walletChain();
  if (!key || !chain) return null;
  const account = privateKeyToAccount(key);
  // Signing needs nonce and send calls the Worker's read-only proxy refuses,
  // so the test wallet talks to the fork or the public Sepolia endpoint directly.
  const transport = http(chain.id === base.id ? rpcUrlFor(base.id)
    : BUILD_CHAIN_ID === baseSepolia.id && process.env.NEXT_PUBLIC_RPC_URL || "https://sepolia.base.org");
  const reader = createPublicClient({ chain, transport });
  const signer = createWalletClient({ account, chain, transport });
  const chainId = toHex(chain.id);

  const provider = {
    on: () => provider,
    removeListener: () => provider,
    async request({ method, params }: { method: string; params?: unknown[] }) {
      switch (method) {
        case "eth_requestAccounts":
        case "eth_accounts":
          return [account.address];
        case "eth_chainId":
          return chainId;
        case "wallet_requestPermissions":
        case "wallet_getPermissions":
          return [{ parentCapability: "eth_accounts" }];
        case "wallet_revokePermissions":
          return null;
        case "wallet_switchEthereumChain": {
          const [{ chainId: wanted }] = params as [{ chainId: string }];
          if (wanted !== chainId) throw Object.assign(new Error(`The test wallet only uses ${chain.name}.`), { code: 4902 });
          return null;
        }
        case "eth_sendTransaction": {
          const [tx] = params as [{ to: Hex; data?: Hex; value?: Hex; gas?: Hex }];
          return signer.sendTransaction({ to: tx.to, data: tx.data, value: tx.value ? BigInt(tx.value) : undefined, gas: tx.gas ? BigInt(tx.gas) : undefined });
        }
        case "personal_sign": {
          const [message] = params as [Hex];
          return account.signMessage({ message: { raw: message } });
        }
        case "eth_signTypedData_v4": {
          const [, typed] = params as [Hex, string];
          return account.signTypedData(JSON.parse(typed));
        }
        default:
          return reader.request({ method, params } as never);
      }
    },
  } as unknown as EIP1193Provider;

  return injected({ target: { id, name, provider }, shimDisconnect: true });
}
