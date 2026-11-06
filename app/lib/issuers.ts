import type { Address } from "./types";

export type IssuerAsset = {
  /** The B20 token. This, not the ticker, is the identity. */
  token: Address;
  /** Chainlink feed for this token, where one exists. */
  chainlinkFeed: Address | null;
  /** Mutable metadata. An issuer can rename a token; it is still the same token. */
  symbol: string;
  name: string;
  issuer: string;
  decimals: number;
  /** Testnet stand-ins are not securities and must never be presented as one. */
  isTestAsset?: boolean;
  /** Issuer's own page for this asset. Left unset rather than guessed — a
   *  wrong link here sends someone to the wrong product's disclosures. */
  productUrl?: string;
  /** Where the issuer publishes splits and other corporate actions. */
  corporateActionsUrl?: string;
};

/**
 * The stock universe.
 *
 * Only the tokenized stocks that are publicly launched, not every contract that
 * appears in a developer document. Adding an asset here does not list a market:
 * the factory remains the authority on which exact token and feed are canonical.
 *
 * Every address below was read off the chain, not copied from a page. The
 * decimals matter — the token standard urges 18 for equities so that floored
 * dust from a reverse split stays invisible, and these ship with 8.
 *
 * The Chainlink feeds report a **total return value**: the underlying market
 * price multiplied by the B20 multiplier. That is not the same number as a raw
 * share price, and it is not interchangeable with one — see `todo.md`.
 */
const ASSETS: readonly IssuerAsset[] = [
  {
    token: "0xb200000000000000000000C2e324d24d7eEcd1fb",
    chainlinkFeed: "0x787f13dEa48Db0897CbCDD985de77809D837F988",
    symbol: "AAPLc",
    name: "Apple",
    issuer: "Coinbase, custodied by Alpaca under ADGM",
    decimals: 8,
  },
  {
    token: "0xb20000000000000000000078ee7ce2fE4908108C",
    chainlinkFeed: "0x04689a41629776563E6822F76f2e57D148d28513",
    symbol: "NVDAc",
    name: "NVIDIA",
    issuer: "Coinbase, custodied by Alpaca under ADGM",
    decimals: 8,
  },
  {
    token: "0xb2000000000000000000008bC8786B856E61707C",
    chainlinkFeed: "0x6526aE6797A76123638b863AeE4dD27Ba4E4b27D",
    symbol: "METAc",
    name: "Meta",
    issuer: "Coinbase, custodied by Alpaca under ADGM",
    decimals: 8,
  },
  {
    token: "0xb2000000000000000000002D0BA3164cc74f58B7",
    chainlinkFeed: "0x5bF49E0ffA937CE2FfF033c739aD7C634c4D34F2",
    symbol: "GOOGLc",
    name: "Alphabet",
    issuer: "Coinbase, custodied by Alpaca under ADGM",
    decimals: 8,
  },
  {
    token: "0xb200000000000000000000c0905DA289A389fAb6",
    chainlinkFeed: null,
    symbol: "tAAPLc",
    name: "Apple (test)",
    issuer: "Test asset, minted for integration work. Not a security.",
    decimals: 8,
    isTestAsset: true,
  },
] as const;

/** The issuer's own onchain registry of tokenized stocks. */
export const STOCK_REGISTRY: Address = "0x3f3E8cf41cdd3b1D118c16471aB0113DfDDd5CaD";

const BY_TOKEN = new Map(ASSETS.map((a) => [a.token.toLowerCase(), a]));

/** Look up by address. Never by ticker — tickers are metadata and can change. */
export function assetFor(token: string): IssuerAsset | null {
  return BY_TOKEN.get(token.toLowerCase()) ?? null;
}

export function listedAssets(): readonly IssuerAsset[] {
  return ASSETS;
}

/** The publicly launched stocks, excluding testnet stand-ins. */
export function productionAssets(): readonly IssuerAsset[] {
  return ASSETS.filter((a) => !a.isTestAsset);
}
