# Erodoro Base Website — Full Implementation TODO

## Objective

Redesign Erodoro from a protocol-mechanics-first interface into the simplest way for Base users to **earn premium by selling upside on tokenized stocks**.

The protocol can continue using the existing P/N primitive internally:

`1 stock → P + N`

But normal users should **not need to understand P and N before using the product**.

Primary user journey should become:

`Own tokenized stock → choose strategy → see premium quote → sell upside → receive USDC → redeem/roll at expiry`

Primary positioning:

> **Earn premium on your tokenized stocks.**

Secondary explanation:

> Choose how much upside you're willing to give up. Erodoro sells that upside and pays you the premium in USDC.

Treat P/N as an advanced protocol concept.

---

## Status legend

- `* [ ]` not started
- `* [x]` done, with evidence named alongside it
- `* [~]` partly done — what remains is stated
- `* [!]` **blocked** — the blocker is named. Blocked items are skipped, never
  guessed past. If completing something needs a value, an address or a
  behaviour nobody has verified, it gets marked here rather than assumed.

The current deployment and verification boundary lives in [`status.md`](status.md).
When this backlog and an older document disagree about what is live, update the
older document and treat `status.md` as authoritative.

## Ordered execution plan

This is the order of work. Later phases do not override an earlier release gate.

### Task 1 — Establish one status source of truth

* [x] Add `status.md` with separate Base mainnet and Base Sepolia states.
* [x] Record local-test, fork, Sepolia, audit and economic-proof boundaries.
* [x] Reconcile the contracts README, public FAQ and Sepolia deployment note.
* [x] Link this backlog to the status source of truth.

### Task 2 — Finalize settlement semantics

* [x] Review and accept the settlement ADR at
  [`contracts/docs/adr/0001-settlement-price-semantics.md`](contracts/docs/adr/0001-settlement-price-semantics.md).
  The accepted decision supports separate raw-share and total-return models.
* [x] Specify exactly where the B20 multiplier is applied so it is never omitted
  or applied twice.
  The series model selects one branch and the vault rejects a model mismatch.
* [x] Specify split, reverse-split, dividend, emergency-multiplier and
  corporate-action-pause behavior.
  The accepted rules and their production evidence gates are in the ADR.
* [x] Define how settlement identifies a normal, stale or
  corporate-action-frozen feed. If the contract cannot identify a freeze, treat
  that adapter as blocked for production use.
  Pyth remains production-blocked because it has no authenticated issuer-pause
  signal. Chainlink uses Coinbase's live registry through `CoinbaseFeedStatus`.
* [x] Add tests that reject stale and frozen prices. Test resumed settlement
  only after the price and multiplier represent the same corporate-action state.
  The Chainlink integration test now runs the full pause, 2x multiplier and
  matching total-return update, unpause, and settlement sequence. A canonical
  deployment remains a release gate.
* [x] Specify the authoritative price timestamp, admissible settlement window,
  confidence policy, retry path and permanent-unsettleability defense.
  Pyth selects the first update after maturity. The vault has a delayed,
  finalized UMA fallback path.
* [x] Use separately versioned Pyth raw-share and Chainlink total-return market
  types. Treat every adapter or model change as a new configuration.
* [x] Connect the delayed fallback interface to UMA Optimistic Oracle V2 on Base
  Sepolia. Verify the bond token, identifier, liveness, addresses, and dispute
  path before enabling it in a canonical configuration.
  `UmaFallbackSettlementOracle` uses `ASSERT_TRUTH`, a whitelisted test bond
  token, 7,200-second liveness, and proposer/disputer bonds. The live-contract
  fork test proves proposal, dispute, and undisputed finalization paths.
* [x] Implement the Coinbase feed-status registry behind `IFeedStatus`.
  `CoinbaseFeedStatus` binds one token and feed, fails closed, and calls the
  verified `getOracleParams(address)` ABI. The 2026-08-25 AAPLc response was
  multiplier `1e18` and `paused=false`.

Do not deploy mainnet or build production settlement UI until this ADR is
accepted and covered by tests.

### Task 3 — Enforce collateral-to-feed identity

* [x] Replace the factory's independent collateral/feed approval with a binding
  that proves an approved collateral uses its exact oracle and feed.
* [x] Make every frontend market and creation path read that binding instead of
  the deployment-level AAPL feed.
* [x] Add negative tests proving an AAPL feed cannot create an NVDAc, METAc or
  GOOGLc canonical series.
* [x] Keep an asset disabled until its complete settlement configuration is
  approved and readable.

### Task 4 — Prove real RFQ liquidity

* [ ] Obtain one external market-maker commitment for one deliberately narrow
  stock, strike and expiry surface.
* [ ] Record quote-size limits, quote lifetime, funding checks, pricing owner,
  inventory limits, hedge path, monitoring and settlement responsibility.
* [ ] Connect the external maker endpoint without changing the atomic RFQ
  settlement contract.
* [ ] Measure response rate, available size, spread, expiry and failed-quote
  reasons. Do not present the test house maker as market demand.
* [ ] Keep dated buyer interviews and market evidence in
  [`docs/market-validation.md`](docs/market-validation.md).

The endpoint contract, commitment record, and RFQ measurements are ready in
[`docs/maker-onboarding.md`](docs/maker-onboarding.md). No external maker or
interview evidence exists, so the Task 4 evidence items remain open.

The initial stock and market shape remain product decisions. Choose them from
real maker and hedging interest, not ticker popularity.

### Task 5 — Run a role-separated Base Sepolia pilot

* [x] Use separate seller, maker and settlement-caller accounts in the local
  pilot and live pilot script.
* [x] Run faucet, split, quote, N sale, expiry settlement and separate P/N
  redemption end to end.
* [x] Exercise no-bid, expired quote, unfunded maker, issuer pause, transfer
  denial, multiplier change and stale/wide oracle states.
* [x] Record transaction hashes, contract configuration and before/after
  balances in `status.md`.
* [x] Install the frontend dependencies and make `pnpm lint` and `pnpm build`
  reproducible CI gates.

The local pilot passes. The current contracts also completed the full Base
Sepolia lifecycle with separate funded seller, house-maker and settlement
accounts. The signed RFQ fill, maturity-specific Pyth settlement and separate
redemptions are recorded in
[`contracts/deployments/base-sepolia.json`](contracts/deployments/base-sepolia.json).
This closes Task 5. It does not close Task 4 because the maker is controlled by
the project. The deployment and operation procedure is in
[`contracts/docs/base-sepolia-pilot.md`](contracts/docs/base-sepolia-pilot.md).

### Task 6 — Finish only the pilot UI

* [~] Show a real per-stock reference price and a real best bid with size and
  quote expiry. — the Earn cards and market list now read each series feed and
  show only worker-validated funded bids, including the signed quote size and
  expiry. Maker-reported capacity is not presented as funded size. No external
  maker is connected yet, so there is no external bid to display.
* [x] Show `No live bid` and remove execution when no funded quote exists. —
  market rows and cards use this exact state; the sell action exists only after
  the worker returns a usable quote and `checkQuote` runs again before filling.
* [ ] Add a transaction review that states deposit, premium, retained upside,
  surrendered upside, exact expiry, fees and settlement source.
* [ ] Complete active, awaiting-settlement and redeemable portfolio states.
* [ ] Publish the risks page and eligibility disclosure.
* [~] Test the complete flow at 375px, 390px, 430px, 768px and 1440px, including
  the Base App in-app browser. — `pnpm check:responsive` now checks `/earn` and
  `/app` at all five widths and caught the former 768px header overflow. A real
  injected-wallet journey inside Base App remains open.

Defer auto-roll automation, referrals, notifications, social receipts, broad
asset coverage, retail buy-upside mode and growth integrations until the basic
seller-to-maker lifecycle works with an external quote source.

### Task 7 — Clear the mainnet release gates

* [ ] Freeze the reviewed contract and settlement scope.
* [ ] Complete an external security review and publish its exact scope.
* [ ] Add reproducible deployment, source-verification and preflight scripts.
* [ ] Put factory administration behind a documented multisig and define every
  remaining admin and emergency power.
* [ ] Re-run the Base fork suite against the exact live B20 release and record
  the block, artifacts and limitations.
* [ ] Obtain legal review for jurisdiction, eligibility, frontend restrictions,
  disclosures and the RFQ operator's role.
* [ ] Require a funded production maker and monitoring for B20 announcements,
  multipliers, pauses, policies, oracle health, collateral shortfall and RFQ
  failures.
* [ ] Launch only as a capped one-stock, one-configuration canary and complete a
  full real expiry before expanding.

**Verified on Base mainnet on 2026-08-25:** all four stock addresses respond
with the right `symbol()`, all four Chainlink feeds exist and their
`description()` returns `Coinbase AAPL` / `NVDA` / `META` / `GOOGL`, and the
registry at `0x3f3E8c…5CaD` has code. The GOOGLc address in this file is the
correct 20-byte one.

---

## Review — four things in here are bigger than they look

**1. Swapping Pyth for Chainlink is a contracts change, not UI wording.**
It is listed under a copy fix, but `PythAdapter` holds its oracle address
`immutable`, so Chainlink means deploying a new adapter. Worse, Chainlink has no
`parsePriceFeedUpdates(min, max)` — and that single call is what removed the
un-settleable-series bug, because it makes the publish window an argument
instead of an invariant reconstructed from three parameters. With
`latestRoundData()` that bug class comes back and has to be defended again.

And these feeds report a **Total Return Value** — market price multiplied by the
B20 multiplier — not a raw share price. Feeding that into the existing strike
adjustment applies the multiplier **twice**. The corporate-action math either
deletes itself or double-counts; it cannot stay as it is. Decide the oracle
before building settlement UX on top of either one.

**2. "Listen for scheduled multiplier changes" cannot be done on the live chain.**
The scheduled-multiplier surface is a later hardfork. On what is live today
`effectiveAt()` *reverts* on the real AAPLc — verified, not inferred. Until that
ships there is nothing to subscribe to, and the code already distinguishes
"unreadable" from "nothing scheduled". Marked blocked rather than faked.

**3. Routing liquidity through Aerodrome replaces the OTC desk and needs the
wrapper.** Aerodrome speaks ERC-20; `P` and `N` are ERC-6909 ids. So
`ClaimWrapper` stops being optional, and a pool has to exist and be seeded
before any screen may say liquidity is routed anywhere.

**4. "See premium quote" has no source of truth yet.** The whole repositioning
turns on showing a premium before the user commits. That number has to come from
somewhere: a live market, or a pricing model. Neither exists. This is the centre
of the new product and it is currently an open question, not a build task.

---

# P0 — FIX CURRENT BROKEN / INCORRECT ITEMS FIRST

* [x] Fix the current “Request early access” link. — replaced with `Explore strategies` → `/app`. It was worse than described: the repo is private, so it 404'd for everyone who is not a collaborator.
* [x] Do not send normal users to GitHub to request access. — no GitHub link remains on the homepage.
* [x] Replace it with either:

  * an actual email/wallet waitlist modal, or
  * remove it entirely and use “Explore strategies” while the app is in preview.
* [x] Remove all `0x0000000000000000000000000000000000000000` oracle addresses from UI. — done: the fixture module was deleted, no zero address renders anywhere.
* [x] If a contract/oracle is not configured, render `Not configured — preview only`, never a zero address. — `AddressLink` detects a zero address and renders that instead.
* [x] Clearly separate **Demo/Preview Mode** from **Mainnet Mode**. — three states: not deployed / testnet / mainnet.
* [x] In demo mode, add a persistent `DEMO DATA` / `PREVIEW` badge. — now a strip inside the sticky header plus a network chip, so it cannot scroll away.
* [x] Every fake market must explicitly say `Demo market`. — satisfied by removal: there are no fake markets left to label.
* [x] Never make fake TVL, premiums, quotes or settled positions look like actual mainnet activity. — there is no synthetic data left: every figure is read from a contract or absent.
* [x] Mainnet mode must never fall back to placeholder market data. — done: `lib/preview-data.ts` is deleted and reads are gated on a deployed vault.
* [x] Remove the current homepage statement that Erodoro necessarily settles against a “Pyth feed” until the final Base settlement-oracle implementation is decided. — the copy now describes the mechanism (a feed and window fixed at creation) without naming a vendor.
* [!] If Chainlink is implemented, use correct Chainlink wording everywhere. — **BLOCKED on the oracle decision.** Nothing names a vendor today, so there is no wrong wording to fix; this becomes real the moment one is chosen.
* [x] Explain the settlement reference's role and do not imply it is anyone's official price source. — the oracle panel states it is the feed the market names, chosen by Erodoro, and explicitly not an official source of the issuer or the network.
* [x] Remove any use of the word “partner” for Base, Coinbase, Aerodrome, Chainlink, etc. — audited: no such wording exists anywhere in the app.
* [x] Use integration language only when the integration is actually implemented. — audited: the app makes none of these claims today. Re-check when Chainlink or Aerodrome lands.

---

# P0 — USE THE CORRECT BASE STOCK UNIVERSE

For the public product today, support only the Coinbase Tokenized Stocks that Base currently publicly lists as launched:

* [x] AAPLc — Apple — in the registry
* [x] NVDAc — NVIDIA — in the registry
* [x] METAc — Meta — in the registry
* [x] GOOGLc — Alphabet — added, with its Chainlink feed

Do **not** automatically expose every contract that happens to appear in Base's developer documentation.

The official public Base Stocks listing should be treated as the activation source of truth.

Create a stock configuration registry containing at minimum:

### AAPLc

`0xb200000000000000000000C2e324d24d7eEcd1fb`

Chainlink feed:

`0x787f13dEa48Db0897CbCDD985de77809D837F988`

### NVDAc

`0xb20000000000000000000078ee7ce2fE4908108C`

Chainlink feed:

`0x04689a41629776563E6822F76f2e57D148d28513`

### METAc

`0xb2000000000000000000008bC8786B856E61707C`

Chainlink feed:

`0x6526aE6797A76123638b863AeE4dD27Ba4E4b27D`

### GOOGLc

`0xb2000000000000000000002D0BA3164cc74f58B7`

Chainlink feed:

`0x5bF49E0ffA937CE2FfF033c739aD7C634c4D34F2`

Coinbase onchain stock registry:

`0x3f3E8cf41cdd3b1D118c16471aB0113DfDDd5CaD`

* [x] Reverify every address against the official Base documentation during implementation. — done better: verified against the chain itself on 2026-08-25, see the legend above.
* [x] Identify stocks internally by **contract address**, not ticker. — done: the registry is keyed on address, ticker is metadata.
* [x] Treat ticker/name/icon as mutable metadata. — the registry is keyed on address; ticker, name and decimals are fields on it.

---

# P0 — IMPLEMENT B20 CORRECTLY

Do not treat Coinbase stocks as ordinary immutable ERC-20 tokens.

* [x] Read the current B20 multiplier. — `lib/use-b20.ts`; verified against live AAPLc and GOOGLc (both 1e18).
* [x] Use multiplier-aware calculations for user-facing share quantities. — `toShareEquivalent()`.
* [x] Never assume `1 AAPLc token = 1 Apple share forever`. — share-equivalents are derived on every read, never cached as a constant.
* [x] Distinguish internally between:

  * raw B20 balance
  * current multiplier
  * scaled/share-equivalent balance
* [x] Show users the scaled/share-equivalent amount. — balances read `… shares`.
* [~] Keep raw units in advanced protocol details only. — raw appears only in a note shown when the token has actually been rebased. Remaining: a proper advanced-details disclosure.
* [!] Listen for scheduled multiplier changes. — **BLOCKED:** the scheduled-multiplier surface is not on the live chain; `effectiveAt()` reverts on the real AAPLc. Unblocks when the later hardfork ships.
* [~] Listen for multiplier-update events. — the instant setter's `MultiplierUpdated` is read and flagged as an emergency override, since it arrives without an announcement bracket. The scheduled event does not exist on the live release.
* [x] Listen for B20 announcement events. — `Announcement(address,string,string,string)` confirmed present on the live release and read into a disclosures panel. Shown, never parsed: the text is issuer-written and branching on it would trust a string with money.
* [x] Detect token pause state. — read in the UI and blocks the lock path with a sentence.
* [x] Detect issuer transfer-policy restrictions. — sender and receiver scopes resolved, then checked against the registry for both the user and the vault.
* [x] Preflight authorization before attempting collateral transfer. — the lock button is disabled and the reason is shown before a wallet ever opens.
* [x] Do not assume `approve()` succeeding means the subsequent B20 transfer can succeed. — allowance and policy are checked as separate gates. Confirmed on chain: all four policy scopes on the live tokens are **already armed** at policy id 5, currently permissive. One list entry changes that.
* [x] Handle policy-related transfer failures with a human-readable message. — paused, sender-denied and receiver-denied each get their own sentence.
* [x] Disable creation/settlement where the token state makes the operation unsafe. — locking is disabled on pause or policy denial. Settlement is deliberately *not* gated on transfer state: it moves no collateral, so a pause must delay redemption rather than strand the series.

---

* [x] Route reads through a private RPC behind the Worker. — `/rpc` allows a
  read-only method list, caps batches at 32, refuses writes, and sets
  `x-rpc-source` so a fallback is never silent. The key is set and live:
  verified against the deployed worker, the header reads `private`, an allowed
  read returns **200** where the public endpoint returned **429 over rate
  limit**, the chain id comes back `0x14a34` (84532, matching the active chain),
  and `eth_sendRawTransaction` is still refused.
* [ ] The proxy targets one upstream regardless of chain. Mainnet and testnet
  keys side by side need a second secret and a chain parameter on the route.

---

# P0 — ORACLE / SETTLEMENT UX

Coinbase Tokenized Stocks can trade onchain 24/7, but the official Chainlink equity feeds are not simply a crypto-style 24/7 oracle.

Build the UI around this distinction.

* [x] Maintain separate concepts for:

  * DEX/secondary-market price
  * settlement/reference oracle price
* [x] Label prices explicitly. — the panel is titled `Settlement reference` and subtitled `Not a market price`.
* [~] Example: — the settlement side is labelled. The venue side lands with the venue.

  * `Market price · Aerodrome`
  * `Settlement reference · Chainlink`
* [x] Never imply the settlement reference updates continuously. — a reference older than 15 minutes renders as `Market closed` and says it is a carried close, not a live quote. Audited: the app makes no 24/7 claim anywhere.
* [~] Read Chainlink round data. — the new adapter reads a caller-selected historical round and proves it is the first round after maturity. The deployed testnet adapter still uses Pyth, so the UI cannot use this path until a new deployment is recorded.
* [x] Validate the price is positive. — enforced in the adapter contract and re-checked before settlement is offered.
* [x] Validate the publish time. — the contract requires the reference to fall inside the market's own window; the UI shows its age.
* [x] Implement explicit staleness checks. — 15-minute threshold surfaces as `Market closed`.
* [x] Detect the Coinbase registry oracle-pause flag. — `CoinbaseFeedStatus` calls the verified `getOracleParams(address)` interface and fails closed.
* [x] Never allow settlement against a frozen corporate-action feed. — `ChainlinkTotalReturnAdapter` rejects settlement while the configured Coinbase status is paused. Unit tests cover pause and resumed operation. A canonical deployment is still required.
* [x] Never silently use the previous market close as a fresh price. — a stale reference is labelled as a carried close, and the contract rejects a print from outside the window.
* [x] Add `Oracle market closed` state where applicable.
* [ ] Add `Oracle paused for corporate action` to the UI after the Chainlink and status contracts are deployed and exposed through the app's read layer.
* [x] Add `Waiting for fresh settlement price` state. — plus a distinct `Price band too wide` state, which is what a thin or closed book looks like on chain.
* [x] Add `Settlement available` state.
* [x] Clearly document exactly which reference time determines expiry settlement. — the panel names both bounds and says a price from outside them is rejected.
* [x] Do not advertise a generic “24/7 settlement”. — audited: no such claim exists.

This settlement specification must be finalized before mainnet deployment.

---

# P1 — COMPLETELY REPOSITION THE HOMEPAGE

Current headline:

`Set your strike. Sell the upside.`

This can remain as secondary copy, but it is too abstract to carry the entire product.

Replace the hero with:

* [x] Hero replaced — eyebrow, H1, supporting copy, both CTAs, the compact
  assurance line and the trade-off statement are all live and verified on the
  deployed URL. The old headline survives one rung down as secondary copy.

### Eyebrow

`Stock income · Built on Base`

### H1

`Earn premium on your tokenized stocks.`

### Supporting copy

`Choose how much upside you're willing to sell. Erodoro turns that upside into a tradable claim and pays you the premium in USDC when a buyer fills it.`

### Primary CTA

`Explore strategies`

### Secondary CTA

`How it works`

Under the CTAs show a compact line:

`Fully collateralized · No seller liquidations · On Base`

Then clearly state:

`You keep the stock's downside risk and give up gains above your selected strike. Tokenized-stock availability is jurisdiction dependent.`

---

# P1 — CHANGE THE NAVIGATION

Desktop navigation:

`Erodoro`

`Earn`
`Markets`
`Portfolio`
`How it works`
`Docs`

Right side:

`Base`
`Connect wallet`

* [x] `Earn` should be the primary retail interface. — `/earn` starts from a stock in the wallet rather than from a market.
* [x] `Markets` should be the advanced market interface. — `/app` keeps the full per-market detail.
* [x] `Portfolio` appears after wallet connection but remains accessible without connection with empty state. — always in the nav, with a connect prompt rather than an empty table that reads as 'you hold nothing'.
* [!] `Docs` nav item. — **BLOCKED:** there is no docs page yet (its own P2 section). Deliberately left out of the nav rather than pointed at a 404 — that is the exact mistake the early-access link was.
* [x] Clearly show network as Base. — a network chip in the header names the active chain.
* [x] If user is connected to another chain, display `Switch to Base`. — the wrong-chain state is louder than the disconnected one, since it is the only one that can cost money.

---

# P1 — ADD A SIMPLE “WHY USE THIS?” SECTION

Immediately below the hero, explain the value proposition without P/N terminology.

* [x] Three cards live immediately below the hero, with the trade-off line
  underneath them. No P/N vocabulary appears before this point.

Use three cards:

### Earn premium

`Get paid in USDC for selling part of your stock's future upside.`

### Choose your cap

`Select the strike and expiry that match how much upside you want to keep.`

### No seller liquidation

`Positions are fully backed by the tokenized stock you deposit.`

Under these cards:

`The trade-off: you still bear the stock's downside, and gains above your strike go to the upside buyer.`

---

# P1 — ADD “HOW IT WORKS” USING CONSUMER LANGUAGE

Replace the current LOCK → SELL N → SETTLE explanation as the primary explanation.

Use:

### 01 · Choose

`Choose a tokenized stock, expiry and strike.`

### 02 · Sell upside

`Deposit your stock and accept a bid for the value above your chosen strike.`

### 03 · Receive premium

`When the trade fills, the premium is paid to you in USDC.`

### 04 · Settle or roll

`At expiry, redeem your position or roll into the next strategy.`

Then add:

`See protocol mechanics →`

Inside the advanced explanation, show:

`1 stock → P + N`

P:

`Value up to the strike`

N:

`Value above the strike`

Do not lead with P/N anywhere else.

---

# P1 — REPLACE “KEEP ONE. TRADE THE OTHER.”

This phrase currently requires too much interpretation.

Replace it with:

`Keep the stock exposure you want. Sell the upside you don't.`

Possible supporting copy:

`Erodoro separates a tokenized stock into a capped stock claim and an upside claim. You keep the capped claim and sell the upside claim for USDC.`

---

# P1 — SHOW AN ACTUAL USER EXAMPLE

Replace the abstract $400/$500 example with something that looks like an actual strategy card.

Example only:

### Sell AAPL upside

`AAPLc reference price   $310`
`Strike                  $340`
`Expiry                  21 days`
`Upside retained         +9.7%`
`Indicative premium      6.20 USDC`

Then:

`If AAPLc finishes at or below $340, you retain the corresponding stock value and keep the premium.`

`If it finishes above $340, the value above $340 belongs to the upside buyer.`

Clearly label all fake numbers:

`Example only`

---

# P1 — ADD A PAYOFF GRAPH

Create an interactive payoff chart.

Inputs:

* Stock price at expiry
* Strike
* Premium received
* Amount of stock

Allow toggle:

`Seller`
`Upside buyer`

Seller chart should show:

* downside remains
* premium offsets some downside
* gains become capped after strike

Buyer chart should show:

* maximum loss = premium
* payout starts above strike
* break-even = strike + premium per equivalent share

Add vertical markers:

* Starting/reference price
* Strike
* Break-even

Tooltips should use dollar outcomes rather than P/N terminology.

---

# P1 — REDESIGN THE MARKETS PAGE

The current table:

`Market | Strike | Locked | Expiry | Status`

does not provide enough information for a financial decision.

Change it to:

`Stock`
`Reference price`
`Strike`
`Upside to strike`
`Expiry`
`Best premium`
`Term yield`
`Stock locked`
`Liquidity`
`Action`

Example:

`AAPLc | $310.20 | $340 | +9.6% | 21d | 6.20 USDC | 2.0% | 12.4 AAPLc | Live bid | Sell upside`

* [x] Do not show annualized APY as the dominant metric. — no APY is shown.
* [x] Show term return first. — the market list derives it from the funded
  one-share bid and settlement reference, labels the formula, and excludes fees.
* [x] If showing annualized yield, clearly label it as annualized/indicative. —
  no annualized yield is shown.
* [x] Never show a premium unless there is an actual bid. — list previews now
  include the required public taker and use only worker-validated funded quotes.
* [x] Display `No live bid` instead of zero or fake premium.
* [ ] Replace ambiguous `Locked: 12` with `12 AAPLc`.
* [ ] Also show approximate USD TVL.
* [ ] Add stock logo.
* [x] Add company name.
* [ ] Add contract verification indicator.
* [~] Add filters: — the stock selector is populated from canonical markets;
  broad production options appear only when those markets actually exist.

  * All
  * AAPLc
  * NVDAc
  * METAc
  * GOOGLc
* [x] Add expiry filters:

  * 7D
  * 14D
  * 30D
  * All
* [ ] Add status filters:

  * Open
  * No bid
  * Expiring
  * Settled
* [x] Default sort by most attractive live opportunities rather than expiry. —
  funded bids sort first, then term return, then expiry.

---

# P1 — CREATE A NEW PRIMARY “EARN” PAGE

Route:

`/earn`

This should be easier than `/markets`.

Header:

`Earn premium on your stocks`

Subheading:

`Choose a stock you hold and compare available upside-selling strategies.`

* [x] `/earn` built with a card per stock, balance shown share-equivalent, and
  a strategy count read from the registry.
* [x] `Reference price` and `Best available premium` rows — populated from the
  active series settlement feed and worker-validated funded quotes. They render
  `Unavailable` and `No live bid` when those sources return nothing.
* [ ] `Get AAPLc` flow — deep-link to a verified venue, or integrate a swap.
  Currently states plainly that buying happens elsewhere and that Erodoro has no
  arrangement with any venue.

Display stock cards:

### Apple

`AAPLc`
`Your balance`
`Reference price`
`Best available premium`
`Strategies available`

CTA:

`View strategies`

Repeat for NVIDIA, Meta and Alphabet.

If wallet has zero balance:

`You don't hold AAPLc yet.`

CTA:

`Get AAPLc`

The `Get AAPLc` flow should either:

* integrate an aggregator/Aerodrome swap directly, or
* deep-link to a verified liquidity venue.

Never invent an Aerodrome partnership claim.

---

# P1 — MAKE AERODROME PART OF THE USER FLOW

Aerodrome is useful to Erodoro because it provides underlying-stock liquidity.

Implement:

* [ ] `Get AAPLc`
* [ ] `Get NVDAc`
* [ ] `Get METAc`
* [ ] `Get GOOGLc`

Ideal flow:

`USDC → tokenized stock → Erodoro position`

If technically possible, make this a single guided flow.

At minimum:

* show estimated stock amount
* show liquidity venue
* show slippage
* verify token contract
* return user to Erodoro after acquisition

Do not create AMMs for every individual P/N strike and expiry.

Use professional bids/RFQ/auction liquidity for N where possible.

Underlying stock liquidity and N liquidity are different things.

---

# P1 — REDESIGN MARKET DETAIL PAGE

Current detail page is dominated by protocol IDs and parameters.

New hierarchy:

## Header

Stock logo

`AAPLc`

`Apple Inc.`

`Reference price: $310.20`

`Base`

`Verified B20`

Small contract-address link.

---

## Strategy Summary

`Sell upside above $340`

`Expires in 21 days`

`+9.6% above current reference price`

---

## Primary Action Card

Tabs:

`Sell Upside`
`Buy Upside`

Default:

`Sell Upside`

Input:

`Amount of AAPLc`

Show:

`Wallet balance`

`MAX`

Then live quote:

`You deposit`
`1.00 AAPLc`

`Strike`
`$340`

`Expiry`
`21 days`

`Best premium`
`6.20 USDC`

`Premium yield`
`2.00% over 21 days`

`Upside retained`
`First +9.6%`

`Maximum loss`
`Stock downside minus premium received`

CTA:

`Review & Sell Upside`

Do not say `Mint P/N` on the primary CTA.

---

# P1 — ADD TRANSACTION REVIEW SCREEN

Before signing:

### You deposit

`1 AAPLc`

### You receive now

`6.20 USDC`

### You retain

`Stock value up to $340 at settlement`

### You give up

`Stock value above $340 at settlement`

### Expiry

Exact date + time + timezone.

### Settlement source

Exact oracle.

### Fees

Network fee
Protocol fee
Trading/quote fee if applicable

Checkbox:

`I understand that I retain the stock's downside and give up gains above the strike.`

CTA:

`Confirm`

---

# P1 — SUPPORT ATOMIC/BATCHED UX WHERE POSSIBLE

Do not expose:

`Approve → Split → Wrap → Sell`

as four separate conceptual actions if they can be abstracted.

Try to provide:

`Review → Confirm → Done`

Use batching/account abstraction where practical.

If multiple wallet confirmations are unavoidable:

`Step 1 of 2 · Approve stock`

`Step 2 of 2 · Create and sell position`

Explain why each signature is needed.

---

# P1 — CREATE BUY-UPSIDE MODE

The protocol needs N buyers, so give them a deliberately separate experience.

Route/tab:

`Buy Upside`

Copy:

`Get leveraged upside without liquidation.`

For every position show:

`Stock`
`Reference price`
`Strike`
`Expiry`
`Premium`
`Break-even`
`Maximum loss`

Example:

`Pay 6.20 USDC`

`Maximum loss: 6.20 USDC`

`Starts paying above: $340`

`Break-even: approximately $346.20`

CTA:

`Buy Upside`

Risk copy:

`The upside claim can expire worthless. Your maximum loss is the premium you pay.`

Do not market this as leverage unless the payoff and legal framing support that terminology.

---

# P1 — HANDLE NO-LIQUIDITY STATES PROPERLY

This is extremely important.

If there is no N buyer:

Do NOT display:

`Premium: 0`

Display:

`No live bid`

Then:

`There is currently no buyer for this strike.`

Advanced CTA:

`Create & list position`

or

`Notify me when a bid appears`

Never imply execution is guaranteed.

---

# P1 — BUILD A PORTFOLIO PAGE

Route:

`/portfolio`

Sections:

### Active positions

Show:

* stock
* quantity
* strike
* expiry
* premium earned
* current reference price
* position status
* time remaining
* action

### Ready to settle

Show:

`Settle / Redeem`

### Expired positions

Show:

* premium earned
* settlement price
* redemption amount
* realized outcome

### History

Show:

* deposits
* premium receipts
* N sales
* merges
* settlements
* redemptions

Summary cards:

`Stock deposited`

`Premium earned`

`Active notional`

`Next expiry`

Do not call premium “profit” because the stock itself may have declined.

---

# P1 — BUILD AUTO-ROLL UX

This should become a major retention feature.

After expiry:

`Roll into next strategy`

Allow preferences such as:

`Conservative`
Sell further OTM.

`Balanced`
Middle strike.

`Higher Premium`
Closer strike.

Advanced users can select exact strike/expiry.

Before auto-roll is actually automated, label it honestly:

`Recommended next strategy`

Do not claim automatic execution until implemented.

---

# P1 — CORPORATE-ACTION UX

Create explicit UI states for:

* dividend
* stock split
* reverse split
* multiplier update
* oracle pause
* issuer announcement

Add an information banner:

`Corporate action in progress`

`Coinbase has scheduled a B20 multiplier update. New positions are temporarily unavailable until the settlement reference is synchronized.`

Add advanced details:

`Raw amount`
`B20 multiplier`
`Share-equivalent amount`
`Effective strike`

Explain why effective strike can differ after corporate actions.

---

# P1 — REWRITE RISK LANGUAGE

Current homepage puts a very technical seizure/short-vault warning extremely early.

Keep risk disclosure, but reorganize it.

Homepage risk summary:

### Stock downside

`Selling upside does not protect your principal. If the stock falls, your position falls with it; the premium only provides a limited offset.`

### Capped upside

`If the stock finishes above your strike, you give up the value above that strike.`

### Liquidity

`Premiums and exits depend on available counterparties.`

### Tokenized-stock risk

`Coinbase Tokenized Stocks are subject to issuer terms, transfer policies, custody arrangements and jurisdictional restrictions.`

Then:

`Read all risks →`

Put technical details about issuer policy/seizure/short-vault behavior inside the dedicated risk page.

---

# P1 — ADD A PROPER RISK PAGE

Route:

`/risks`

Include:

* smart-contract risk
* unaudited status
* tokenized-security risk
* issuer risk
* custodian risk
* B20 policy/blocklist risk
* B20 pause risk
* oracle risk
* oracle staleness
* corporate-action risk
* liquidity risk
* counterparty/quote risk
* capped-upside risk
* stock downside risk
* settlement risk
* Base network risk
* regulatory/jurisdiction risk

Do not hide material risk in FAQ accordions.

---

# P1 — FIX THE “ISSUER RISK” MARKET CARD

Replace:

`Coinbase, custodied by Alpaca under ADGM...`

with something more professional:

### Underlying asset

`Coinbase Tokenized Stock (B20)`

`Backed by an underlying share held through the issuer's regulated custody structure.`

Links:

`Official token details`

`Prospectus`

`B20 contract`

Then keep Erodoro-specific issuer-control risks separately.

---

# P1 — ADD A BASE ECOSYSTEM / INFRASTRUCTURE SECTION

Only show integrations that actually exist.

Possible structure:

`Built for the Base stock ecosystem`

### Base

`Execution and settlement network`

### Coinbase Tokenized Stocks

`B20 tokenized-equity collateral`

### Chainlink

`Tokenized-stock reference data`

### Aerodrome

`Underlying stock liquidity`

Add:

`Third-party integrations do not imply endorsement or partnership.`

Do not make this look like a “Partners” section unless they are actually partners.

---

# P1 — ADD “GET THE STOCK” ONBOARDING

Many users will arrive with USDC rather than AAPLc/NVDAc.

When wallet balance is zero:

`You need AAPLc to sell AAPL upside.`

Buttons:

`Buy AAPLc with USDC`

`Learn about Coinbase Tokenized Stocks`

After successful acquisition:

`You now hold 1.00 AAPLc`

CTA:

`Choose an income strategy`

Make this flow extremely easy.

---

# P1 — MOBILE UX

Optimize specifically for Base App's in-app mobile browser.

Test:

* [~] 375px width — Earn and Markets layout smoke passes; wallet flow remains.
* [~] 390px width — Earn and Markets layout smoke passes; wallet flow remains.
* [~] 430px width — Earn and Markets layout smoke passes; wallet flow remains.
* [~] 768px — Earn and Markets layout smoke passes after moving the full app
  navigation to the large-screen breakpoint.
* [~] 1440px — Earn and Markets layout smoke passes; wallet flow remains.

Mobile markets table must become cards.

Do not horizontally scroll a desktop table.

Strategy card on mobile should show:

`AAPLc`

`Sell above $340`

`21 days`

`Premium: 6.20 USDC`

`+9.6% upside retained`

`View strategy`

Sticky bottom action on detail page:

`Review & Sell Upside`

Ensure wallet modals work correctly inside Base App.

---

# P2 — BASE APP INTEGRATION

Register Erodoro on Base.dev.

Complete:

* [ ] Name
* [ ] Icon
* [ ] Tagline
* [ ] Description
* [ ] Screenshots
* [ ] Category
* [ ] Primary URL
* [ ] Builder Code

The app should work as a normal standard web app.

Use:

* wagmi
* viem
* Base-compatible wallet connector

Use SIWE only if actual authentication/session functionality requires it.

---

# P2 — IMPLEMENT BASE BUILDER CODES

Get Erodoro's Builder Code from Base.dev.

Implement ERC-8021 attribution on transactions originating from Erodoro.

Configure the Wagmi/Viem client so attribution applies automatically rather than being manually added to every button.

Track successful attribution inside Base.dev.

This is important for:

* Base analytics
* app attribution
* possible rewards
* Base discovery surfaces
* ecosystem conversations

---

# P2 — BASE APP NOTIFICATIONS

If available/appropriate, allow users to opt into notifications.

Useful notifications:

`Your AAPLc position expires tomorrow.`

`Your AAPLc position is ready to redeem.`

`A new bid is available for your selected strike.`

`Your position earned 6.20 USDC in premium.`

`A new NVDAc strategy is available.`

Do not spam users with price notifications.

---

# P2 — ADD SHAREABLE PREMIUM RECEIPTS

After a successful position:

Create a share card:

`AAPL Income Position`

`1.00 AAPLc`

`Strike: $340`

`21 days`

`Premium earned: 6.20 USDC`

`Powered by Erodoro · Base`

After expiry:

`This position generated 6.20 USDC in premium.`

Button:

`Share`

Never say:

`I made $6.20 profit`

unless total stock P&L is included.

This becomes a GTM/referral loop.

---

# P2 — REFERRAL INFRASTRUCTURE

Implement attribution:

`?ref=CODE`

Persist referral through:

* landing
* wallet connection
* strategy selection
* successful funded position

Dashboard should distinguish:

`Visitor`
`Connected wallet`
`Quote`
`Funded user`
`Repeat user`

Do not build points/rewards until there is an actual rewards design.

---

# P2 — EVENT / EARNINGS DISCOVERY

Eventually add contextual events such as:

`AAPL earnings in 4 days`

`NVDA earnings this week`

This can make strategy selection easier.

Do not give directional investment recommendations.

Use neutral language:

`Upcoming event may affect volatility and option premiums.`

This can later become an acquisition channel.

---

# P2 — ADVANCED MARKET VIEW

Keep a separate interface for sophisticated users.

Route:

`/markets`

or toggle:

`Advanced`

Advanced information:

* P token ID/address
* N token ID/address
* raw collateral amount
* scaled collateral amount
* multiplier
* oracle
* oracle updatedAt
* oracle status
* settlement delay
* maximum price lag
* protocol fee
* contract addresses
* total locked
* N bids
* market settlement data

Move the current technical market-page content here.

Do not delete it; just stop making it the primary retail experience.

---

# P2 — SETTLED MARKET PAGE

Improve the current settled page.

Show:

### Settlement

`Settlement price`

`Effective strike`

`Oracle timestamp`

`Oracle source`

`B20 multiplier`

### Seller outcome

`Premium originally received`

`Collateral redeemable`

`Upside transferred`

### Buyer outcome

`Premium originally paid`

`N payout`

### Pools

Advanced only:

`P pool`

`N pool`

Primary CTA:

`Redeem`

Secondary:

`Roll into next strategy`

Do not make users interpret decimal P/N pool numbers to understand their outcome.

---

# P2 — PROTOCOL DOCUMENTATION

Create:

`/docs`

Subpages:

`/docs/how-it-works`

`/docs/p-and-n`

`/docs/settlement`

`/docs/b20`

`/docs/corporate-actions`

`/docs/contracts`

`/docs/fees`

`/risks`

The documentation should explain the protocol primitive in detail without forcing that complexity onto the landing page.

---

# P2 — FOOTER

Replace the current minimal `erodoro Base settlement` footer.

Use:

### Product

`Earn`
`Markets`
`Portfolio`

### Learn

`How it works`
`Docs`
`Risks`

### Developers

`Contracts`
`GitHub`

### Community

`X`

Only add Discord/Telegram if they actually exist.

Bottom line:

`Built on Base`

`Erodoro is not affiliated with or endorsed by Coinbase, Base, Aerodrome or Chainlink unless otherwise stated.`

Add legal links:

`Terms`
`Privacy`
`Risk Disclosure`

---

# P2 — JURISDICTION / ELIGIBILITY

Coinbase Tokenized Stocks themselves are not globally unrestricted.

* [ ] Do not use copy implying universal availability.
* [ ] Add clear eligibility disclosure.
* [ ] Specifically disclose that the underlying Coinbase Tokenized Stocks are not available to persons in the United States and may be restricted elsewhere.
* [ ] Link users to official issuer eligibility information.
* [ ] Do not build a fake KYC system simply because the underlying is a security.
* [ ] Obtain legal review before deciding whether the Erodoro frontend requires additional access restrictions/geofencing.

---

# P2 — SEO / SOCIAL METADATA

Change title from:

`erodoro · sell tokenized-equity upside`

to something clearer:

`Erodoro — Earn Premium on Tokenized Stocks`

Meta description:

`Sell upside on Coinbase Tokenized Stocks and earn USDC premium through fully collateralized markets on Base.`

Add:

* favicon
* canonical URL
* OpenGraph title
* OpenGraph description
* OpenGraph image
* Twitter/X card
* proper page titles for each market

Example:

`AAPLc $340 · Sep 18 | Erodoro`

---

# P2 — ANALYTICS

Track the funnel:

`landing_view`

`explore_strategies_clicked`

`wallet_connect_started`

`wallet_connected`

`stock_selected`

`strategy_selected`

`quote_requested`

`quote_received`

`review_position`

`transaction_started`

`position_created`

`N_sale_filled`

`premium_received`

`portfolio_viewed`

`position_redeemed`

`roll_clicked`

`share_receipt_clicked`

`referral_conversion`

Most important metrics:

1. Funded users
2. Stock notional deposited
3. N notional successfully sold
4. Premium paid to sellers
5. Bid fill rate
6. Average spread
7. Repeat/roll rate
8. Funded-user referral conversion

Do not optimize around connected-wallet count.

---

# P3 — PRODUCT METRICS ON HOMEPAGE

Once real mainnet data exists, add:

`Stock notional earning premium`

`Premium paid`

`Positions settled`

Do not show:

`100k users`

unless they are actual funded/meaningful users.

Do not manufacture TVL.

Before mainnet, replace metrics with:

`Preview · Mainnet coming soon`

---

# P3 — TRUST / SECURITY

Add a persistent status indicator:

Before audit:

`Unaudited`

After audit:

`Audited by [auditor]`

Never call internal tests an audit.

Add:

* contract verification links
* deployed contract addresses
* audit report
* bug bounty when available
* multisig/admin information
* emergency-pause information
* version number

If mainnet is not live:

`No Erodoro mainnet contracts are currently deployed.`

Make this impossible to miss.

---

# P3 — LOADING / ERROR STATES

Every onchain query needs:

* skeleton
* loading
* error
* retry
* empty state

Examples:

`Unable to load current Chainlink reference price.`

`No active markets.`

`No live bids available.`

`Your wallet does not hold this stock.`

`This token is currently restricted from transferring.`

`Settlement oracle is temporarily paused.`

Never silently display `$0`.

---

# P3 — NETWORK / WALLET STATES

Handle:

* wallet disconnected
* wrong chain
* unsupported wallet
* Base connected
* transaction rejected
* insufficient ETH for gas
* insufficient stock balance
* insufficient USDC
* approval failure
* B20 policy revert
* protocol pause
* stale oracle
* expired quote
* quote changed before transaction inclusion

Quote changes should trigger:

`Quote changed`

`Previous: 6.20 USDC`

`Current: 5.94 USDC`

`Accept new quote`

---

# P3 — DESIGN LANGUAGE

Target aesthetic:

**professional financial infrastructure + Base-native DeFi**

Avoid:

* casino aesthetics
* neon gradients everywhere
* excessive crypto slang
* giant APYs
* “degen” terminology
* unnecessary token symbols
* dense protocol jargon

Use:

* strong typography
* large numeric values
* generous whitespace
* muted borders
* clear status pills
* stock logos
* Base branding only within brand guidelines
* USDC amounts in financial-number formatting
* exact dates and expiries
* subtle animation only where it communicates state

The product should feel closer to a modern trading/wealth-management product than a yield farm.

---

# P3 — INFORMATION HIERARCHY

Normal user should see:

1. What can I earn?
2. What stock do I deposit?
3. How much upside am I giving up?
4. When does it expire?
5. What can I lose?
6. What do I click?

Only after that:

7. P/N mechanics
8. oracle addresses
9. token IDs
10. confidence thresholds
11. settlement delay
12. raw contract parameters

---

# P3 — REMOVE UNNECESSARY TECHNICAL DETAIL FROM PRIMARY UI

Move these out of the main action area:

`id 0x1000`

`id 0x1001`

`Confidence policy 500 bps`

`Price decimals 8`

`Settlement delay 300s`

`Max price lag 3600s`

These belong in:

`Advanced details`

or:

`Protocol parameters`

---

# P3 — DO NOT BUILD THESE YET

Do not prioritize:

* Erodoro governance token
* points program
* NFT badges
* complex gamification
* 13+ stock listings
* hundreds of strikes
* dozens of expiries
* N AMM for every market
* cross-chain deployment
* leverage for sellers
* social feed
* AI strategy agent

First solve:

`AAPLc/NVDAc → live quote → sell upside → receive premium → settle correctly → roll`

Then expand.

---

# P3 — LIQUIDITY-FIRST MARKET STRUCTURE

Design front end to support an RFQ / professional market-maker model.

For every market expose:

`Best bid`

`Available size`

`Quote expiry`

`Counterparty count` if appropriate

If multiple quotes:

show best execution automatically.

Do not require retail sellers to understand or manually trade N on an AMM.

Advanced users can still withdraw/trade N if the protocol allows it.

---

# P3 — INITIAL MARKET CONCENTRATION

For first mainnet release:

Prioritize:

1. AAPLc
2. NVDAc

Then:

3. METAc
4. GOOGLc

Keep expiries concentrated.

Example initial product design:

* weekly
* 2-week
* monthly

Keep strike selection concentrated around a few useful ranges.

Do not fragment early liquidity across dozens of combinations.

---

# P3 — FIRST-TIME USER FLOW TARGET

A brand-new stock holder should be able to:

1. Visit Erodoro
2. Understand product in <10 seconds
3. Connect wallet
4. See their AAPLc/NVDAc
5. Pick a strategy
6. See exact premium and trade-off
7. Confirm
8. Receive USDC
9. See position in Portfolio

without ever having to learn the phrase:

`P + N`

---

# P3 — RETURNING USER FLOW

Returning user should immediately see:

`You have 2 active positions`

`Next expiry: 3d 14h`

`Premium earned: 18.40 USDC`

`1 position ready to redeem`

Buttons:

`View position`

`Redeem`

`Roll`

---

# P3 — GROWTH LOOP BUILT INTO PRODUCT

After each successful trade:

`You earned 6.20 USDC for selling AAPL upside.`

Buttons:

`View position`

`Share`

At expiry:

`Your AAPL strategy has settled.`

`Premium received: 6.20 USDC`

`Redeem`

`Roll again`

The product should naturally create:

`deposit → premium → expiry → roll → premium`

rather than requiring continuous new user acquisition.

---

# FINAL HOMEPAGE STRUCTURE

Build homepage in exactly this order:

1. Navigation
2. Hero
3. Supported stocks / opportunity cards
4. Why Erodoro
5. How it works
6. Interactive example/payoff
7. Featured live strategies
8. Base ecosystem/infrastructure
9. Risk summary
10. FAQ
11. Footer

Do not put the full risk section before the user understands the product.

---

# FINAL PRIMARY COPY

Hero:

## Earn premium on your tokenized stocks.

`Choose how much upside you're willing to sell. Erodoro turns that upside into a tradable claim and pays you the premium in USDC when a buyer fills it.`

CTA:

`Explore strategies`

Secondary:

`How it works`

Supporting line:

`Fully collateralized · No seller liquidations · Built on Base`

Risk line:

`You retain the stock's downside and give up gains above your selected strike.`

---

# FINAL MARKET CARD TEMPLATE

**AAPLc · Apple**

`Reference price     $310.20`

`Sell above          $340.00`

`Upside retained     +9.6%`

`Expiry              21 days`

`Best premium        6.20 USDC`

`Term yield          2.00%`

`Available bid       8.4 AAPLc`

CTA:

`Sell upside`

If no quote:

`No live bid`

CTA:

`View market`

Never fake this data.

---

# ACCEPTANCE CRITERIA BEFORE SHIPPING

* [ ] No dead links.
* [ ] No zero addresses displayed as real contracts.
* [ ] No fake mainnet TVL.
* [ ] No fake premiums.
* [ ] No fake market activity.
* [ ] No incorrect Pyth/Chainlink wording.
* [ ] B20 multiplier accounted for.
* [ ] B20 authorization/pause states handled.
* [ ] Oracle staleness handled.
* [ ] Corporate-action pause handled.
* [ ] Only officially live Coinbase Tokenized Stocks enabled.
* [ ] All stock identities validated by contract address.
* [ ] Wrong-chain state works.
* [ ] Mobile Base App experience works.
* [ ] User can understand payoff without knowing P/N.
* [ ] Seller sees exact downside/upside trade-off before confirming.
* [ ] Buyer sees maximum loss and break-even before confirming.
* [ ] No quote means no execution CTA.
* [ ] Demo data cannot be confused with real data.
* [ ] Mainnet and preview environments are clearly separated.
* [ ] Base.dev project registered.
* [ ] Builder Code attribution implemented.
* [ ] Analytics funnel implemented.
* [ ] Risks page implemented.
* [ ] Terms/privacy placeholders replaced with real documents before public mainnet.
* [ ] Lighthouse/accessibility/performance pass completed.
* [ ] Test responsive layout at 375px, 390px, 430px, 768px and 1440px.
* [ ] All external integrations are described accurately and never falsely presented as partnerships.

## Ultimate design rule

Whenever there is a choice between showing:

`P / N / wrapper / token ID / oracle parameter`

and showing:

`premium / strike / expiry / upside retained / risk`

show the **financial outcome first**.

P and N are Erodoro's protocol architecture.

**Selling upside and earning premium is Erodoro's product.**
