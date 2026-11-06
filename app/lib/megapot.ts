import { parseAbi, stringToHex } from "viem";
import type { Address, Hex } from "./types";

/**
 * Megapot — the on-chain jackpot on Base.
 *
 * Erodoro's sellers get paid a premium in USDC for the upside they sell. This
 * module is the seam that lets that cash buy Megapot tickets, so a seller can
 * take a shot at the jackpot instead of letting the premium idle.
 *
 * It is mainnet-only by construction: the deployed Megapot protocol lives on
 * Base mainnet (8453), and Erodoro's mainnet quote token is canonical USDC —
 * the same token Jackpot pulls. The testnet addresses are kept so the module
 * can be read and unit-tested without a mainnet wallet, but a purchase is
 * refused anywhere but 8453.
 */
export const MEGAPOT_CHAIN_ID = 8453 as const;

/** USDC has six decimals wherever Megapot is deployed. */
export const USDC_DECIMALS = 6;

/** One immediate `buyTickets` call can mint at most this many random tickets. */
export const MAX_IMMEDIATE_TICKETS = 10n;

export type MegapotDeployment = {
  chainId: number;
  /** The token Jackpot pulls. Canonical USDC on mainnet. */
  usdc: Address;
  /** Core lottery: ticket price, drawing state, referrals, LP deposits. */
  jackpot: Address;
  /** Quick-pick buyer that mints up to ten random tickets in one call. */
  randomTicketBuyer: Address;
  /** Position reads for liquidity backers. */
  lpManager: Address;
};

export const MEGAPOT: Record<number, MegapotDeployment> = {
  [MEGAPOT_CHAIN_ID]: {
    chainId: MEGAPOT_CHAIN_ID,
    usdc: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
    jackpot: "0x3bAe643002069dBCbcd62B1A4eb4C4A397d042a2",
    randomTicketBuyer: "0xb9560b43b91dE2c1DaF5dfbb76b2CFcDaFc13aBd",
    lpManager: "0xE63E54DF82d894396B885CE498F828f2454d9dCf",
  },
  84532: {
    chainId: 84532,
    usdc: "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
    jackpot: "0x465dA3c859f193A3807386387bEE941B2A4c3279",
    randomTicketBuyer: "0x53c04e7e5044B28Ea8A4F9c4b26E3Ac1aeb63746",
    lpManager: "0x36408921aB820305F109150003C0F90aE1CB1766",
  },
};

export function megapotFor(chainId: number): MegapotDeployment | null {
  return MEGAPOT[chainId] ?? null;
}

/**
 * On-chain analytics tag, so ticket volume bought from Erodoro is attributable.
 * Telemetry only — it never moves money.
 */
export const MEGAPOT_SOURCE: Hex = stringToHex("erodoro", { size: 32 });

/**
 * How many tickets a budget buys, capped at the immediate-purchase limit.
 *
 * Integer division is the point: a premium that does not cover a whole ticket
 * buys none rather than rounding someone into spending more than they have.
 */
export function ticketsForBudget(budget: bigint, ticketPrice: bigint): bigint {
  if (ticketPrice <= 0n || budget <= 0n) return 0n;
  const affordable = budget / ticketPrice;
  return affordable > MAX_IMMEDIATE_TICKETS ? MAX_IMMEDIATE_TICKETS : affordable;
}

/** The referrer wallet that earns on each purchase, if one is configured. */
export function megapotReferrer(): Address | null {
  const raw = process.env.NEXT_PUBLIC_MEGAPOT_REFERRER;
  return raw && /^0x[0-9a-fA-F]{40}$/.test(raw) ? (raw as Address) : null;
}

/** `referrers` / `referralSplit` in the shapes `buyTickets` expects. */
export function referralArguments(): { referrers: Address[]; split: bigint[] } {
  const referrer = megapotReferrer();
  // The split weights are 1e18-scaled and must sum to exactly 1e18.
  return referrer ? { referrers: [referrer], split: [10n ** 18n] } : { referrers: [], split: [] };
}

/** The Jackpot reads this integration needs, and nothing else. */
export const MegapotJackpotAbi = parseAbi([
  "function ticketPrice() view returns (uint256)",
  "function currentDrawingId() view returns (uint256)",
  "function getDrawingState(uint256 _drawingId) view returns ((uint256 prizePool, uint256 ticketPrice, uint256 edgePerTicket, uint256 referralWinShare, uint256 referralFee, uint256 globalTicketsBought, uint256 lpEarnings, uint256 drawingTime, uint256 winningTicket, uint8 ballMax, uint8 bonusballMax, address payoutCalculator, bool jackpotLock))",
]);

/** Quick-pick purchase: `_count` random tickets, no number selection. */
export const MegapotRandomBuyerAbi = parseAbi([
  "function buyTickets(uint256 _count, address _recipient, address[] _referrers, uint256[] _referralSplitBps, bytes32 _source) returns (uint256[] ticketIds)",
  "event RandomTicketsBought(address indexed recipient, uint256 indexed drawingId, uint256 count, uint256 cost, uint256[] ticketIds)",
]);
