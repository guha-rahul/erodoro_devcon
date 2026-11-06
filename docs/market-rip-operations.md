# Market Rip operations

Market Rip is implemented as two isolated contracts: `MarketRipPut` for USDC-backed DOWN claims and `MarketRipPool` for the $1 blind sale. The existing `ErodoroVault` still supplies UP `N` claims and retains its original P/N payoff. The frontend route is `/market-rip`.

## Pricing and collateral

Erodoro supplies a firm `unitsPerRip` quote: the exact raw claim units sold for 1,000,000 raw USDC units. A quote expires within five minutes and carries a nonzero `quoteRef` for audit. The pool does not derive a premium from spot or the testnet house maker. It transfers five times `unitsPerRip` into each position, giving an initial **$5 quoted tail market value**. Every RIP transfers `unitsPerRip` actual claim units and charges exactly $1 USDC.

UP collateral is the same number of B20 stock units as offered `N` units, locked by `vault.split`. DOWN collateral is the USDC maximum payout, rounded up: `ceil(strike × claimUnits × 10^6 / (10^priceDecimals × 10^stockDecimals))`. For example, if the firm premium is $5 per whole-share claim and the spot is $100, $5 of tail inventory is one share equivalent. The UP position locks one stock token worth about $100; a DOWN position with a $95 strike locks $95 USDC. These figures are illustrative, not a quote.

The put accepts only the existing total-return oracle model, so a B20 multiplier change does not alter the fixed strike. It reuses `IOracleAdapter`, `IFallbackSettlementOracle`, and `PayoutMath.normalizeDecimals`; settlement freezes the below-strike difference and buyers redeem their own ERC-6909 units for USDC. There is no change to `ErodoroVault` or `PayoutMath.computePools`.

## Seeding

1. Deploy with `contracts/script/DeployMarketRip.s.sol` after setting `DEPLOYER_PRIVATE_KEY`, `USDC_ADDRESS`, `VAULT_ADDRESS`, `FACTORY_ADDRESS`, and `ERODORO_OPERATOR_ADDRESS`. It creates `MarketRipPut(USDC, erodoroWallet)` and `MarketRipPool(USDC, vault, factory, put, erodoroWallet)` without funding them. Record the addresses. The current Base mainnet manifest has no Erodoro vault or Factory, so this step needs a reviewed mainnet deployment first. Configure the Factory's approved token/oracle bindings for every UP stock before seeding.
2. Prepare a private JSON configuration with `chainId`, `pool`, `put`, `vault`, `factory`, `usdc`, and a `positions` array containing **exactly** NVDA, AAPL, MSFT, AMZN, GOOGL, META, TSLA, SNDK, MSTR, and SPCX once each. Each position needs `ticker`, `token`, `direction`, `oracle`, `feedId`, `spotRaw`, `spotTimestamp`, `priceDecimals`, and either a firm `quote` or `quoteUrl`. `quote` is `{ "unitsPerRip": "...", "validUntil": 0, "ref": "0x..." }`; `quoteUrl` must return the same shape. Optional fields are `fallbackOracle`, `fallbackRequestId`, `fallbackDelay`, `settlementDelay`, and `maxPriceLag`. All token and oracle addresses must be independently reviewed. The script refuses a spot snapshot more than 60 seconds from on-chain batch creation.
3. Fund the Erodoro wallet with the required stock and USDC collateral, plus gas. Run `forge build` in `contracts/`, then set `RIP_CONFIG`, `RIP_PRIVATE_KEY`, and `RIP_RPC_URL` and run `node scripts/seed-market-rip.mjs`. The script checks inputs, creates a batch whose expiry falls inside US market hours (`scripts/lib/market-expiry.mjs`; the pool accepts 7 to 45 days out), creates and funds all ten series, transfers all claim inventory into the pool, and activates only the complete batch. A failed step leaves the new batch inactive.
4. Set `NEXT_PUBLIC_RIP_POOL_ADDRESS` and `NEXT_PUBLIC_RIP_PUT_ADDRESS` in the app build. The page remains inactive when the pool is not configured or funded. The pool state disclosure shows remaining quoted value, collateral, amount sold, and distinct buyer count. My Rips reads the on-chain buyer index and live claim balances.

Refresh quotes with `setQuote(positionId, unitsPerRip, validUntil, quoteRef)` before they expire. The operator (`erodoro`, a multisig on mainnet) can name a `quoter` hot key with `setQuoter`; the quoter may refresh house quotes and `setPaused(true)`, and only the operator can resume sales. Stop refreshing when a stock's feed is stale or its market is closed: a lapsed house quote also stops blind sales of that stock's seller listings. A new quote changes the live marked value of remaining units. At expiry, settle each series with the existing oracle path, then return unsold claim units using `returnExpiredInventory` and withdraw put surplus using `withdrawSurplus`. Buyers can redeem their own claims directly.

## Prices

Displayed stock prices come from Chainlink's "Coinbase <TICKER>" feeds on Base mainnet (`app/lib/rips/prices.ts`): the tokenized-stock price, i.e. the 24/5 equity price times Coinbase's on-chain multiplier, 8 decimals. Reading them is a free view call. They are display only ("Price now", "Needs to rise"); each market still settles on its own oracle, and feeds go quiet outside US trading sessions, so the page shows when the price was last updated.

On Base Sepolia the fixture's `batch` mode (`node scripts/rips-sepolia.mjs batch`) creates test versions of the ten stocks, named `t<TICKER>`, whose starting spot is the live Chainlink mainnet price and whose strike is that +5%. The house quote per claim is a Black-Scholes value (volatility `RIP_TEST_VOL`, default 0.5) stored in the manifest and reused by `quotes`. The testnet app shows the matching mainnet feed as a labelled reference price. Settlement on testnet remains the mock oracle.

## Seller listings

After a batch is active, anyone can supply upside for one of its house markets from the **Sell Rips** page (`/rips/sell`). `lockAndList(templateId, collateral, unitsPerRip)` pulls the seller's stock, splits it in the template market's series, sends the P claim straight back to the seller and lists all N units at the seller's price. Every purchase of that listing pays the seller directly; the house is never paid for seller inventory.

- Seller prices stand until changed or batch expiry (`setListingPrice`); each change gets a new `quoteRef`, so in-flight selected buys bound to the old price revert.
- `withdrawListing` returns unsold N at any time; with the matching P, the vault's `merge` returns the stock (the page's Unlock button). After expiry `returnExpiredInventory` sends unsold N to the seller.
- Only the house (or its quoter) can `setQuote`, and only on house positions. A batch holds at most `MAX_BATCH_POSITIONS` (40) house markets plus listings, bounding `ripUp`'s scan. A listing must hold at least `MIN_LISTING_DOLLARS` ($5) of N at the house quote, so dust cannot fill those slots cheaply.
- Blind buys (`ripUp`, `ripPack`) draw a listing only while that stock's house quote is live and the listing gives at least as many units per $1 as the house. A seller cannot sell a blind buyer a worse deal than the house. Directed `buyPosition` still fills at the reviewed seller price. Legacy `rip()` never reaches seller listings.
- A seller cannot buy their own listing: paying themselves fails the pool's payment check.

## Limits to review before real funds

- The pool's immediate selection is uniform across positions that can fill one RIP, using block entropy. A block builder can bias this result. A future unbiased design needs a delayed randomness callback or commit/reveal and would change the immediate reveal experience.
- Erodoro is the sole quote authority and supplies the spot snapshot. The contracts verify strike arithmetic, expiry, collateral, and inventory, but cannot independently prove that the quoted premium is a fair market value or that the snapshot reflects the precise batch-creation second.
- A $1 quote defines an exact fractional unit count. Arbitrary theoretical per-unit prices may not divide into exactly $1 at eight-decimal claim precision; the firm quote must choose the executable unit count and accept its rounding.
- Base lists all ten requested token addresses in `docs/market-rip-assets.md`, but the oracle/feed bindings and collateral balances are not verified. No mainnet batch or $50 inventory has been deployed or funded by this code change.
