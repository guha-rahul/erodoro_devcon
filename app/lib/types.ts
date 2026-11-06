/**
 * The on-chain structs, typed.
 *
 * These mirror `IErodoroVault.sol` and `Factory.sol` field for field. Solidity
 * `uint256` arrives as `bigint`, and every address is a checksummed hex string,
 * which is why nothing here is a `number` unless the contract says `uint8`.
 *
 * They exist because the markets table sorts and filters on these fields, and
 * `any` makes every one of those a silent typo away from a blank column.
 */

export type Address = `0x${string}`;
export type Hex = `0x${string}`;

/** `IErodoroVault.SeriesConfig`. Nothing here is mutable except `admin`
 *  (renounce-only) and `splitsPaused`. */
export type SeriesConfig = {
  creator: Address;
  collateral: Address;
  oracle: Address;
  fallbackOracle: Address;
  admin: Address;
  feeRecipient: Address;
  feedId: Hex;
  fallbackRequestId: Hex;
  settlementModel: number;
  /** Quoted per UI unit, in `priceDecimals`. */
  strike: bigint;
  /** WAD, captured when the series opened. */
  multiplierAtCreation: bigint;
  minSplitAmount: bigint;
  maturity: bigint;
  settlementDelay: bigint;
  maxPriceLag: bigint;
  fallbackDelay: bigint;
  /** 0 disables the confidence gate; a canonical series may not do that. */
  maxConfBps: number;
  feeBps: number;
  collateralDecimals: number;
  priceDecimals: number;
  splitsPaused: boolean;
  exists: boolean;
};

/** `IErodoroVault.Settlement`, frozen once when a series settles. */
export type Settlement = {
  price: bigint;
  effectiveStrike: bigint;
  multiplierAtSettlement: bigint;
  collateralAtSettlement: bigint;
  pSupplyAtSettlement: bigint;
  nSupplyAtSettlement: bigint;
  pPool: bigint;
  nPool: bigint;
  /** Cumulative *quoted* claim, which is what the shortfall ratio tracks. */
  pQuoted: bigint;
  nQuoted: bigint;
  /** Cumulative collateral actually paid, after any haircut. */
  pPaid: bigint;
  nPaid: bigint;
  priceTs: bigint;
  settledTs: bigint;
  settled: boolean;
  fallbackUsed: boolean;
  /** Recorded, never gated on. See SECURITY.md finding #1. */
  supplyMismatch: boolean;
  underCollateralized: boolean;
  shortfallObserved: boolean;
};

/** `Factory.SeriesRecord` — the entry that makes a series canonical. */
export type SeriesRecord = {
  seriesId: bigint;
  settlementConfigurationId: Hex;
  collateral: Address;
  oracle: Address;
  feedId: Hex;
  settlementModel: number;
  strike: bigint;
  maturity: bigint;
  index: bigint;
  priceDecimals: number;
  canonical: boolean;
};

/** A series as the UI needs it: the config, its registry entry, and its
 *  settlement if it has one. */
export type Series = {
  id: bigint;
  config: SeriesConfig;
  record: SeriesRecord | null;
  settlement: Settlement | null;
  /** Raw collateral the vault attributes to this series. */
  locked: bigint;
};

export type SeriesStatus = "Open" | "Paused" | "Settled";

export function statusOf(series: Series): SeriesStatus {
  if (series.settlement?.settled) return "Settled";
  if (series.config.splitsPaused) return "Paused";
  return "Open";
}

/** `P` is `seriesId`; `N` is the same id with its low bit set. */
export function pId(seriesId: bigint): bigint {
  return seriesId & ~1n;
}

export function nId(seriesId: bigint): bigint {
  return seriesId | 1n;
}
