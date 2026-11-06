import type { Address } from "viem";
import deployment from "./ethglobal-deployment.json";
import type { ResalePool } from "./resale";

/** The Base Sepolia World ID registry, CRE oracle and Uniswap resale pools (app/scripts/sync-ethglobal.mjs). */
export const ETHGLOBAL = deployment as {
  pool: Address;
  registry: Address;
  oracle: Address;
  hook: Address;
  uniswap: { poolManager: Address; universalRouter: Address; v4Quoter: Address; stateView: Address; permit2: Address };
  resale: Record<string, Omit<ResalePool, "hook">>;
};

/** The resale pool for a position of the configured Rips pool, if it has one. */
export function resalePoolFor(pool: Address | null, positionId: string): ResalePool | null {
  const entry = pool && pool.toLowerCase() === ETHGLOBAL.pool.toLowerCase() ? ETHGLOBAL.resale[positionId] : undefined;
  return entry ? { ...entry, hook: ETHGLOBAL.hook } : null;
}
