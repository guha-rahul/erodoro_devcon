# ADR 0001: Settlement price semantics

Status: Accepted on 2026-08-25. Production deployment still needs the evidence
and parameter gates in this document.

## Decision

Erodoro supports two immutable settlement models:

```text
RAW_SHARE
TOTAL_RETURN
```

Each series records one model at creation. The factory binds the collateral,
adapter, feed, model, precision, and fallback rules as one configuration.

`RAW_SHARE` uses a raw equity price. The vault adjusts the strike once with the
B20 multiplier ratio.

`TOTAL_RETURN` uses a price that already includes the multiplier. The vault
keeps the stored strike.

The normal settlement path uses the configured primary adapter. A delayed,
bonded optimistic oracle is the permanent-unsettleability defense.

The fallback has these rules:

1. The fallback cannot open before the configured primary-recovery delay.
2. Any proposer can submit the value and post the configured bond.
3. The proposal identifies the series, maturity, model, units, and resolution sources.
4. The proposal has a configured dispute period.
5. An undisputed proposal becomes the settlement value after that period.
6. A disputed proposal goes to the configured arbitration oracle.
7. The series settles only after the proposal receives a final result.
8. The series admin cannot submit a direct price override.

The production arbitration target is UMA Optimistic Oracle V2. It accepts
numeric price requests and escalates disputed proposals to the UMA DVM.

The factory approves the fallback delay, dispute period, bond, bond token, and
resolution rules. A canonical series cannot change these values after creation.

Erodoro does not cancel separated P and N claims. It does not intentionally
leave collateral locked after the primary oracle fails.

## Context

Erodoro settles each series with one oracle price and one B20 multiplier.
Those values must describe the same corporate-action state.

The current vault assumes a raw share price. It always adjusts the stored strike
with the B20 multiplier before it computes the P and N pools.

```text
effectiveStrike = ceil(strike * multiplierAtCreation / multiplierAtSettlement)
```

This equation preserves the pools after a pure split. It is not compatible with
a total-return price that already includes the multiplier.

The deployed Pyth feed is `Equity.US.AAPL/USD`. Pyth describes it as an Apple
equity price feed. Its public documentation does not define its dividend and
split adjustment policy in enough detail for production settlement.

Coinbase's Chainlink tokenized-stock feeds use a different value. Base defines
their answer as the underlying stock price multiplied by the token multiplier.
That answer is a total-return value.

## Current implementation

The repository implements both accepted model branches. `PythAdapter` uses the
unique historical selector for the first update after maturity.
`ChainlinkTotalReturnAdapter` proves that a selected round is the first round
after maturity. It also requires an operational feed-status source.

The vault has a delayed fallback entry point. It accepts only a finalized result
from the immutable fallback oracle and request id. It records fallback use in
settlement state. `UmaFallbackSettlementOracle` now connects that entry point to
UMA Optimistic Oracle V2. `CoinbaseFeedStatus` reads Coinbase's verified
`getOracleParams(address)` interface and fails closed on pause, zero multiplier,
wrong feed, or registry failure. These contracts are implemented and tested,
but the recorded Base Sepolia deployment predates them.

`ErodoroVault._quote` performs these operations in this order:

1. Read the current B20 multiplier and pending effective time.
2. Verify one oracle print inside the series settlement window.
3. Reject a multiplier flip between the print and settlement transaction.
4. Normalize the oracle price to the series precision.
5. Adjust the stored strike only for a `RAW_SHARE` series.
6. Compare the normalized price with the adjusted strike.
7. Record the price, multiplier, effective strike, and pools.

The series records its model. Creation rejects an adapter whose model does not
match the series model.

## Required invariants

Every accepted design must keep these invariants:

- Apply each corporate-action adjustment exactly once.
- Make sure the oracle price and multiplier describe the same action state.
- Bind each collateral to one approved adapter, feed, and settlement model.
- Use the signed oracle publish time as the authoritative price time.
- Reject every print outside `[maturity, maturity + maxPriceLag]`.
- Reject a print when its confidence band exceeds the series limit.
- Never replace a missing price with the current spot price.
- Keep settlement permissionless and independent from the series admin.
- Record all values needed to reproduce the frozen settlement result.
- Preserve `pPool + nPool == collateralAtSettlement`.

## Model A: raw share price

The oracle reports the raw price of one underlying share.

The vault adjusts the strike exactly once:

```text
effectiveStrike = strike * multiplierAtCreation / multiplierAtSettlement
settlementPrice = raw oracle price
```

A 2-for-1 split halves the raw price and doubles the multiplier. The effective
strike also halves, so the split does not move value between P and N.

The current Pyth adapter and vault code implement this model. Production use
needs an authoritative Pyth definition of the feed's corporate-action behavior.

## Model B: total-return price

The oracle answer already includes the B20 multiplier:

```text
settlementPrice = underlying share price * current multiplier
effectiveStrike = stored strike
```

The vault must not adjust the strike under this model. Doing both adjustments
counts the same multiplier twice and moves value between P and N.

Coinbase's Chainlink stock feeds use this value definition. Supporting those
feeds requires a new adapter and a versioned settlement model.

## Versioning requirement

Do not make an adapter replacement behind an existing series.

Each canonical settlement configuration must include these immutable fields:

```text
collateral
oracle adapter
feed identifier
settlement model: RAW_SHARE or TOTAL_RETURN
price precision
feed-status capability
configuration version
```

The factory approves the complete configuration as one unit. The configuration
ID changes when any bound field changes.

## Corporate actions

### Split and reverse split

Model A adjusts the strike by the multiplier ratio. Model B keeps the original
strike because the oracle answer already includes the ratio.

Both models must reject settlement when the price and multiplier are on
different sides of the action.

### Dividend

B20 announcements do not provide a typed action kind. The description and URI
are issuer-controlled text. Contracts must not classify a dividend by parsing
that text.

The current raw-price model treats every multiplier change like a split. A cash
dividend represented through the multiplier therefore changes the P and N
economics. This behavior is not production-ready without explicit acceptance.

The owner must select one dividend rule:

1. Block series that cross every known multiplier action.
2. Use a verified total-return feed and keep the stored strike.
3. Accept the current raw-price behavior and disclose its allocation rule.

An unannounced action remains possible. No on-chain schedule can prevent that
case on Beryl.

### Emergency multiplier change

An instant multiplier update can occur without a readable pending schedule.
The contract cannot recover the old multiplier after the update.

The production configuration must reject settlement until the oracle feed and
multiplier represent the same state. A time window alone does not prove this.

### Corporate-action pause

A feed can stop publishing during an action. A held answer must not settle a
series merely because its timestamp falls inside the allowed window.

The adapter needs an authenticated feed-status signal that distinguishes a
normal feed from a held or frozen feed. An adapter without that signal remains
blocked for production use.

## Feed states

The settlement adapter must classify a candidate print as one state:

| State | Required result |
| --- | --- |
| Normal | Accept only after all time, identity, precision, and confidence checks pass. |
| Stale | Reject when the publish time is outside the series window. |
| Wide confidence | Reject when the confidence ratio exceeds `maxConfBps`. |
| Frozen | Reject using an authenticated oracle status signal. |
| Resumed | Accept only after the price and multiplier describe the same action state. |
| Unknown status | Reject for canonical production settlement. |

The current Pyth adapter proves identity, timestamp, precision, signature, and
confidence. It does not expose an authenticated corporate-action freeze state.
Under this ADR, it is suitable for tests but blocked for production settlement.

Base states that Coinbase's Chainlink feeds hold their last answer during a
corporate action. Consumers detect this condition through stale `updatedAt`
data. The adapter must reject that held answer.

Staleness does not identify a freeze immediately. A round published just before
the pause can remain inside a short staleness limit. The production design must
either read an authenticated pause state or delay settlement beyond that limit.

## Time, confidence, and retries

The signed oracle publish time is authoritative. The block timestamp only
controls when a caller can submit settlement.

The admissible price interval is inclusive:

```text
[maturity, maturity + maxPriceLag]
```

The factory requires a nonzero confidence limit. The adapter rejects any print
whose confidence ratio exceeds that limit.

A failed settlement leaves the series unchanged. Any caller can retry with a
different valid print from the same interval.

When no valid print exists in that closed interval, the series waits through
its configured fallback delay. A bonded UMA assertion can then propose the
missing maturity price. A true result finalizes the candidate. A false result
rejects it and permits another attempt. There is no cancellation path and no
administrator-supplied price.

## Adapter decision

The choices are:

| Choice | Price model | Freeze evidence | Contract effect |
| --- | --- | --- | --- |
| Pyth only | Raw share, pending provider confirmation | No authenticated action status in the current adapter | Keep math, extend or block adapter |
| Chainlink only | Total return | Stale `updatedAt`; immediate pause detection remains open | Add adapter and skip strike adjustment |
| Versioned types | Raw share and total return | Adapter-specific | Add an immutable model to each settlement configuration |

Changing the adapter is a contract change. Configuration and UI changes alone
do not make two price models compatible.

## Exact implementation impact

The selected model changes these contract and application surfaces:

| Surface | Required change |
| --- | --- |
| `IErodoroVault.SeriesConfig` | Store an immutable settlement model when more than one model exists. |
| `ErodoroVault.CreateSeriesParams` | Include that model and place it in the series identifier. |
| `ErodoroVault._quote` | Adjust the strike only for a raw-price series. |
| `IOracleAdapter` | Define how the caller identifies a historical Chainlink round or supplies a Pyth update. |
| `Factory` | Approve one complete collateral, adapter, feed, model, and precision configuration. |
| Factory bounds | Apply confidence and time rules that the selected adapter can actually prove. |
| Deployment files | Publish each complete configuration instead of one global AAPL feed. |
| Frontend creation | Read the collateral configuration from the factory. Do not use the deployment-level feed. |
| Frontend settlement | Request data through the series adapter and model. |
| Existing deployments | Redeploy the vault and factory because the series identity and settlement behavior change. |

### Chainlink-specific constraints

The Coinbase Chainlink feeds use a 0.5 percent deviation threshold and a
24-hour heartbeat. The current factory only allows `maxPriceLag` values from ten
minutes through six hours. A quiet market can therefore produce no admissible
round under the current bounds.

A Chainlink adapter needs a historical round identifier. It must check the
round's answer, `updatedAt`, and `answeredInRound`. Reading only
`latestRoundData()` lets a later round replace the maturity round.

Chainlink's aggregator interface does not return a confidence band. The current
mandatory `maxConfBps` rule is Pyth-specific. Chainlink configurations need a
different quality rule instead of silently ignoring that field.

The official guide says the Coinbase registry contains a pause flag. The
standard aggregator interface does not return that flag. Production freeze
detection needs a documented registry read or a conservative timing rule.

### Testnet impact

Base Sepolia currently uses the Pyth path and test B20 assets. It does not prove
the Coinbase Chainlink total-return path.

A total-return testnet release needs a status-aware Chainlink test aggregator.
That aggregator must simulate normal, frozen, resumed, stale, and bad-round
states. The release evidence must label it as a test oracle.

## Test requirements

Before testnet release, tests must prove these cases:

- A raw-price split applies the multiplier once and preserves both pools.
- A raw-price reverse split applies the multiplier once and preserves both pools.
- A total-return price cannot enter a raw-price settlement path.
- A print before maturity is rejected.
- A print after `maturity + maxPriceLag` is rejected.
- A wide confidence band is rejected.
- A frozen feed is rejected using authenticated status data.
- A resumed feed is rejected while its action state differs from the multiplier.
- A resumed feed settles after both values represent the same action state.
- A wrong collateral, adapter, or feed combination cannot become canonical.

The first, second, fourth, fifth, and sixth cases already have contract tests.
The current suite also rejects a multiplier flip inside the settlement window.

## Resolved decisions

1. Erodoro supports raw-share and total-return settlement as separate models.
2. The series identifier includes the immutable settlement model.
3. A total-return series passes dividends through the oracle value.
4. A raw-share series uses only a feed with documented action semantics.
5. Each adapter must reject stale and frozen data with authenticated evidence.
6. The fallback is a delayed, bonded optimistic price with a dispute period.
7. A disputed fallback uses UMA Optimistic Oracle V2 and the UMA DVM.
8. The protocol does not use cancellation as a price-failure rule.
9. The protocol does not accept permanent lock as its intended failure rule.

## Research basis

Opyn delays option settlement before price submission. It then gives users a
dispute period before the settlement price becomes final.

Premia selects the valid price nearest expiry. It holds a pool when the oracle
is too stale. Governance can submit an override after an extended outage.

Derive settles options with a 30-minute TWAP. Its configured heartbeat rules
stop affected operations when price data becomes stale.

Polymarket uses a bonded UMA proposal. Any participant can dispute the result,
and repeated disputes go to the UMA DVM.

These systems do not cancel transferred claims because one price source misses
an update. They delay final settlement and use a controlled resolution path.

Erodoro uses the same general pattern without giving one administrator direct
control of the fallback price.

## Consequences after acceptance

The selected model determines the vault settlement branch and adapter type.
Task 3 then binds the exact configuration in the factory and frontend.

No existing series changes meaning after creation. A new semantic model requires
a new configuration version and new canonical series.

## Sources

- [Base tokenized stocks technical guide](https://docs.base.org/base-chain/asset-issuance/tokenized-stocks-on-base)
- [Base B20 specification](https://docs.base.org/base-chain/specs/reference/b20)
- [Pyth price-feed overview](https://docs.pyth.network/price-feeds/core/price-feeds)
- [Pyth price-update guide](https://docs.pyth.network/price-feeds/core/fetch-price-updates)
- [Pyth AAPL/USD feed page](https://app.pyth.com/explore/Equity.US.AAPL%2FUSD)
- [Pyth unique historical update](https://api-reference.pyth.network/price-feeds/evm/parsePriceFeedUpdatesUnique)
- [Opyn settlement and dispute flow](https://github.com/opynfinance/v2-documentation)
- [Premia oracle failure rules](https://docs.premia.blue/the-premia-protocol/concepts/oracles)
- [Derive settlement TWAP](https://docs.derive.xyz/docs/settlements)
- [Polymarket resolution flow](https://docs.polymarket.com/concepts/resolution)
- [UMA Optimistic Oracle overview](https://docs.uma.xyz/protocol-overview/how-does-umas-oracle-work)
