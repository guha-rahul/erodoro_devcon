import { parseAbi, type Address, type Hex, type PublicClient } from "viem";

/**
 * The house wallet on mainnet is a Safe multisig. A Safe cannot be driven like
 * a key from this app: each operator action becomes one Safe batch that the
 * signers import into Safe{Wallet} (Apps → Transaction Builder → drag in the
 * file), review, sign to the threshold, and execute. The batch runs
 * atomically, so a multi-step action (approve, lock, list) either all lands
 * or none of it does.
 */

export type Call = { label: string; to: Address; data: Hex };

export const SAFE_ABI = parseAbi([
  "function getThreshold() view returns (uint256)",
  "function getOwners() view returns (address[])",
  "function VERSION() view returns (string)",
]);

export type SafeInfo = { address: Address; threshold: number; owners: Address[]; version: string };

/** The Safe at `address`, or null for a key or any other contract. */
export async function readSafe(client: PublicClient, address: Address): Promise<SafeInfo | null> {
  const code = await client.getCode({ address });
  if (!code || code === "0x") return null;
  try {
    const [threshold, owners, version] = await Promise.all([
      client.readContract({ address, abi: SAFE_ABI, functionName: "getThreshold" }),
      client.readContract({ address, abi: SAFE_ABI, functionName: "getOwners" }),
      client.readContract({ address, abi: SAFE_ABI, functionName: "VERSION" }),
    ]);
    return { address, threshold: Number(threshold), owners: [...owners], version };
  } catch { return null; }
}

/** A Safe{Wallet} Transaction Builder batch file (raw calldata, no ABI needed). */
export function safeBatch({ chainId, safe, name, calls, createdAt = Date.now() }: { chainId: number; safe: Address; name: string; calls: Call[]; createdAt?: number }) {
  return {
    version: "1.0",
    chainId: String(chainId),
    createdAt,
    meta: {
      name,
      description: calls.map((c, i) => `${i + 1}. ${c.label}`).join("\n"),
      txBuilderVersion: "1.16.5",
      createdFromSafeAddress: safe,
      createdFromOwnerAddress: "",
    },
    transactions: calls.map(c => ({ to: c.to, value: "0", data: c.data, contractMethod: null, contractInputsValues: null })),
  };
}

/** Saves the batch as a file the signers drag into Transaction Builder; returns its name. */
export function downloadSafeBatch(batch: ReturnType<typeof safeBatch>) {
  const file = `${batch.meta.name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "")}-safe-batch.json`;
  const url = URL.createObjectURL(new Blob([JSON.stringify(batch, null, 2)], { type: "application/json" }));
  const link = Object.assign(document.createElement("a"), { href: url, download: file });
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  return file;
}
