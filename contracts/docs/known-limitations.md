# Known limitations

Things this protocol does not do, cannot do, or does badly. Listed so they are
found here rather than discovered later.

## Cannot be defended against

**An unannounced instant multiplier change during a live series.** On Beryl
there is no scheduled setter and no pending schedule to read, so an issuer
calling `updateMultiplier` mid-term is invisible to the contract in advance and
unrecoverable afterwards — B20 does not retain the pre-flip value. The exposure
is bounded only by `maxPriceLag`: the narrower the publish window, the smaller
the interval in which a flip can separate the price from the multiplier. On a
Cobalt chain the scheduled path makes the *announced* case detectable and the
creation-time gate real, but the instant failsafe is retained indefinitely by
design, so this never closes completely.

**A dividend passed through as a rebase.** The protocol cannot distinguish it
from a split, and adjusting the strike moves the dividend to N — the wrong
direction against market convention, where the dividend belongs to whoever holds
the stock. See `decisions.md` §2.

**Anything the issuer does.** Seizure, pause, an armed transfer policy, a supply
change. The protocol prices what it can and records what it cannot.

## Accepted trade-offs

**A seizure is socialised across every series over the same token.** A direct
consequence of the singleton vault. A series is exposed to a seizure aimed at a
sibling. See `SECURITY.md` finding #9.

**Settlement costs a caller money.** The Pyth primary path charges an update
fee. The UMA fallback requires a proposer bond and may require a disputer bond.
"Permissionless" means anyone willing to fund the selected path. A series that
nobody settles stays unsettled and keeps its collateral locked.

**`sweepDust` takes the whole remaining share** once both supplies are zero. A
holder who burns a claim without redeeming forfeits to the fee recipient.

**A renounced admin cannot sweep dust**, ever. That is the price of renouncing
and it is deliberate.

**P and N are ERC-6909 ids, not ERC-20s.** They need `ClaimWrapper` to list on an
AMM, which is the cost side of the singleton choice. A wrapped claim is still the
same claim: wrapping insulates a holder from nothing, and a holder must unwrap
before redeeming.

## Not implemented

- **A pooled market or order book.** The RFQ contract atomically exchanges a
  signed maker quote for N. It is a narrow venue, but it does not discover a
  price or create depth. Only a project-controlled house maker has used the
  live testnet path. `src/periphery/ClaimWrapper.sol` makes a claim listable on
  an existing AMM; it does not create liquidity. See `decisions.md` §4.
- **`docs/audit-brief.md`.** The scope and priority order for an external audit
  has not been written.

**The collateral has 8 decimals, not the 18 the B20 spec urges.** Floor dust
from a deep reverse split is correspondingly more visible. See `SECURITY.md`
finding #11.

**A strike quoted in the wrong units fails silently.** The live feed is `expo
-5`; a series declaring `priceDecimals = 8` needs the strike in 8-decimal units.
Nothing downstream catches a mismatch. See finding #12.

## Untested against reality

Everything under `test/unit` and `test/invariant` runs against mocks. They prove
the math and the state machine. **They prove nothing about the issuer.**

`test/fork` has been run against live Base mainnet state — real `AAPLc`, real
Pyth, a real signed Hermes print — and passes. What it still does **not**
establish:

- **A deployed production oracle configuration.** The UMA Base Sepolia fork
  proves calls against the live OOv2 contracts. The Coinbase registry responds
  on Base mainnet. Neither result means a canonical series currently uses the
  new adapters.

- **That a real seizure behaves as modelled.** The precondition does not hold
  on-chain today: `TRANSFER_SENDER_POLICY` authorizes the vault, so
  `burnBlocked` would revert `AccountNotBlocked` for any caller. The haircut is
  therefore proven against a balance reduction produced by a test control on
  real forked collateral, and the *authority* is asserted separately by
  `test_theSeizurePreconditionDoesNotHoldToday`. The distinction is stated in
  the test rather than papered over.
- **That an equity market was open** when a print landed. Choosing the
  regular-session feed id over the `.ON` variant is the whole defence, and it is
  an operator decision, not a check.
- **Anything about Cobalt.** It is not live, so nothing here has been exercised
  against `seizeWithMemo` or the scheduled multiplier outside mocks.
