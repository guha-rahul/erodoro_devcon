# Decisions

The four questions the Solana plan called "change the contract, not just the
copy" were settled there. Here is where each one lands on Base, and which
answers had to change.

## 1. Does the admin survive?

**Yes, on a minimal surface, chosen per series at creation.**

Unchanged in substance. The admin can pause and unpause splits, and sweep dust
once both claim supplies are zero. That is the entire surface: it cannot settle,
cannot change any term, and has no path to active collateral. `merge`
deliberately works while paused, so a pause can never trap collateral behind
existing claims.

One improvement over the Solana version: the admin is a **creation parameter**
rather than always the creator. Passing `address(0)` opens a series with the
admin surface dead from birth, which is what the factory does for a canonical
series whose terms nobody should be able to touch. `renounceAdmin` still exists
for the series that start with one.

The cost of renouncing is that residual dust can never be swept — it stays in
the vault forever. That is the right direction for a trade of convenience
against trust, and it is why renouncing is offered rather than forced.

## 2. Dividend policy

**Resolved through versioned settlement models.**

The Solana note said flatly: *"There is no field, event, or flag on the mint that
says 'this rebase was a dividend.'"* On Base that sentence is no longer literally
true, and it is worth being precise about what that does and does not buy.

B20 has `announce(internalCalls, id, description, uri)`, which brackets a
multiplier update between `Announcement` and `EndAnnouncement` events carrying an
id, a description and a disclosure URI. The spec goes further: effects emitted
*outside* a bracket "should be flagged as emergency overrides."

So there **is** now an on-chain, issuer-signed record attached to a corporate
action. What there is not is a *typed discriminator*. The id and description are
free text the issuer writes. A contract cannot branch on them without trusting a
string parse, and a protocol that settles real money on a string parse has
invented a new attack surface rather than closed one.

What did improve: the deprecated instant `updateMultiplier` emits a distinct
legacy event and lands outside any bracket, so an emergency override is
**detectable** even though it is not preventable. That fits the same
record-don't-gate posture §7 already takes.

What got worse: on Beryl there is no scheduled setter at all, so the conservative
half of the Solana answer — refuse to open a series when a change is already
scheduled — cannot be enforced. `StrikeMath.requireNoScheduledChange` is written
and tested, and it is a no-op on a chain that cannot answer `effectiveAt()`. The
gate is *unavailable*, which is different from passing, and the contract
distinguishes the two.

`TOTAL_RETURN` keeps the stored strike. A verified total-return oracle value
therefore passes the multiplier effect through the settlement price.

`RAW_SHARE` adjusts the strike with the multiplier ratio. A canonical raw-share
configuration is allowed only when the feed provider documents the required
corporate-action semantics. The UI must show the model used by each series.

## 3. Which ticker first

**Undecided, and deliberately not decided here.** The choice should follow depth
for the P/N pair rather than the popularity of the underlying. Coinbase's
`AAPLc` is the worked example throughout the tests because it is the shape that
was verified, not because it is the recommendation.

Blocked on measured depth for a P/N pair, which does not exist until something
is listed. See §4.

## 4. Where does N liquidity come from?

**Unsolved. This is the real risk to the product, and no amount of contract work
touches it.** Unchanged from Solana, and the chain does not change it.

If anything Base makes the *comparison* sharper rather than the problem easier:
`P` and `N` are ERC-6909 ids, so listing them on Aerodrome or Uniswap needs the
ERC-20 wrapper in `src/periphery/`, and a wrapper with no depth behind it is the
same nothing it was before.

**Pilot hypothesis: one external RFQ maker quotes N for a narrow market.** The
pilot limits the stock, strike range and expiry range. This approach remains a
hypothesis until a maker returns funded quotes and describes its hedge path.
The required evidence is in [`../../docs/market-validation.md`](../../docs/market-validation.md).

## Decisions specific to this port

**A singleton vault, and therefore socialised seizures.** One contract holds
every series' collateral, so a seizure is shared pro-rata across every series
written against that token. Accepted because it is the accurate model — the
issuer's lever targets an address, not a series — but it introduces an exposure
with no Solana counterpart. See `SECURITY.md` finding #9.

**The quality policy is adapter-specific.** A canonical Pyth series requires a
nonzero `maxConfBps`. Chainlink does not publish a confidence band, so its
total-return adapter requires that field to be zero and instead checks round
ordering, timestamps, and an authenticated operational-status source.

**Reject rather than resolve on a multiplier flip inside the settlement window.**
Forced by the chain: B20 does not keep the pre-flip value. See `SECURITY.md`
finding #7.

**Rounding still favours P.** Unchanged. P is the senior claim, so where a
rounding choice moves value between the sides it moves it to P: the normalized
price floors and the effective strike ceilings. Both are asserted in tests
rather than left to emerge.

**Settlement records rather than gates.** Unchanged, and for the same reason:
reverting would let anyone strand a series permanently by burning one raw unit
of a claim.

**Creation is permissionless; the registry decides what is canonical.** Unchanged.
Front ends must list from `Factory.canonicalSeries()` and never from the vault at
large.
