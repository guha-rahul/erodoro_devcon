# Settlement oracle integrations

This document records the implemented Coinbase and UMA boundaries. It does not
approve a production bond size, resolution rule, token, or feed binding.

## Coinbase stock-oracle status

`CoinbaseFeedStatus` binds one B20 token address to one Erodoro feed ID. It
calls Coinbase's `OracleRegistry.getOracleParams(token)`. The call returns the
token multiplier and the oracle pause flag in one response.

The status provider returns `false` when:

- the caller supplies a different feed ID;
- Coinbase has paused the token's oracle;
- the registry returns a zero multiplier; or
- the registry call reverts.

`ChainlinkTotalReturnAdapter` refuses settlement when this status is false.
It still applies its own first-round and timestamp checks.
The unit suite pauses the registry through a simulated 2x multiplier update,
publishes the matching total-return round, and proves settlement remains closed
until the registry is unpaused.

Base mainnet configuration verified on 2026-08-25:

| Item | Value |
| --- | --- |
| Oracle registry | `0x3f3E8cf41cdd3b1D118c16471aB0113DfDDd5CaD` |
| Method | `getOracleParams(address) returns (uint256 multiplier, bool paused)` |
| AAPLc | `0xb200000000000000000000C2e324d24d7eEcd1fb` |
| Observed AAPLc response | multiplier `1e18`, `paused=false` |

The registry reaches Base's B20 system contract to read the multiplier. Use
`base-forge`, not stock Foundry, for the Base mainnet fork test.

## UMA delayed fallback

`UmaFallbackSettlementOracle` uses UMA Optimistic Oracle V2 with the
`ASSERT_TRUTH` identifier. UMA does not return the numeric stock price. A
proposer submits a candidate price and bonds this human-readable assertion:

> The candidate price follows the configured resolution rules for the stated
> maturity, decimal scale, request ID, and attempt.

UMA resolves that assertion to true or false. A true result stores the
candidate as Erodoro's finalized price. A false result rejects it and permits a
new attempt. This prevents UMA's boolean result from being mistaken for a
price.

The adapter enforces the following sequence:

1. Wait until the series recovery time.
2. Approve the adapter to spend the configured bond token.
3. Call `proposePrice` with the precomputed request ID and candidate price.
4. During liveness, a disputer can approve the adapter and call
   `disputePrice`.
5. After UMA has a result, any account calls `finalizeProposal`.
6. The vault calls `settleFallback` only after the adapter reports a final
   accepted price.

The adapter pulls each bond only when it sends the corresponding UMA call.
UMA records the original proposer or disputer, so UMA pays the result to that
account. The adapter does not hold a settled reward.

Base Sepolia configuration verified on 2026-08-25:

| Item | Value |
| --- | --- |
| Optimistic Oracle V2 | `0x99ec530a761e68a377593888d9504002bd191717` |
| Finder | `0xfF4Ec014E3CBE8f64a95bb022F1623C6e456F7dB` |
| Identifier whitelist | `0x4da2fD75dd26A8C8A0a8Db892019651344705836` |
| Currency whitelist | `0xF2D5614BD8D6246AACa5a6841aCfCA210B0CbC19` |
| Test bond token | `0x7E6d9618Ba8a87421609352d6e711958A97e2512` |
| Identifier | `ASSERT_TRUTH` |
| Default liveness | 7,200 seconds |

The fork suite completes an undisputed proposal and finalization against the
real Base Sepolia contracts. It also posts a real dispute bond on the fork.
Unit tests cover true and false disputed resolutions and retry behavior. A fork
does not send a transaction to Base Sepolia.

## Run the integration tests

```sh
BASE_SEPOLIA_RPC_URL=https://sepolia.base.org \
  FOUNDRY_PROFILE=fork forge test --offline \
  --match-contract UmaBaseSepoliaForkTest

BASE_RPC_URL=https://mainnet.base.org \
  FOUNDRY_PROFILE=fork base-forge test --offline \
  --match-contract CoinbaseRegistryBaseForkTest
```

## Deploy

Copy the required variables from `.env.example`. Then simulate before you
broadcast:

```sh
forge script script/DeployUmaFallback.s.sol:DeployUmaFallback \
  --rpc-url "$BASE_SEPOLIA_RPC_URL"

forge script script/DeployCoinbaseFeedStatus.s.sol:DeployCoinbaseFeedStatus \
  --rpc-url "$BASE_RPC_URL"
```

Add `--broadcast` only after the simulation shows the expected chain, address,
model, decimal scale, bond, liveness, and rules. A testnet bond amount is not a
mainnet economic decision.

## Remaining release boundary

No current production deployment uses these contracts. The factory now binds
the B20 token, primary adapter, exact feed, settlement model, fallback adapter,
fallback delay, and precision as one settlement configuration.

## Sources

- [Base tokenized stocks documentation](https://docs.base.org/base-chain/asset-issuance/tokenized-stocks-on-base)
- [Verified Coinbase OracleRegistry on Base](https://base.blockscout.com/address/0x3f3E8cf41cdd3b1D118c16471aB0113DfDDd5CaD)
- [UMA Base Sepolia deployment artifact](https://github.com/UMAprotocol/protocol/blob/master/packages/core/networks/84532.json)
- [UMA Optimistic Oracle V2 implementation](https://github.com/UMAprotocol/protocol/blob/master/packages/core/contracts/optimistic-oracle-v2/implementation/OptimisticOracleV2.sol)
