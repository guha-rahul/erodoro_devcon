# Porting notes: Solana to Base

What changed moving erodoro from Anchor/Token-2022 to Solidity/B20, and why.
The payoff, the rounding conventions and the threat posture did not change. Most
of the rest did.

## Deleted, not ported

| Solana | Why it is gone |
| --- | --- |
| `programs/market/`, the Manifest fork | P and N are ERC-6909 ids; liquidity is an AMM's problem, not this protocol's |
| MagicBlock delegation, ephemeral-spl-token, session controls | Nothing on Base needs an ephemeral rollup to make an order book viable |
| `programs/test-transfer-hook/` | Transfer policies are evaluated inside the precompile. There are no hook accounts to resolve, so there is nothing to prove against a hand-rolled hook — the real `PolicyRegistry` does it |
| `multiplier_to_fixed`, `MULTIPLIER_SCALE = 1e12`, `MAX_MULTIPLIER` | Token-2022 stores the multiplier as an `f64`. B20 stores a `uint128` in WAD. The only float in the protocol, and its whole class of rounding questions, is deleted |
| `checked_mul_div_rem`'s quotient/remainder accumulation | `Math.mulDiv` carries 512 bits. See finding #5 |
| the `max_oracle_age` / `feed_max_age` inequality | The publish window is passed to Pyth as an absolute range. See finding #4 |

## Ported unchanged

`compute_pools`, `compute_redeem`, `apply_shortfall`, `effective_strike`,
`normalize_decimals`, and every rounding convention. The Rust unit tests and
proptests were ported case for case, with the same fixtures and the same names,
so a behavioural divergence between the two chains shows up as a test failure
rather than as a judgement call.

`i128` became `uint256`. The Rust's negativity guards are absent because the
type makes the condition unrepresentable, not because a check was dropped.

## Structural changes

**One vault, not one account per series.** Claims are ERC-6909 ids: `P` is
`seriesId`, `N` is `seriesId | 1`, which is why `seriesId` has its low bit
cleared. The consequence is that a seizure hits every series over that token and
must be socialised — `SECURITY.md` finding #9, and the bug that fell out of it,
finding #8.

**The creator is in the id preimage**, exactly as it became a PDA seed on Solana
after finding #2.

**The admin is a creation parameter**, so a series can be opened with the admin
surface dead from birth. The factory uses this.

**Settlement is payable.** Pyth charges to verify. "Permissionless" now means
"anyone willing to pay the fee".

**A confidence policy is mandatory for a canonical series.** The Solana preflight
declined to choose one; here `maxConfBps` is enforced on every read and the
factory refuses to list a series that disables it.

**Settlement configuration IDs are new.** On Solana the feed config account
*was* the oracle. On EVM one adapter can serve many feeds, so approving tokens,
adapters, and feeds separately lets valid pieces be recombined incorrectly.
The factory hashes the collateral, primary oracle, fallback oracle, feed, model,
fallback delay, and precision into one versioned configuration and permits only
the active configuration for that collateral.

## The one place the chain made things worse

Token-2022 keeps the pre-flip multiplier readable until it is folded. B20
computes the flipped value on read and never writes the old one back, so once
`effectiveAt` passes the pre-flip value is gone. `resolve_multiplier` could
*choose* on Solana; `resolveMultiplier` can only choose in three cases and must
**reject** in the fourth. See `SECURITY.md` finding #7.

And on Beryl there is no scheduled setter at all, so the creation-time gate that
covered every *announced* corporate action on Solana has nothing to read. The
code distinguishes "unavailable" from "nothing scheduled"; the chain does not
give it anything better to do.

## Version boundary

`seizeWithMemo` and the scheduled multiplier are **Cobalt** features. `base-forge`
installs the **Beryl** build by default. The contracts capability-probe rather
than assume, and the fork suite reports which release it found instead of
asserting one. Read the table at the top of `SECURITY.md` before reasoning about
what is defended.
