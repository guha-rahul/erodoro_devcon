# Security

## Reporting

Report suspected vulnerabilities privately. Do not open a public issue for
anything affecting funds.

## The chain-version boundary comes first

Base's B20 Asset changed shape between releases, and which release is live
decides what this protocol can defend against. **Read this before the threat
model.**

**Beryl is what is live**, established by probing `AAPLc`
(`0xb200…C2e324d24d7eEcd1fb`) on Base mainnet, not by reading a changelog:
`effectiveAt()` reverts, `SEIZE_ROLE()` reverts, `BURN_BLOCKED_ROLE()` answers.
`test_reportWhetherTheScheduledMultiplierSurfaceExists` re-establishes this on
every fork run, so the day Cobalt lands the suite says so.

| Capability | Beryl (`v1.1.0`) | Cobalt |
| --- | --- | --- |
| Multiplier setter | instant `updateMultiplier` only | scheduled `updateUIMultiplier(new, effectiveAt)`, ERC-8056 |
| Pending schedule readable | **no** — `newUIMultiplier()` / `effectiveAt()` do not exist | yes |
| Seizure | `burnBlocked` + re-mint, gated by `TRANSFER_SENDER_POLICY` | `seizeWithMemo`, gated by `SEIZE_ROLE` + seize policies |
| Disclosure bracket | `announce` | `announce` |

Two consequences, both material:

1. **On Beryl the "refuse to open across a known corporate action" gate does not
   exist.** There is no pending schedule to read, so `require_no_scheduled_change`
   has nothing to gate on. The contract probes for `effectiveAt()` and treats a
   revert as *unavailable*, not as *nothing scheduled* — but unavailable still
   means the series can be written across an action nobody can see coming.

2. **On Beryl a seizure and a transfer freeze arrive together.** `burnBlocked`
   reads the same `TRANSFER_SENDER_POLICY` that gates ordinary transfers, so to
   burn from the vault the issuer must first deny the vault under that policy —
   which simultaneously stops the vault sending collateral to redeemers. The
   Solana permanent delegate could take collateral without freezing anything.
   Here the shortfall and the frozen redemption are the same event.

`base-foundryup` installs the Beryl build by default, and `base-forge --version`
reports the Base release it reproduces. Pin it deliberately; testing against a
different release than the chain runs is testing a different protocol.

## Threat model

The collateral is a B20 Asset whose issuer holds live levers over anything held
in a vault. **This is not a protocol whose security can exceed the issuer's
honesty**, and the design says so rather than papering over it:

| Lever | What the issuer can do | What the protocol does |
| --- | --- | --- |
| seizure (`burnBlocked` / `seizeWithMemo`) | Remove collateral from a vault, at any time, with no consent | Redemption prices the shortfall proportionally instead of paying first-come (§7); `ShortfallObserved` fires on-chain |
| `pause(TRANSFER)` | Halt all transfers | `split`/`merge`/`redeem` revert loudly; `settle` still works, so a pause delays redemption rather than losing it |
| transfer policies | **Already armed.** All four scopes on `AAPLc` point at policy id 5, which today authorizes every address probed. Adding one entry is all that is required | Same as a pause, scoped to this contract. A *receiver* denial stops `split` while a *sender* denial stops `redeem` — separately, and either alone is enough to break the product |
| the multiplier | Rebase every balance for a corporate action. Instant-only on Beryl, so unannounced and unschedulable | The strike is adjusted by the same ratio at settlement (§6). The creation-time gate is unavailable on Beryl — see finding #7 |
| supply cap / `mint` | Dilute the underlying claim | Out of scope: it changes what the token is worth, not what the vault holds |

Seizure is the strongest lever. It is the one way `P` can be short at maturity
through no fault of the contract, and it belongs in the UI as a headline risk,
not a footnote.

## Findings carried over from the Solana review

Six issues were found and fixed there. Their disposition here:

### 1. `settle` could be bricked permanently — **carried over, still live**

`P` and `N` are ERC-6909 ids, and ERC-6909 has no more opinion about a holder
burning their own balance than SPL did. Gating settlement on
`pSupply == nSupply` would still let anyone strand a series forever for the cost
of one raw unit. Settlement records `supplyMismatch` and `underCollateralized`
on the `Settlement` struct and proceeds. Regression coverage in
`ErodoroVault.t.sol`.

### 2. Series addresses could be squatted — **carried over, fixed the same way**

`seriesIdFor` puts the creator in the preimage, so every creator has their own
id space and the factory's cannot be occupied by anyone else. Creation stays
permissionless; the registry decides what is canonical.
`test_seriesIdIsScopedToTheCreator`.

### 3. An oracle admin could swap a feed for a mock — **closed by construction**

`PythAdapter` has no backend selector and no admin. The `IPyth` address is
immutable and the feed id is fixed per series. Pointing a series at a different
price requires deploying a different adapter, which the factory must then
approve.

### 4. A series could be impossible to settle — **delayed fallback added**

The publish window is handed to Pyth as an absolute range
(`parsePriceFeedUpdates(min, max)`) rather than reconstructed from a delay and
two independently-validated staleness bounds. There is no longer an inequality
between three parameters that can hold at creation and fail at settlement. A
window admitting no print reverts and can be retried. If the primary window has
no valid print, the series waits through its configured recovery delay and can
use a finalized UMA assertion. This adds bond, liveness, dispute, DVM, and
resolution-rule trust instead of pretending the missing print exists.

### 5. Representable payouts could fail on intermediate overflow — **does not exist**

`Math.mulDiv` carries a full 512-bit intermediate, so the quotient/remainder
accumulation the Rust needed has no purpose. Asserted rather than assumed:
`test_mulDivHandlesLargeButRepresentableResults`.

### 6. A zero signature-verification floor was valid on-chain — **no analogue**

Pyth's EVM contract verifies Wormhole guardian signatures inside
`parsePriceFeedUpdates`; there is no threshold for a consumer to set correctly
or incorrectly. What replaces the check is confirming the adapter points at the
canonical Pyth deployment, which is a deploy-time assertion carried by
`script/Preflight.s.sol`, not a runtime one.

## Findings new to this port

### 7. A multiplier flip inside the settlement window cannot be resolved — **rejected, not guessed**

Token-2022 keeps the pre-flip multiplier in its own field until it is folded, so
the Solana code can *choose* the right one using the price timestamp. B20 Asset
computes the flipped value on read once `effectiveAt` passes and never writes
the old value back — after maturation the pre-flip multiplier is not recoverable
through the interface at all.

So `StrikeMath.resolveMultiplier` resolves the three clean cases and **reverts**
when a flip took effect strictly between the price print and the settling block.
Settlement is permissionless and the quote is caller-supplied, so rejecting
costs a resubmission with a print on the far side of the flip. Guessing would
cost one side its money.

On Beryl this case is *undetectable*: an instant `updateMultiplier` leaves no
readable schedule. That exposure is bounded by `maxPriceLag` and recorded in
`docs/known-limitations.md`. It is not defended against, because it cannot be.

### 8. A haircut redemption diluted sibling series — **found during the port, fixed**

The first version of `redeem` decremented the series' believed balance by what
it *paid*. Under a shortfall a series is paid only its share
`f = actual / tokenLocked` of what it believes it holds, so paying `paid`
discharges `paid / f` of that belief. Decrementing by the raw `paid` left the
difference behind as a phantom balance that could never pay out but stayed in
`tokenLocked` forever — permanently under-paying every *other* series written
against the same token. A sibling series would have received 0.333 of its
collateral instead of its correct 0.5, robbed by the first series' exit rather
than by the seizure.

Fixed in `_consumeBelieved` by scaling the decrement, which keeps `f` invariant
across redemptions. Regression: `test_aHaircutSeriesExitDoesNotDiluteItsSiblings`.

### 9. One address holds every series' collateral — **accepted, priced, documented**

The singleton vault means a seizure hits the collateral of every series written
against that token, not one series. The drain is socialised pro-rata across
those series before §7's within-series haircut applies.

This is not a workaround; it is the accurate model, because the issuer's lever
targets an address and not a series. But it does mean **a series is exposed to a
seizure aimed at a sibling series over the same token**, which has no Solana
counterpart and belongs in the UI as a headline risk.
`test_aDrainIsSocialisedAcrossSeriesOfTheSameToken` pins the behaviour;
`test_aDonationDoesNotInflateAnyPool` pins the other direction.

### 10. Settlement and fallback assertions cost callers money

Pyth charges a fee to verify an update, so `settle` is `payable` and a
permissionless caller must fund it. The adapter refunds any excess. This is not
a vulnerability, but it does mean "anyone can poke settlement" now means "anyone
willing to pay the fee", and a series nobody settles stays unsettled.

The UMA fallback separately requires proposal and dispute bonds. The adapter
pulls the configured total bond from the caller and UMA pays the recorded
proposer or disputer after resolution. A bond value or resolution rule that is
too weak is an economic security failure even when the Solidity behaves as
written.

### 11. The live token has 8 decimals, not 18

The B20 spec urges 18 decimals for equities so that floored dust from a deep
reverse split stays economically invisible. **`AAPLc` ships with 8.** At 8
decimals one raw unit of a ~$310 share is ~$0.0000031, which is noise today —
but a reverse split scales that up by the split ratio, and the flooring in
`toUIAmount` and in every payout is on the *scaled* view.

Nothing here is broken by it. It is recorded because it is a fact about the
issuer that contradicts the standard's own advice, and because a preflight WARN
that fires on every real deployment is worth understanding rather than clicking
past.

### 12. A strike is only meaningful in the units its series declares

The live `Equity.US.AAPL/USD` feed publishes at `expo = -5`. A series declaring
`priceDecimals = 8` is fine — the adapter normalises 5 to 8 losslessly — **but
the strike must be quoted in the series' units, not the feed's.** Quote it in
feed-native units and it is understated by 1000x, which caps P at essentially
nothing and hands the position to N.

This was a real bug in the first version of the fork suite, and the thing that
makes it dangerous is that **nothing downstream complains**: the pools still sum
to the collateral, because conservation holds for any strike. `computePools` has
no way to know a strike is nonsense. `script/Preflight.s.sol` compares the two
and warns; beyond that it is an operator discipline, and it belongs in the
runbook.

## Trust surface

**No admin can touch active collateral.** The series admin can pause and unpause
splits, and sweep dust once both claim supplies are zero. It cannot settle,
cannot change any term, and cannot move collateral out of a live series. `merge`
deliberately works while paused, so a pause can never trap collateral behind
existing claims.

**The factory has no power over a series it created** — not even to pause one.
It never takes the admin role. It controls only which parameters, oracles, feeds
and collateral may become *canonical*.

**Settlement is permissionless and callable once.** On the primary path, the
quote must carry the series' feed id, fall inside the publish window fixed at
creation, and satisfy the series' confidence policy. On the delayed path, a
proposer chooses a candidate price, posts a bond, and accepts UMA dispute and
resolution. The vault accepts it only after UMA resolves the assertion true.

**The oracle adapters cannot be repointed.** Pyth, Chainlink, Coinbase status,
and UMA dependencies are immutable. A new dependency or settlement model needs
a new adapter and canonical configuration.

## Known limitations

- **`sweepDust` takes the whole remaining share** once both supplies are zero. A
  holder who burns their claim without redeeming forfeits to the fee recipient.
  Intended, but a UI must not make burning easy to do by accident.
- **The dividend case is unsolved**, and `docs/decisions.md` §2 explains why the
  answer changed shape on this chain without getting better.
- **No external audit.** Everything above is an internal review.

## Before mainnet

`script/Preflight.s.sol` checks the live token's decimals, roles, armed
policies and pause state; that the adapter points at canonical Pyth; that no
multiplier change is scheduled before maturity where that is readable at all;
and the factory's settlement configurations. It does **not** establish that an equity market was
open, and it cannot detect an unannounced instant multiplier change.
