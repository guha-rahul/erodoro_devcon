# Erodoro product v2 plan

Current as of **2026-09-08**.

This plan compares the public testnet application with the proposed stock-income product. It separates implemented work from product and release decisions.

Implemented below means local source exists. It does not mean deployed, externally audited, or accepted by users.

## Evidence rules

- Display premium data only from a current funded RFQ bid.
- Display annualized premium as a simple annualized rate. Do not label it APY.
- Do not give Erodoro Points a cash value.
- Do not display partner rewards until the partner recognizes the beneficial owner.
- Do not display dividend yield separately when the B20 multiplier already includes the dividend effect.
- Keep all testnet, audit, liquidity, and mainnet notices visible.

## Current comparison

| Area | Public application | Product v2 requirement | Status |
| --- | --- | --- | --- |
| Main pitch | The page leads with premium income and testnet status. | Lead with stock income. Keep protocol terms below the product explanation. | Implemented in this phase. |
| Yield | Cards display a funded premium and term return. | Display the funded premium and simple annualized premium. | Implemented in this phase. |
| Rewards | No points or partner reward system exists. | Add a versioned points ledger and a separate partner reward ledger. | Decision and backend work remain. |
| Loyalty | No seasons, streaks, boosts, or levels exist. | Add rules after the points policy is approved. | Decision and backend work remain. |
| Discovery | The application has stock, expiry, bid, and lifecycle filters. | Rank by funded annualized premium. Add standard market groups after a maker commits. | Ranking implemented. Market groups remain. |
| Seller flow | The user locks stock, receives claims, and requests a maker bid. | Lead with amount, sell price, expiry, and cash premium. | Deposit and sale reviews implemented. Quote-before-deposit remains. |
| Buyer flow | A role switch exists, but no retail offer path exists. | Add a signed sell order or maker offer with cost, maximum loss, and break-even. | Honest blocked state implemented. Execution remains. |
| Portfolio | The route exists, but the position panel was static. | Read current claims and group them by lifecycle. Add indexed premium history later. | Grouped balances and paginated RFQ payments implemented. Persistent indexing remains. |

## Main pitch

### Implemented

- Use `Make your stocks earn.` as the primary statement.
- Explain the sell price and funded buyer before the P and N mechanism.
- Use `tokenized-stock position` instead of a permanent one-share claim.
- Add up to three active strategy cards with funded bids and links to Earn.

### Remaining

- Add a stock image only after the project confirms the asset-license policy.
- Move the detailed claim formula into an advanced section.

## Yield display

### Implemented

- Display the cash premium for one token from the funded bid.
- Display the simple annualized premium from the reference price and remaining term.
- Use the current B20 multiplier when a raw-share reference prices one share.
- State that the rate excludes fees and does not compound.
- Exclude points, dividends, and partner rewards from this rate.
- Remove expired bids and stale or low-confidence reference prices.
- Withhold the Pyth share reference for total-return markets.

### Remaining

- Add a network-fee estimate to the transaction review.
- Add the net annualized premium after the fee amount is known.
- Record the reference timestamp beside each rate.
- Add a rate-history view only after an indexer stores old executable bids.

## Rewards and points

### Implemented

- Add a Rewards route with an explicit inactive state.
- Separate Erodoro Points from partner rewards.
- List the rules that must exist before activation.
- Add tested balance-time and fill-volume accounting in `cloudflare/reward-accounting.mjs`.
- Add snapshot replay with an input hash in `cloudflare/reward-replay.mjs`.
- Reject conflicting logs and exclude direct self-fills from candidate reward volumes.

The replay command uses supplied snapshots. It does not verify chain provenance, store a ledger, or activate points.

### Decisions required

- Define the season start block and end block.
- Define the scoring unit for writers, buyers, makers, and referrals.
- Decide whether testnet actions receive an allocation.
- Decide whether rules apply retroactively.
- Define the operator that can correct the ledger.
- Define the appeal and publication process.
- Define the budget or purpose of the points program.

### Backend work

- Index split, merge, RFQ fill, settlement, and redemption events.
- Attribute P and N transfers between wallets.
- Store amount multiplied by time for eligible balances.
- Detect self-fills and direct circular transfers.
- Calculate maker uptime, funded size, and completed fills.
- Store referral ownership before the referred wallet acts.
- Publish a versioned scoring result with reproducible inputs.
- Add rate limits and Sybil-analysis signals.
- Add a correction ledger. Do not rewrite old results without a record.

### Contract work

- Do not add a transferable points token for Season 0.
- Add a reward distributor only after an external reward can enter the vault.
- Define the accounting rule for a reward that arrives after a position transfer.
- Define the accounting rule for a reward that arrives after settlement.
- Make sure that the distributor cannot move position collateral.

## Loyalty

### Decisions required

- Define a completed expiry.
- Define whether a merge before expiry breaks a streak.
- Define whether a wallet transfer moves loyalty history.
- Define the maximum loyalty multiplier.
- Define which boosted market receives the weekly multiplier.

### Implementation work

- Add a versioned season object.
- Add a wallet level from completed eligible actions.
- Add a streak from consecutive completed expiries.
- Add a boost object with one stock, sell-price range, and expiry range.
- Display the boost only after the scoring service accepts it.
- Add separate writer, buyer, maker, and referral leaderboards.
- Exclude addresses that the anti-farming process marks as ineligible.

## Market discovery

### Implemented

- Display stock, reference, sell price, distance, expiry, funded premium, annualized premium, funded size, and status.
- Filter by stock, expiry window, bid status, lifecycle, favorites, and search text.
- Rank funded markets before markets without bids.
- Add explicit sort controls and sell-price-distance filters on all screen sizes.
- Permit strategy browsing before wallet connection.

### Remaining

- Add standard expiry groups after the maker defines its supported surface.
- Add a `Boosted` filter only after a points boost is active.
- Add TVL in stock units and approximate USDC value.
- Add a contract source status after explorer verification.
- Add stock marks after the asset-license policy is complete.
- Keep the number of canonical markets within the maker-supported surface.

## Seller experience

### Implemented

- Lead the market page with `Earn on <stock>`.
- Display the sell price, reference, retained upside, funded premium, and annualized premium.
- Keep claim identifiers inside advanced details.
- Label the steps `Deposit stock` and `Sell upside`.
- Show token units, the minimum deposit, estimated deposit fees, and estimated claims.
- Review a wallet-specific quote with premium, expiry, retained claims, and settlement source.
- Remove quotes after an amount, wallet, expiry, or market change invalidates them.
- Check the quote onchain before opening the fill flow.
- Add an interactive per-token payoff graph to the market summary.
- Explain that approval, deposit, and upside sale can require separate transactions.

### Remaining

- Request an executable quote before the deposit, with a supported atomic or staged execution path.
- Bind the payoff graph to the exact sale amount in the final review.
- Recheck quote validity after any approval transaction.
- Add a one-click stock purchase only after a verified venue route exists.
- Add auto-roll only after settlement operations and maker availability are reliable.

## Buyer experience

### Implemented

- Display a separate buyer mode.
- State that the current maker bid is not a retail sell offer.
- Disable buyer execution when buyer cost and break-even do not exist.
- Keep settlement and redemption available in buyer mode.

### Remaining

- Select a buyer-liquidity design: signed seller orders, maker offers, or an order book.
- Add an executable offer source.
- Display buyer cost, maximum loss, break-even, sell price, and expiry.
- Add allowance and balance checks for the buyer payment token.
- Transfer payment and N atomically.
- Add cancellation, expiry, nonce, and partial-fill rules.
- Index buyer fills for the portfolio and points service.
- Define buyer eligibility with legal counsel.

## Portfolio

### Implemented

- Read P and N balances for all canonical series.
- Display the stock, sell price, market status, expiry, and next action.
- Separate a capped stock claim from an upside claim.
- Group positions into active, awaiting settlement, and redeemable sections.
- Read paginated RFQ payments with receipts and separate received/spent totals.
- Display the loaded block range instead of claiming lifetime earnings.
- Preserve displayed history after an older-page request fails.
- State that cost basis is unavailable and reject partial market reads.

### Remaining

- Persist RFQ history with canonical block checks and full coverage.
- Index claim transfers for cost basis and role attribution.
- Display the settlement result and estimated redemption amount.
- Display partner rewards separately from Erodoro Points.
- Add CSV export after indexed history exists.
- Add auto-roll controls after the auto-roll policy is approved.

## Work outside this product phase

- Complete an external market-maker pilot.
- Freeze the production contract and settlement scope.
- Complete an external security review.
- Put the factory administrator behind a multisig.
- Complete legal and eligibility review.
- Add production monitoring and incident procedures.
- Run one capped mainnet market through a full expiry before expansion.
