import { encodeAbiParameters, keccak256, decodeEventLog, type Address, type TransactionReceipt } from "viem";
import { MarketRipPoolAbi } from "../abis/MarketRipPool";
import { b20RevertMessage } from "../b20-errors";

export function purchaseError(cause: unknown): string {
  const text = cause instanceof Error ? cause.message : String(cause);
  if (/reject|denied|4001|cancelled/i.test(text)) return "Signing was cancelled. No new purchase was submitted. You can try again.";
  const b20 = b20RevertMessage(cause);
  if (b20) return b20;
  if (/SalesPaused/i.test(text)) return "Sales are paused for now. Nothing was charged. Your Rips are safe; try again later.";
  if (/OwnListing/i.test(text)) return "That is your own listing. Sellers cannot buy from themselves; choose another position.";
  if (/QuoteChanged/i.test(text)) return "The quote or inventory changed. Refresh the pool and review the new price before retrying.";
  if (/NoInventory/i.test(text)) return "No available liquidity at a current quote. Refresh the pool or choose another position.";
  if (/insufficient funds|exceeds the balance|gas required exceeds allowance/i.test(text)) return "Insufficient funds for payment or gas. Add the payment token and ETH, then retry.";
  // Wallet relays (e.g. MetaMask smart accounts) simulate first and refuse a purchase that would revert.
  if (/would.?revert|execution reverted/i.test(text)) return "The wallet did not send this purchase because it would fail, usually because the quote expired or changed while waiting. Nothing was charged. Refresh the pool and try again.";
  if (/fetch|network|timeout|HTTP|RPC/i.test(text) && !/Switch|wallet or network changed/.test(text)) return "The network could not confirm this request. Check the transaction link and My Rips before retrying.";
  return text.split("\n")[0].slice(0, 250) || "The purchase failed. Refresh My Rips before retrying.";
}

/** Only a successful receipt from the configured pool for this buyer is a purchase. */
export function decodePurchase(receipt: Pick<TransactionReceipt, "status" | "logs">, pool: Address, buyer: Address, expectedPaid: bigint) {
  if (receipt.status !== "success") throw new Error("The purchase transaction reverted. No claim was purchased; gas may have been spent.");
  for (const log of receipt.logs) {
    if (log.address.toLowerCase() !== pool.toLowerCase()) continue;
    try {
      const event = decodeEventLog({ abi: MarketRipPoolAbi, data: log.data, topics: log.topics });
      if (event.eventName === "RipPurchased" && event.args.buyer.toLowerCase() === buyer.toLowerCase() && event.args.usdcPaid === expectedPaid && event.args.units > 0n) return event.args;
    } catch { /* Other pool events are not a purchase. */ }
  }
  throw new Error("Transaction confirmed, but its purchase event could not be verified. Check the receipt and refresh My Rips before retrying.");
}

/** Every slice of a confirmed pack: one RipPurchased per stock, each for `slicePaid`. */
export function decodePack(receipt: Pick<TransactionReceipt, "status" | "logs">, pool: Address, buyer: Address, slicePaid: bigint, size: number) {
  if (receipt.status !== "success") throw new Error("The pack transaction reverted. Nothing was bought; gas may have been spent.");
  const slices = [];
  for (const log of receipt.logs) {
    if (log.address.toLowerCase() !== pool.toLowerCase()) continue;
    try {
      const event = decodeEventLog({ abi: MarketRipPoolAbi, data: log.data, topics: log.topics });
      if (event.eventName === "RipPurchased" && event.args.buyer.toLowerCase() === buyer.toLowerCase() && event.args.usdcPaid === slicePaid && event.args.units > 0n) slices.push(event.args);
    } catch { /* Other pool events are not a purchase. */ }
  }
  if (slices.length !== size) throw new Error("Pack confirmed, but its purchases could not be verified. Check the receipt and refresh My Rips.");
  return slices;
}

/** Same eligibility and commitment as the contract, calculated from displayed rows. */
export function inventoryCommitment(batchId: bigint, positions: { id: bigint; row: { direction: number; batchId: bigint; remainingUnits: bigint; unitsPerRip: bigint; quoteRef: `0x${string}`; quoteValidUntil: bigint; expiry: bigint } }[], now: bigint) {
  let result = keccak256(encodeAbiParameters([{ type: "uint256" }], [batchId]));
  for (const { id, row: p } of positions) {
    if (p.direction !== 0 || p.batchId === 0n || now >= p.expiry || now > p.quoteValidUntil || p.unitsPerRip === 0n || p.remainingUnits < p.unitsPerRip) continue;
    result = keccak256(encodeAbiParameters([{ type: "bytes32" }, { type: "uint256" }, { type: "uint256" }, { type: "uint256" }, { type: "bytes32" }, { type: "uint64" }], [result, id, p.remainingUnits, p.unitsPerRip, p.quoteRef, p.quoteValidUntil]));
  }
  return result;
}

type PackRow = { stock: Address; seller: Address; direction: number; batchId: bigint; remainingUnits: bigint; unitsPerRip: bigint; quoteValidUntil: bigint; expiry: bigint };

/**
 * How many $1 packs this wallet can buy right now, whatever stocks the pool's
 * random draw picks. Mirrors the pool's `_eligible`, `_blindEligible` and
 * `_packable`: a listing sells tenth-slices while it still holds a full $1.
 * Each pack takes one slice from ten different stocks, so if the
 * tenth-largest stock can supply k slices, k packs always fit.
 */
export function packsAvailable(positions: { row: PackRow }[], now: bigint, buyer: Address | null, house: Address | null, size = 10): number {
  const live = (p: PackRow) => p.batchId !== 0n && now < p.expiry && now <= p.quoteValidUntil && p.unitsPerRip !== 0n && p.remainingUnits >= p.unitsPerRip;
  const same = (a: Address | null, b: Address | null) => !!a && !!b && a.toLowerCase() === b.toLowerCase();
  const houseRow = (stock: Address) => positions.find(({ row }) => row.direction === 0 && same(row.seller, house) && same(row.stock, stock))?.row;
  const slices = new Map<string, bigint>();
  for (const { row } of positions) {
    if (row.direction !== 0 || same(row.seller, buyer) || !live(row) || row.unitsPerRip < BigInt(size)) continue;
    if (!same(row.seller, house)) {
      const h = houseRow(row.stock);
      if (!h || !live(h) || row.unitsPerRip < h.unitsPerRip) continue;
    }
    const slice = row.unitsPerRip / BigInt(size);
    const key = row.stock.toLowerCase();
    slices.set(key, (slices.get(key) ?? 0n) + (row.remainingUnits - row.unitsPerRip) / slice + 1n);
  }
  const capacity = [...slices.values()].sort((a, b) => (b > a ? 1 : b < a ? -1 : 0));
  return capacity.length < size ? 0 : Number(capacity[size - 1]);
}
