# erodoro-base

**Tokenized-equity upside markets on Base, powered by B20.**

Lock an eligible tokenized equity, choose a strike and expiry, and offer the
upside to someone else for cash.

This is the Base port of [erodoro](../erodoro-protocol), which runs on Solana
against Backed's xStocks. The payoff, the rounding conventions and the threat
posture are the same. What changed, and why, is in
[`docs/porting-notes.md`](docs/porting-notes.md).

## What it does

Lock 1 tokenized equity worth $400. Pick a $500 strike and an expiry. You get
back two claims — `P` and `N` — and sell `N` for cash. At expiry the locked
collateral is split between the two sides against an oracle price:

| Collateral at expiry | `P` receives | `N` receives |
| --- | --- | --- |
| $250 | all of it — $250 | nothing |
| $400 | all of it — $400 | nothing |
| $600 | $500 worth | $100 worth |
| $1000 | $500 worth | $500 worth |

`P` is a capped equity claim. `N` is the upside above the strike and can expire
worthless. In traditional terms the `P` holder has written a covered call and
the `N` holder owns it.

That table is a test, not a diagram — `test_readmeTableThroughTheVault` drives
all four rows through the deployed contract.

> [!IMPORTANT]
> **This is not downside protection.** Below the entry price the `P` holder
> takes the full fall in the collateral. The cash received from selling `N` is
> the only offset. Any interface that implies otherwise is wrong.

## Why it is not trivial

The collateral is a B20 Asset whose issuer holds live levers over anything
sitting in a vault. Three of them need code:

- **the multiplier** — a stock split rebases every balance. Settle a post-split
  price against a pre-split strike and `N` is wiped out by an event in which
  nobody lost money. The strike is adjusted by the same ratio [§6].
- **seizure** — the issuer can take collateral out of a *settled* vault. No
  check prevents it, so redemption prices the shortfall proportionally instead
  of paying first-come-first-served [§7].
- **transfer policies** — dormant today, armable by the issuer's admin without
  redeploying anything. Every collateral movement is subject to them.

Plus pausing and supply caps, which need no code but do need saying out loud.
See [`SECURITY.md`](SECURITY.md).

## Layout

```
src/libraries/    payout math, strike adjustment, the error table
src/oracle/       Pyth and Chainlink adapters, Coinbase status, UMA fallback
src/ErodoroVault.sol   the singleton vault; claims are ERC-6909 ids
src/Factory.sol   policy bounds, allowlists, canonical registry
src/periphery/    ERC-20 wrapper, so a claim can list on an AMM
test/unit/        lifecycle, corporate actions, shortfall — on mocks
test/invariant/   the property suite, ported from the Rust proptests
test/fork/        the same lifecycle against real Base mainnet state
```

## Build and test

```sh
forge test                    # mocks, no RPC — the CI gate
base-forge test               # same, with Base's real precompiles in-process
make fork-test                # against live Base state; see docs/base-fork-testing.md
```

`forge test` proves the math. Only the fork suite proves anything about the
*issuer* — see [`docs/base-fork-testing.md`](docs/base-fork-testing.md) for
what that suite treats as real and what it cannot establish.

## The catch nobody has solved

The contract works perfectly with zero users. **The product does not.**

The `P` holder's entire compensation for capping their upside is the cash from
selling `N` — and that only exists if somebody wants to buy `N`. Nobody has
committed to. That is not an engineering problem and no amount of code fixes
it. It is recorded in [`docs/decisions.md`](docs/decisions.md) rather than
buried.

## Status

No Erodoro contracts are deployed on Base mainnet;
`deployments/base.json` is configuration-only. A Base Sepolia integration
deployment is live with test assets, a completed lifecycle and test RFQ evidence
recorded in `deployments/base-sepolia.json`.

The current source also contains the Coinbase oracle-status provider and UMA
Optimistic Oracle V2 fallback. Their verified addresses, behavior, tests, and
deployment commands are in
[`docs/oracle-integrations.md`](docs/oracle-integrations.md). They are not part
of the older recorded Sepolia deployment.

There has been no external audit. [`SECURITY.md`](SECURITY.md) is an internal
review, and the parts believed weakest are listed there rather than omitted. See
the repository [`status.md`](../status.md) for the current evidence boundary and
release blockers.
