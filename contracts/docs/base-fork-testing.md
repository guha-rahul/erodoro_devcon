# Local Base mainnet fork test

This suite runs erodoro against a disposable fork of Base mainnet, with Base's
real B20 precompiles hosted by `base-forge`. It does not send transactions to
Base.

## What is real

- the configured Coinbase tokenized-equity B20 Asset — its decimals, its live
  multiplier, its role assignments and any armed transfer policies;
- the canonical Pyth receiver, and a genuinely signed Hermes update verified
  through Wormhole guardian signatures inside Pyth's own contract;
- the B20 precompiles themselves. `base-anvil` does not reimplement them; it
  compiles them in from `base/base`, so a build reproduces one specific chain
  commit.

The only test controls are Foundry's `warp`, `prank` and `deal` for gas. No
oracle, token metadata or contract state is stubbed.

## Prerequisites

- `base-forge` from `base-anvil`, at a release matching the chain:

  ```sh
  curl -L https://raw.githubusercontent.com/base/base-anvil/HEAD/foundryup/install | bash
  base-foundryup                     # installs the pinned default release
  base-forge --version               # reports the Base release it reproduces
  ```

  **Pin this deliberately.** `base-forge --version` prints e.g.
  `1.6.0-v1.1.0`, where `v1.1.0` is Base **Beryl**. Testing against a different
  release than the chain runs is testing a different protocol — and the Beryl /
  Cobalt boundary changes what this protocol can defend against. See the table
  at the top of [`../SECURITY.md`](../SECURITY.md).

- a Base mainnet RPC with archive access;
- the live addresses, supplied at runtime. The suite contains **no fallback**
  RPC, token, oracle or feed addresses: an unset value fails loudly rather than
  silently testing the wrong thing.

## Configure

`.env.fork` in the repo root holds a working set, every value verified against
Base mainnet rather than copied from a doc:

```sh
export BASE_RPC_URL=https://mainnet.base.org
export BASE_COLLATERAL=0xb200000000000000000000C2e324d24d7eEcd1fb          # AAPLc, "Apple Inc.", 8 decimals
export BASE_COLLATERAL_WHALE=0x013d5349eae975bdd54fe5f70627df3e5f0cd423   # holds ~13.3 AAPLc
export BASE_PYTH=0x8250f4aF4B972684F7b336503E2D6dFeDeB1487a               # Pyth receiver on Base
export BASE_FEED_ID=0x49f6b65cb1de6b10eaf75e7c03ca029c306d0357e91b5311b175084a5ad55688
```

**Pick the feed id deliberately.** Pyth publishes `Equity.US.AAPL/USD` and
separate `.ON`, `.PRE` and `.POST` ids. The overnight book is a *different feed*,
not a wider band on this one, so binding a series to the regular-session id is
the whole of the §8 market-hours defence. Getting this wrong is silent.

The public RPC caps `eth_getLogs` at a 10,000-block range, which is enough for
everything here but not for scanning role history.

`BASE_PYTH_UPDATE` and `BASE_PYTH_PUBLISH_TIME` are fetched for you:

```sh
eval "$(script/fetch-hermes.sh "$BASE_FEED_ID")"
```

The script does not use a repeated closed-market relay. It fetches the prior
historical update and checks that `prev_publish_time < publish_time`.

The fork sets maturity to this publish time. This proves the
[Pyth uniqueness condition](https://api-reference.pyth.network/price-feeds/evm/parsePriceFeedUpdatesUnique):
`prevPublishTime < maturity <= publishTime`.

## Run

```sh
make fork-test
```

## Covered lifecycle

1. Assert the fork really is Base mainnet (`chainid == 8453`).
2. Read the live token: decimals inside B20's `[6,18]`, a valid WAD multiplier,
   the configured whale actually holds some.
3. Probe whether the ERC-8056 scheduled-multiplier surface exists, and record
   which release is live rather than assuming one.
4. Open a series before the real print, lock real forked collateral, mint P and N.
5. Settle against the signed Pyth update, inside the publish window.
6. Redeem both sides and assert collateral conservation.
7. Assert the **seizure precondition** against live state:
   `TRANSFER_SENDER_POLICY` is armed (policy id 5) but currently authorizes the
   vault, so `burnBlocked` would revert `AccountNotBlocked` for any caller.
8. Reduce the vault's **real** AAPLc balance and assert the proportional
   haircut, the `ShortfallObserved` record, and that the series retires its
   belief rather than leaving a phantom.

## Honest test boundary

**The Solana suite needed two series; this one does not.** Surfpool can only move
time forward, and a cryptographically signed price for a future timestamp cannot
be manufactured — so that suite proved the admin path on one series and
settlement on another. Here `vm.warp` moves in both directions relative to a
fetched print, so the series is opened *before* the real `publishTime` and
settled *after* it. One series, one genuinely signed quote, the whole path.

**What this still cannot establish.** That an equity market was open when the
print landed. That the confidence policy chosen is the right one. That the
issuer will not seize tomorrow. That an unannounced instant multiplier change
will not land inside a future settlement window — on a Beryl chain nothing can
establish that, which is why it is in
[`known-limitations.md`](known-limitations.md) rather than in a test.

**Step 7 skips rather than fabricating.** If `BASE_SEIZE_CALLER` is unset, or
the configured address holds neither seize path, the test skips. A seizure
proved against an address we invented proves nothing about the issuer.

## Observed run

Against block ~50,429,389 with a historical Hermes update selected by the
script:

```
live feed decimals: 5                  # Equity.US.AAPL/USD publishes at expo -5
strike (series units): 27936457200     # $279.364572, quoted in the series' 8 decimals
settlement price:      31040508000     # $310.40508
P pool: 90000000   N pool: 10000000    # 0.9 / 0.1 AAPLc, summing to the 1.0 locked
after a 50% drain -> P paid 45000000, N paid 5000000
scheduled multiplier surface: absent (Beryl)
collateral decimals: 8                 # not the 18 the B20 spec urges
```

`make preflight` against the same state: **0 fails, 7 warns.**

This is a local Base-state validation, not a deployment and not an audit.
`deployments/base.json` stays `configuration-only`.

## Oracle integration forks

`test/fork/OracleIntegrationsFork.t.sol` adds two narrower checks:

- `CoinbaseRegistryBaseForkTest` reads the live Coinbase pause registry and
  requires `base-forge`, because the registry calls the B20 system contract;
- `UmaBaseSepoliaForkTest` uses stock Foundry against Base Sepolia. It posts
  proposal and dispute bonds to the real UMA OOv2 contracts on a disposable
  fork, then finalizes an undisputed assertion.

See [`oracle-integrations.md`](oracle-integrations.md) for commands, addresses,
and the exact evidence boundary.
