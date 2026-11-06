"use client";

import type { Address } from "viem";

/**
 * The stock catalog the Worker serves, and the chain constants swap routing is
 * pinned to.
 *
 * The Aerodrome routing this file used to contain is gone. Routing now comes
 * from 0x through the Worker (`app/lib/zeroex-swap.ts`), which returns
 * executable transaction data and the one address a caller may approve. What
 * remains here is the catalog shape and the two pinned constants — chain and
 * quote token — that both the Worker and the client agree on.
 */

export const SWAP_CHAIN = 8453 as const;
export const USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913" as Address;

export type CatalogToken = {
  chainId: 8453 | 84532;
  address: Address;
  symbol: string;
  name: string;
  issuer: string;
  source: string;
  sourceId: string;
  disclosures: string;
  b20?: boolean;
  notice?: string;
};

export type Catalog = {
  chainId: number;
  fetchedAt: number;
  expiresAt: number;
  partial: boolean;
  tokens: CatalogToken[];
  sources: { id: string; issuer: string; url: string; count: number; status: string }[];
};
