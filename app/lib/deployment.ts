import type { Address, Hex } from "./types";
import { SWAP_API } from "./swap-api";

/**
 * Where the contracts live, per chain.
 *
 * Mirrors `contracts/deployments/*.json`. A chain whose `vault` is `null` has
 * nothing deployed, and the UI is expected to say so rather than render an
 * address-shaped blank.
 */
export type Deployment = {
  chainId: number;
  chainName: string;
  /** `live` means the contracts exist and may be read from. */
  status: "configuration-only" | "live";
  explorer: string;
  contracts: {
    vault: Address | null;
    factory: Address | null;
    pythAdapter: Address | null;
    /** Quote settlement. Null where claims cannot be sold yet. */
    rfq: Address | null;
    /** Permissionless intent settlement. Null until the intent contract is deployed. */
    intent: Address | null;
    /** Market Rip sale and separately collateralized downside claims. */
    ripPool: Address | null;
    ripPut: Address | null;
    /** Test-asset faucet. Testnets only; null on mainnet by design. */
    faucet: Address | null;
    /** Sandbox issuer levers. Testnets only. */
    issuerControls: Address | null;
  };
  /** What offers are quoted in. */
  quote: { token: Address; symbol: string; decimals: number } | null;
  /** Known canonical ids used to make the static export reproducible when the
   *  build runner cannot reach an RPC. Refresh this after each listing. */
  staticSeries: Hex[];
  external: {
    pyth: Address;
    feedId: Hex;
    feedName: string;
    /** The live feed publishes at this exponent. A strike is NOT quoted in
     *  these units — it is quoted in the series' own `priceDecimals`, and
     *  confusing the two understates the strike by orders of magnitude. */
    feedExponent: number;
  };
};

/** The chain this build defaults to, and the one static pages are prerendered for. */
export const BUILD_CHAIN_ID = Number(process.env.NEXT_PUBLIC_CHAIN_ID ?? 84532);

/** A build-time address override belongs to the build's chain only, never to the other side of the toggle. */
const forBuild = (chainId: number, value: string | undefined) => chainId === BUILD_CHAIN_ID && value ? value as Address : undefined;

export const BASE_MAINNET: Deployment = {
  chainId: 8453,
  chainName: "Base",
  status: "configuration-only",
  explorer: "https://basescan.org",
  contracts: {
    vault: null, factory: null, pythAdapter: null, rfq: null, intent: null,
    ripPool: forBuild(8453, process.env.NEXT_PUBLIC_RIP_POOL_ADDRESS) ?? null,
    ripPut: forBuild(8453, process.env.NEXT_PUBLIC_RIP_PUT_ADDRESS) ?? null,
    faucet: null, issuerControls: null,
  },
  // Canonical USDC on Base. Market Rip stays disabled until its pool is deployed and configured.
  quote: { token: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", symbol: "USDC", decimals: 6 },
  staticSeries: [],
  external: {
    pyth: "0x8250f4aF4B972684F7b336503E2D6dFeDeB1487a",
    feedId: "0x49f6b65cb1de6b10eaf75e7c03ca029c306d0357e91b5311b175084a5ad55688",
    feedName: "Equity.US.AAPL/USD",
    feedExponent: -5,
  },
};

export const BASE_SEPOLIA: Deployment = {
  chainId: 84532,
  chainName: "Base Sepolia",
  status: "live",
  explorer: "https://sepolia.basescan.org",
  contracts: {
    vault: "0x7e63b6A2948d317ccA06d7df9437613D5249afC1",
    factory: "0x11239572b1FB70E5b3585d8B40c23D6a12691836",
    pythAdapter: "0xC01730Bf883Dc0A0e3f2bD7A5f78e72cc54b0951",
    rfq: "0x6C4d59A4521E8C542cd39F3d128f38d79D013F62",
    intent: forBuild(84532, process.env.NEXT_PUBLIC_INTENT_ADDRESS)
      ?? "0x8c63bbC4b077a73e67258A0F384186c316855Cd8",
    // The v4 Rips fixture (2026-11-01): multi-pack ripPacks, ten test stocks
    // priced from Chainlink, stand-in settlement oracle. House quotes live five
    // minutes, so packs need the quote refresher (scripts/rips-sepolia.mjs quotes).
    // Committed so the deployed site has a pool without build-time env; the env var still wins.
    ripPool: forBuild(84532, process.env.NEXT_PUBLIC_RIP_POOL_ADDRESS)
      ?? "0x1a28ada0da8fb4e876c95b203528bbbc4b73f686",
    ripPut: forBuild(84532, process.env.NEXT_PUBLIC_RIP_PUT_ADDRESS)
      ?? "0x0fa9854f8e208336c9bd5f52f052bf2e8646ff58",
    faucet: "0x20fEF2FC80e34df2F47E09116BaaC2C02D71Bc19",
    issuerControls: "0xB8C976fc5Ca761051cd0147484EE85E29d57f381",
  },
  // A mintable stand-in. Base Sepolia has canonical USDC, but a testnet
  // account has none, and a sale cannot be shown without something to pay with.
  quote: { token: "0xbD85b60dA2b9B667eb215e0F050047dBBFC46B13", symbol: "tUSDC", decimals: 6 },
  staticSeries: [
    "0x2c751c04dad65b1cfc72ad52b46bb684ca1f6f39fdf84253a5938edcc8323f4a",
    "0xb53e6c8d5eb051aac5103719fcea59b3a396aadd988c26139a8c7b6c082c5a32",
    "0xbd5bccac50f804f63eb68e09698bf8feedfbc3a71ad74aaf72eb831544aba204",
  ],
  external: {
    // Not the mainnet address. The mainnet receiver has unrelated code here,
    // so this was probed rather than copied across.
    pyth: "0xA2aa501b19aff244D90cc15a4Cf739D2725B5729",
    feedId: "0x49f6b65cb1de6b10eaf75e7c03ca029c306d0357e91b5311b175084a5ad55688",
    feedName: "Equity.US.AAPL/USD",
    feedExponent: -5,
  },
};

export const DEPLOYMENTS: Record<number, Deployment> = {
  [BASE_MAINNET.chainId]: BASE_MAINNET,
  [BASE_SEPOLIA.chainId]: BASE_SEPOLIA,
};

/** Where the header's Mainnet/Testnet toggle keeps its choice. */
export const NETWORK_STORAGE_KEY = "erodoro.network";

/** The visitor's saved network, read once per page load: switching saves and reloads. */
function savedChainId(): number | null {
  if (typeof window === "undefined") return null;
  try {
    const value = Number(localStorage.getItem(NETWORK_STORAGE_KEY));
    return value in DEPLOYMENTS ? value : null;
  } catch { return null; }
}

/** Which chain the app talks to: the saved toggle, else the build default. */
export const ACTIVE_CHAIN_ID = savedChainId() ?? BUILD_CHAIN_ID;

/**
 * The read endpoint for a chain. A local override (`NEXT_PUBLIC_RPC_URL`, e.g.
 * a fork) applies only to the build's own chain; the other chain goes through
 * the Worker's per-chain proxy in the browser and a public endpoint at build.
 */
export function rpcUrlFor(chainId: number): string {
  const mainnet = chainId === BASE_MAINNET.chainId;
  if (mainnet && process.env.NEXT_PUBLIC_BASE_MAINNET_RPC_URL) return process.env.NEXT_PUBLIC_BASE_MAINNET_RPC_URL;
  if (chainId === BUILD_CHAIN_ID && process.env.NEXT_PUBLIC_RPC_URL) return process.env.NEXT_PUBLIC_RPC_URL;
  if (typeof window === "undefined") return mainnet ? "https://mainnet.base.org" : "https://sepolia.base.org";
  return `${SWAP_API}/rpc/${mainnet ? "mainnet" : "sepolia"}`;
}

export const DEPLOYMENT: Deployment = DEPLOYMENTS[ACTIVE_CHAIN_ID] ?? BASE_SEPOLIA;

/** True once the contracts exist on the active chain and may be read from. */
export const IS_LIVE = DEPLOYMENT.status === "live" && DEPLOYMENT.contracts.vault !== null;

/** True when the active chain is a testnet, so the UI can say so out loud. */
export const IS_TESTNET = DEPLOYMENT.chainId !== BASE_MAINNET.chainId;

export function explorer(address: string): string {
  return `${DEPLOYMENT.explorer}/address/${address}`;
}

export function txExplorer(hash: string): string {
  return `${DEPLOYMENT.explorer}/tx/${hash}`;
}
