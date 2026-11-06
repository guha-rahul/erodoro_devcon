import type { Quote, QuoteRequest } from "./use-rfq";

const ZERO = "0x0000000000000000000000000000000000000000";

/** Display guard only. Signature, funding, and allowance checks remain onchain. */
export function quoteMatches(quote: Quote, request: QuoteRequest, now: bigint, maturity: bigint): boolean {
  try {
    return now > 0n && maturity > now && request.claimAmount > 0n &&
      [quote.claimId, quote.claimAmount, quote.quoteAmount, quote.expiry].every((value) => typeof value === "string" && /^(0|[1-9][0-9]*)$/.test(value)) &&
      (quote.taker.toLowerCase() === request.taker.toLowerCase() || quote.taker === ZERO) &&
      quote.claims.toLowerCase() === request.claims.toLowerCase() &&
      quote.quoteToken.toLowerCase() === request.quoteToken.toLowerCase() &&
      BigInt(quote.claimId) === request.claimId && BigInt(quote.claimAmount) === request.claimAmount &&
      BigInt(quote.quoteAmount) > 0n && BigInt(quote.expiry) > now;
  } catch {
    return false;
  }
}
