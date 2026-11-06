# Rips on Base mainnet

What is ready in code, how to launch, and what still needs a decision or a person.

## Stocks

`node scripts/base-stocks.mjs` reads Base's list (`brand.base.org/api/stocks`), Chainlink's Base feed directory and Pyth's US equity feeds, checks every token on chain, and writes `contracts/deployments/base-stocks.json` and `app/lib/rips/base-stocks.ts`. Checked 2026-10-11:

| | Count | Settles on |
| --- | --- | --- |
| Coinbase tokenized stocks on Base | 127 | all live, 8 decimals, registered and unpaused in Coinbase's oracle registry |
| with a Chainlink "Coinbase TICKER" feed | 12 | `ChainlinkTotalReturnAdapter` (TOTAL_RETURN), market hours `us_equities_24/5` |
| with only a Pyth `Equity.US.TICKER/USD` feed | 84 | not listed: Hermes needs a paid Pyth API key since 2026-08-26 |
| with neither | 31 | not listed |

**Rips lists the 12 Chainlink stocks on mainnet:** NVDA, META, AAPL, GOOGL, AMZN, MSFT, MSTR, SNDK, SPCX, TSLA, CRCL and INTC. The pool accepts only TOTAL_RETURN series, the app prices only these (`RIPS_STOCKS`), and reading them needs no key. To add Pyth stocks later:

- buy a Pyth key;
- allow RAW_SHARE in `_validateBacking` again;
- re-run the fork test against Pyth's upgraded contracts.

Base's page counts 127, not 250+. Chainlink also has a `Coinbase COIN` feed with no Base token.

Coinbase's own `api.coinbase.com/v1/tokenized-stocks` returns the same 127 tokens. Other issuers also have stock tokens on Base:

- **Dinari dShares.** Dinari's docs list Base, and its 24/5 list has 714 tickers. The production `DShareFactory` on Base is `0xBCE6410A175a1C9B1a25D38d7e1A900F8393BC4D`, per Dinari's `sbt-contracts` releases. Its upgraded implementation no longer answers `getDShares()`. The Base addresses therefore have to come from its `DShareAdded` logs, which need an archive or log-capable RPC or a Basescan key, or from Dinari's API.
- **dShares cannot be collateral today.** dShares are not B20 Assets. The vault rejects any collateral without `multiplier()` (`InvalidCollateral`). Supporting them needs a dShare split adapter and its own review.
- **xStocks.** The Ethereum AAPLx address has no code on Base, and no Base deployment was found.

## What the contracts enforce

- **Market-hours expiry.** `createBatch(expiry)` takes an expiry 7 to 45 days out. `scripts/lib/market-expiry.mjs` picks Tuesday to Thursday at 18:00 UTC and skips NYSE holidays. Its holiday table ends in 2027.
- **Fallback on mainnet.** On chain 8453 the pool refuses a series without a fallback oracle, so a feed that stays silent after maturity can still settle through `settleFallback`.
- **Seller price floor.** Blind buys never pay a seller more than the house quote, and nothing sells blind while a stock's house quote is stale (for example, a weekend).
- **Minimum listing.** A listing must hold $5 at the house quote.
- **Pause and quoter.** A quoter hot key refreshes quotes and can pause. Only the operator multisig resumes.
- **Size.** `MarketRipPool` compiles with 2,000 optimizer runs to stay at about 21.6 KB, under the 24 KB limit (`foundry.toml`).
- **Fork dry run.** `test/fork/RipsMainnetFork.t.sol` runs ten real stocks, their Chainlink feeds, Coinbase's registry, real USDC, a $1 pack, fallback settlement and redemption:

```sh
BASE_RPC_URL=https://mainnet.base.org FOUNDRY_PROFILE=fork base-forge test --match-contract RipsMainnetFork
```

## Launch order

1. Deploy `ErodoroVault` and `Factory` at HEAD. The recorded mainnet vault in `deployments/base.json` is older bytecode. Set the factory admin to the multisig and set the horizon bounds to 7 to 45 days.
2. For each stock, deploy its oracle binding and register a settlement configuration with a fallback oracle:
   - Each of the 12 stocks gets a `CoinbaseFeedStatus` plus a `ChainlinkTotalReturnAdapter`.
   - Fallback: `DeployUmaFallback.s.sol` now runs on 8453. The Base mainnet UMA Optimistic Oracle address, bond currency, bond and liveness are still to be chosen and verified.
3. Run `DeployMarketRip.s.sol` with `ERODORO_OPERATOR_ADDRESS` set to the multisig. Then, from the multisig, call `setQuoter(hotKey)`.
4. Seed a batch:
   - Choose the expiry with the helper.
   - Create one series per stock, with `maturity = expiry` and the series admin set to the multisig.
   - Split the house stock and `addPosition`, then `activateBatch`.
5. Run the quote refresher with the quoter key. Quotes live 5 minutes. Skip a stock whose feed is stale or whose market is closed.
6. Build the app:
   - Set `NEXT_PUBLIC_CHAIN_ID=8453`, `NEXT_PUBLIC_RIP_POOL_ADDRESS`, `NEXT_PUBLIC_RIP_DEPLOY_BLOCK` and `NEXT_PUBLIC_BASE_MAINNET_RPC_URL`.

## Buy stocks routing (0x, checked 2026-10-12)

$100 of USDC into each of the 127 stocks through 0x:

- 10 are refused by 0x itself ("not authorized for trade due to legal restrictions"): NVDA, AAPL, MSFT, AMZN, GOOGL, META, TSLA, MSTR, SNDK and SPCX.
- 71 have no liquidity at all.
- 46 route. About 40 of those lose under 1.2% on a buy-and-sell-back. A few are unusable: HTZ returns $26 of $100, CAKE $62, SOUN $67.
- Some fills are far from plausible share prices even when the round trip is tight, for example CAKE at $8,760 and PM at $2,250. Buy stocks should not offer a trade until it has a price-sanity check against a reference price.

**Buy stocks therefore routes through Aerodrome** (`app/lib/aerodrome-swap.ts`):

- **Where the liquidity is:** the USDC liquidity for these tokens is in Aerodrome Slipstream pools from the third CL factory (`0xf8f2…61Ef`).
- **Pool depth:** 12 stocks have deep pools of $300k–$1.5M USDC (the 10 above, MU and PLTR). Another 19 have pools of about $25k, and roughly 27 hold almost nothing.
- **How it trades:** the app quotes with Aerodrome's quoter and swaps with one `V3_SWAP_EXACT_IN` command on their Universal Router. Addresses and path encoding come from `velodrome-finance/sugar-sdk`.
- **Price guard:** a fill more than 5% worse than the stock's Chainlink price is refused. Stocks without a feed show a "check the price yourself" note.
- **Verified by clicking on a mainnet fork:**
  - bought $50 of NVDAc, sold 0.1 NVDAc;
  - bought $20 of AAPLc;
  - every fill matched its quote exactly.
- **Correction:** an earlier note here said Aerodrome was empty. That check only looked at its two older factories.

## Region

The Worker refuses visitors from the US and its territories (`BLOCKED_COUNTRIES` in `cloudflare/worker.mjs`): pages get a "not available in your region" page, and APIs answer 451. Every request passes through the Worker (`run_worker_first: true`). A VPN can get around this, so the terms must state the restriction too.

## Not done by code

- **External audit.** `MarketRipPool` and `MarketRipPut` are not covered by `contracts/SECURITY.md`.
- **Legal.** Base says the tokens are "available only in eligible jurisdictions outside the US". Rips sells upside on them, so geofencing and terms need a lawyer.
- **Randomness.** Selection uses block entropy, which a builder can bias. That is acceptable for $1 draws only if the operator accepts it.
- **Keys and monitoring.** Who holds the multisig and the quoter key, and the alerts for stale quotes, paused feeds, and series nearing maturity.
- **A canary batch** with small inventory before anything is announced.
