# Plan — Base-native foundations first, indexing later + CI fix

Owner: opencode. Work top to bottom. A checkbox is only ticked after the named
check passes locally or on chain. Each item lists its files, subtasks and
verification so it can be executed without re-deriving decisions.

Authoritative context: [`status.md`](status.md), [`todo.md`](todo.md),
[`contracts/SECURITY.md`](contracts/SECURITY.md),
[`contracts/docs/known-limitations.md`](contracts/docs/known-limitations.md).

Status legend: `[ ]` not started · `[~]` partial · `[x]` done with evidence ·
`[!]` blocked with the blocker named.

---

## Task 0 — Fix the failing `main` CI (blocking, do first)

Symptom: `web-and-rfq` fails at `pnpm test:e2e` with
`E2E FAIL: Error: no winner declared` (`scripts/e2e-auction.mjs:161`).

Cause: commit `8e73316` changed PATH A to a visible 10-minute competition
(`FAST_AUCTION_SECONDS: 600`), so `tickAuction` only crowns a winner once the
fast window closes. The e2e still ticks with the real wall clock.

* [x] 0.1 Thread optional `nowSeconds` through `tickAuction`
  (`cloudflare/auction-routes.mjs`); defaults to `Date.now()`, the HTTP route
  never passes it. Injecting the clock is test-only and not caller-reachable.
* [x] 0.2 `scripts/e2e-auction.mjs`: register with `FAST_AUCTION_SECONDS: "20"`
  and tick at `now + 21` (past the window, inside the 600s bid expiry).
* [x] 0.3 `pnpm test` and `pnpm test:e2e` pass locally.
* [x] 0.4 Re-run the full CI list on a clean `HEAD` with only this fix, because
  the first failure masked later steps (lint, product-logic, portfolio balances,
  stock-swap, build, export, browser/responsive/premium-history checks).
  Known risk: `check:export` throws
  `app.html is missing its expected content: Choose where to sell your upside`
  on the dirty tree — confirm on clean `HEAD` and fix the export, not the check.
* [x] 0.5 Commit only the CI-fix files and push to `main`.

## Execution order for the 12 additions

The brief numbers the additions 1–12; this is the required build order. Finish
and verify every Base-native foundation before introducing D1 or any derived
ledger. The chain remains the source of truth throughout. Both numbering
schemes are kept so the brief can be followed directly.

| Order | Brief # | Item |
| --- | --- | --- |
| 0 | Foundation | Onchain auction source of truth + direct RPC reads |
| 1 | 2 | B20-native accounting everywhere |
| 2 | 3 | Official Chainlink stock-feed adapter (no double multiplier) |
| 3 | 4 | 0x swaps replacing direct Aerodrome routing |
| 4 | 1 | Base Account connector + atomic call batching |
| 5 | 10 | Paymaster sponsorship for selected actions |
| 6 | 5 | EIP-3009-funded auction bids |
| 7 | 6 | Atomic seller/protocol fee splitting |
| 8 | 9 | Builder Codes (ERC-8021) |
| 9 | 11 | Base Verify for faucet/reward anti-Sybil |
| 10 | 12 | Base finality transaction-status UX |
| 11 | 7 | Durable D1 event indexer |
| 12 | 8 | Settlement reconciliation ledger |

Not built yet (see brief): native EIP-8130 account abstraction, Validity
Transactions, Morpho inside Erodoro Earn. Tracked here as `[!]` at the end.

---

# Phase 1 — Base-native foundations (complete before any indexer)

Phase gate: Items 2, 3, 4, 1, 10, 5, 6, 9, 11 and 12 must pass their tests
and Base Sepolia smoke checks before Item 7 starts. During this phase the app
reads current state directly from contracts and uses bounded `eth_getLogs`
queries for recent history. Do not add D1, Durable Objects, a derived auction
database, or an offchain source of truth to work around missing contract state.

## Foundation — Onchain auction source of truth

The Base docs provide B20, USDC payment primitives, RPC, wallets, feeds and 0x;
they do not provide an auction protocol. Keep Erodoro's auction correctness in
contracts so the later indexer is only a disposable read cache.

* [x] F.1 Add an enumerable `ErodoroAuctionHouse` that stores seller, series,
  N claim, quantity, floor, best funded bid, bidder, start/end time, rollover
  permission and status. Expose paginated `getActiveAuctions` and per-wallet
  reads so the app works without a database. Evidence:
  `contracts/src/ErodoroAuctionHouse.sol` (`getActiveAuctions`,
  `auctionsOfSeller`, `auctionsOfBidder`, `isLive`, `isActive`).
* [x] F.2 Escrow N before opening; escrow bidder USDC before counting a bid;
  finalize N → winner and USDC → seller/fee recipients atomically after the
  ten-minute window. Use pull refunds for displaced bidders. Evidence:
  `createAuction`, `placeBid`, `finalizeAuction`, `refundableOf`,
  `withdrawRefund`.
* [x] F.3 Make `finalizeAuction` and no-bid `rolloverAuction` permissionless.
  Contracts cannot wake themselves, so the app clearly offers the required
  transaction after the deadline. Evidence: both have no caller gate; tested
  with a stranger keeper. Frontend surfacing after the deadline is part of the
  later app migration, tracked under Item 7.9/12.
* [x] F.4 Emit `AuctionCreated`, `BidPlaced`, `RefundAvailable`,
  `AuctionFinalized`, `AuctionRolledOver` and `AuctionCancelled`. Current state
  comes from contract reads; bounded `eth_getLogs` is used only for history.
* [x] F.5 Prove floor enforcement, bid ordering, exact escrow conservation,
  cancellation rules, rollover, partial-fill policy, reentrancy resistance and
  failed-token-transfer atomicity with Foundry tests. Evidence:
  `contracts/test/unit/ErodoroAuctionHouse.t.sol` — 28 tests, 0 failed
  (`forge test --offline`: 192 passed, 0 failed with only these files on clean
  `HEAD`). Full-size-only bids are the partial-fill policy; `ReentrancyGuard`
  guards every state-changing path; a fee-on-transfer quote reverts
  `QuoteTransferShort`.
  Remaining from F: the app still reads the off-chain coordinator; migrating
  the frontend onto house reads is required before the Foundation is a product
  gate (see Phase 1 gate).

# Item 2 — B20-native accounting everywhere

B20 balances are raw units scaled by a mutable multiplier; approvals are not
policy-gated. Treat tokens by address, never ticker.

* [x] 2.1 Audit every read of a B20 balance and route it through
  `scaledBalanceOf`/`multiplier`/`toScaledBalance`/`toRawBalance`
  (`app/lib/use-b20.ts`, `use-stock-balances.ts`, `use-balances.ts`,
  `market-status.ts`). Evidence: `useStockBalances` now reads `balanceOf` (exact
  raw), `scaledBalanceOf` (share-equivalent) and `multiplier` per token;
  `toScaledBalance`/`toRawBalance` added to `use-b20.ts`. `use-balances.ts`
  reads vault P/N (raw ERC-6909 units) and collateral; those are not
  multiplier-scaled token balances. `market-status.ts` reads no balances —
  audit recorded, no change needed.
* [x] 2.2 Show share-equivalents in the Earn quantity selector, portfolio,
  auction size, P/N claim math and swap inputs; keep raw units in advanced
  details only. Evidence: Earn stock cards and `TokenBalances` show
  `scaledBalanceOf` shares; `AssetSelector` shows shares. Raw remains available
  for approvals and max-quantity checks. Auction-size and swap-input surfaces
  fold into Item 4 / the app migration, where those flows are reworked.
* [x] 2.3 Preflight `isPaused(TRANSFER)`,
  `isAuthorized(TRANSFER_SENDER_POLICY, seller)` and
  `isAuthorized(TRANSFER_RECEIVER_POLICY, vault/intent)` before approving, and
  keep the separate allowance gate. Evidence: `transferGate` in
  `app/lib/use-actions.ts` runs before the allowance read in `approveAndSplit`
  and explains the block; the allowance gate is unchanged and separate.
* [x] 2.4 Read `MultiplierUpdated` and `Announcement`; surface corporate-action
  warnings; treat metadata as mutable. Evidence: `use-announcements.ts` already
  reads both events and `disclosures-panel.tsx` surfaces them; no change.
* [x] 2.5 Extend settlement/redemption tests to cover a split under raw and
  multiplier-adjusted modes and a transfer pause. `[!]` scheduled multiplier
  changes stay blocked — the live release does not expose `effectiveAt()`.
  Evidence: `contracts/test/unit/CorporateActions.t.sol` adds split → settle →
  redeem conservation and transfer-pause split/redeem tests (12 tests pass). The
  multiplier-adjusted (total-return) settlement mode is completed with the
  explicit modes in Item 3.

# Item 3 — Official Chainlink tokenized-stock feeds

Chainlink stock feeds already publish a total-return value that incorporates the
B20 multiplier. Introducing them into the existing strike-adjustment path would
apply the multiplier twice.

* [x] 3.1 Add explicit oracle modes to the series model:
  `RAW_UNDERLYING_PRICE` and `MULTIPLIER_ADJUSTED_TOKEN_PRICE`; settlement
  rejects a mode mismatch. Evidence: `SettlementModel` documents the exact
  alias mapping (`RAW_SHARE` = `RAW_UNDERLYING_PRICE`, `TOTAL_RETURN` =
  `MULTIPLIER_ADJUSTED_TOKEN_PRICE`); `ErodoroVault.settle` and
  `settleFallback` now re-check `settlementModel()` and revert
  `OraclePairInvalid` on a mismatch. Tested in
  `ErodoroVault.t.sol::test_settleRejectsAModelMismatch`.
* [x] 3.2 Bind `ChainlinkTotalReturnAdapter` to a caller-selected historical
  round and prove it is the first round after maturity; convert `updatedAt` into
  the market's window. Evidence: `_readCandidate` + `_requirePreviousBefore`
  already enforce this; `test_theSelectedRoundMustBeTheFirstAfterMaturity` and
  `test_firstRoundOfAPhaseIsRefused` pin it.
* [x] 3.3 For Base-provided feeds set mode = `MULTIPLIER_ADJUSTED_TOKEN_PRICE`
  and do not apply the B20 multiplier in the adapter. Evidence: the adapter
  declares `TOTAL_RETURN` and never reads the multiplier;
  `ErodoroVault._quoteValue` keeps the stored strike for that model.
  `script/CheckChainlinkBinding.s.sol` is the deploy-time gate asserting the
  binding is total-return, matches the intended feed and token, and is not
  paused.
* [x] 3.4 Reject stale data and `CoinbaseFeedStatus` registry pauses; surface
  `Oracle paused for corporate action`. Evidence: new
  `Errors.OraclePausedForCorporateAction`; the adapter distinguishes a
  registry pause from a missing feed and exposes `oracleParams()`;
  `use-oracle.ts` reads the issuer registry and returns a `paused` state that
  `oracle-panel.tsx` renders as "Oracle paused for corporate action".
* [x] 3.5 Test a 2-for-1 split under both modes and prove no double adjustment;
  record a canonical deployment as a release gate. Evidence:
  `ErodoroVault.t.sol::test_theTwoModesApplyTheMultiplierExactlyOnce` proves
  raw mode scales the strike and total-return mode keeps it, and that applying
  the adjusted strike to a total-return price differs; the split conservation
  tests in Item 2.5 cover redemption. The canonical deployment gate is
  `script/CheckChainlinkBinding.s.sol`; wiring it into CI is tracked with the
  deployment pipeline (no mainnet deployment exists yet).

# Item 4 — 0x swaps replacing direct Aerodrome routing

* [x] 4.1 Proxy `0x` `/price` (editing) and `/quote` (confirming) through the
  Worker; keep the API key in a Worker secret. Evidence:
  `cloudflare/zeroex.mjs` + `zeroex.test.mjs` (6 tests); routes
  `/api/swap/price` and `/api/swap/quote` in `worker.mjs`; `ZEROX_API_KEY`
  secret and `ZEROX_USDC` var documented in `wrangler.jsonc` and
  `docs/stock-swaps.md`. Unset key returns 503, never an unauthenticated route.
* [x] 4.2 Replace `app/lib/stock-swap.ts` /
  `execute-stock-swap.ts` routing with returned executable transaction data;
  report allowance, balance and simulation issues. Evidence: `stock-swap.ts`
  is now catalog types + pinned constants; `execute-stock-swap.ts` deleted;
  `app/lib/zeroex-swap.ts` fetches price/quote, parses 0x's transaction and
  surfaces `issues.balance` / `issues.allowance` in the swap UI.
* [x] 4.3 Approve only the returned `AllowanceHolder`/`Permit2` spender, never
  the Settler contract; pin chain and spender, simulate before send. Evidence:
  the approval target is `quote.allowanceTarget` and nothing else; the
  executor refuses a quote without a valid target before signing; the swap
  simulates via `client.call` and sends the returned calldata unchanged.
  `check-stock-swap.mjs` asserts the spender and calldata.
* [x] 4.4 Keep a test swap/faucet path for Sepolia test assets; gate 0x to Base
  mainnet. Evidence: the Worker pins `chainId === 8453` and returns 400
  otherwise; test assets use the existing Sepolia faucet, untouched. The swap
  UI already shows the Base-Mainnet-only screen on Sepolia.
* [x] 4.5 Rework `app/scripts/check-stock-swap.mjs` and
  `check-stock-swap-browser.mjs` around the new path. Evidence: both rewritten
  and passing; browser check drives the real client against a fixture 0x
  response (quote lifecycle, failure copy, USDC-leg derivation, viewports).

# Item 1 — Base Account, batching and gas sponsorship

* [x] 1.1 Detect `wallet_sendCalls` support; add Base Account connector without
  moving users off their injected wallet silently. Evidence:
  `app/lib/batching.ts` reads EIP-5792 `wallet_getCapabilities` and treats
  `atomic.status` of `supported`/`ready` as batchable; `canBatchAtomically`
  returns false on any error or unknown chain. `app/lib/wagmi.ts` adds
  `baseAccount({ appName: "Erodoro" })` beside `injected()`; the connector is
  offered, never auto-selected. `check-account-batching.mjs` covers status
  parsing, per-chain scoping, and the throwing/unsupported fallback. The
  server/prerender bundle stubs `@base-org/account` (`next.config.ts`) because
  only the browser reaches it.
* [x] 1.2 One-confirmation batches: seller `approve stock + open auction`; buyer
  `approve USDC + settle`; swap `approve token + 0x route`. Evidence: each write
  hook gates on `canBatchAtomically` and calls `sendAtomicBatch`
  (`forceAtomic: true`, waits for status `success`): `app/lib/use-actions.ts`
  (`approve` + `split`), `app/lib/use-intent.ts` (`useBidder.settle` preflights
  `checkIntent` then batches `approve` + `fillIntent`),
  `app/lib/use-rfq.ts` (`setOperator` + `fill`), and
  `app/lib/zeroex-swap.ts` (`approve` + the returned 0x calldata). Every path
  keeps the sequential fallback. `check-stock-swap.mjs` asserts the two-call
  bundle and no separate approval; `check-rfq-sale.mjs` asserts the batched
  sale; `check-auction-purchase.cjs` keeps covering the fallback. Root
  `pnpm test` 53 pass; `check:product-logic` passes.
* [~] 1.3 Passkey/social onboarding; scope a spend permission so repeat bids do
  not re-approve USDC. Partial: the Base Account connector provides passkey and
  social onboarding, and `app/lib/spend-permission.ts` exposes
  `requestUsdcSpendPermission`/`listUsdcSpendPermissions` and an
  `isBaseAccountConnector` gate (injected wallets are never asked).
  `check-account-batching.mjs` covers the connector gate. Blocker: spending a
  permission during settlement needs `ErodoroIntent` to redeem the Base
  `SpendPermissionManager`, which is a contract change tracked outside Item 1;
  until then bids keep the exact-amount `approve` path (now batched).
* [x] 1.4 Keep the injected-wallet flow as the fallback and show which path is
  active. Evidence: `injected()` remains first in `wagmi.ts` and every batch
  branch falls back to the two-step flow; `app/components/connect-button.tsx`
  uses `useBatchMode` (`app/lib/use-batching.ts`) to show "Approvals batched
  into one confirmation" vs "Two-step approvals on this wallet".
* [x] 1.5 Implement before optimizing the current three-popup permit flow.
  Evidence: the atomic path is additive — the existing permit/sequential flows
  are unchanged when the wallet cannot batch, so batching landed first as
  required.

# Item 10 — Sponsor only the important transactions

* [x] 10.1 CDP paymaster allowlist: chain, contract, function selector, max gas,
  per-wallet rate. Sponsor first test-asset claim, first auction creation,
  settlement, position redemption. Evidence: `cloudflare/paymaster.mjs` builds
  the allowlist from `FAUCET_ADDRESS`/`AUCTION_HOUSE_ADDRESS`/`INTENT_ADDRESS`/
  `VAULT_ADDRESS` and pins the four selectors (`claim` `0x4e71d92d`,
  `createAuction` `0x3ccbcdd5`, `fillIntent` `0x28681828`, `redeem`
  `0xe43f80a5`, taken from the compiled ABIs). `handlePrepare` enforces chain,
  count (≤8), zero value, `maxGas` under `PAYMASTER_MAX_GAS`, and a per-wallet
  `PAYMASTER_DAILY_LIMIT`. Config in `wrangler.jsonc`; `PAYMASTER_URL` and
  `PAYMASTER_API_KEY` are config/secret. App: `app/lib/paymaster.ts` requests
  sponsorship; `sendAtomicBatch({ sponsor: true })` attaches the
  `paymasterService` capability; wired into settlement (`use-intent.ts`),
  redemption (`use-actions.ts`) and the faucet claim (`faucet-screen.tsx`).
  Tests: `cloudflare/paymaster.test.mjs` (7), `check-account-batching.mjs`.
* [~] 10.2 Target: connect → claim stock → start auction with no test ETH.
  Partial: the sponsored paths exist for claim, auction creation, settlement
  and redemption. Blocker: `PAYMASTER_URL`/`PAYMASTER_API_KEY` are not set in
  this environment, so a live no-ETH smoke run cannot be executed here. The
  endpoint returns 503 (unconfigured), never silently unsponsored.
* [x] 10.3 Never sponsor arbitrary calls; fail closed if the selector is not
  allowlisted. Evidence: `validateSponsorRequest` rejects any target/selector
  pair not in the allowlist, wrong chain, non-zero value, and over-cap gas;
  `handlePrepare` returns 403 with `sponsored: false` and never forwards.
  `proxyPaymaster` forwards only `pm_getPaymasterStubData` /
  `pm_getPaymasterData` / `pm_sponsorUserOperation` and refuses anything else.
  A refused or unreachable paymaster never blocks the transaction — it is sent
  user-paid, proven in `check-account-batching.mjs`.

# Item 5 — EIP-3009-funded auction bids

* [x] 5.1 Bidder signs an exact USDC `transferWithAuthorization`, then submits
  it through `placeBidWithAuthorization`; use a fresh random nonce and bounded
  validity window for every attempt. Evidence: `app/lib/eip3009.ts` signs the
  EIP-3009 `ReceiveWithAuthorization` struct with `randomAuthorizationNonce`
  (32 random bytes) and `authorizationWindow` (±60s skew / +300s life);
  `ErodoroAuctionHouse.placeBidWithAuthorization` receives it.
  `check-eip3009.mjs` asserts the domain (`version "2"`, token, chain), the
  exact message fields, parsed `v/r/s`, and that a rejected signature
  propagates.
* [x] 5.2 The auction contract captures the authorization and escrows USDC in
  the same transaction before the bid becomes valid. A signature alone never
  counts as funded because EIP-3009 does not reserve the payer's balance.
  Evidence: `placeBidWithAuthorization` books the bid then calls
  `receiveWithAuthorization` (`to == msg.sender`, so only the house can consume
  it) and requires the exact deposit; any revert undoes the whole call.
  `ErodoroAuctionHouse.t.sol`: `test_authorizationBidFundsAndTakesBest`,
  `test_authorizationAloneIsNotAFundedBid`,
  `test_authorizationRejectsExpiredWindow`,
  `test_authorizationRejectsFutureWindow`,
  `test_authorizationNonceCannotBeReused`,
  `test_authorizationRejectsWrongSigner`,
  `test_authorizationCannotBeFrontRunByAThirdParty` (38 tests pass, part of 213
  across the suite). `TestQuoteToken` now implements EIP-3009 so the testnet
  stand-in matches mainnet USDC.
* [~] 5.3 Track `funded | outbid | won | settled | refunded` from onchain state;
  no coordinator may declare a winner or treat an unfunded signature as money.
  Partial: the contract exposes `bidStatus` (`None/Funded/Outbid/Won`) and
  `refundableOf`, both derived purely from on-chain state, and `finalizeAuction`
  moves both legs atomically; `test_authorizationBidCanBeOutbidAndRefunded`,
  `test_authorizationBidFinalizesAtomically` and `test_bidStatusIsNoneForNonBidders`
  cover it. Blocker: the app does not yet read the AuctionHouse (Foundation
  frontend migration tracked under F.3 / Item 7.9 / 12), so the statuses are not
  surfaced in the UI. `settled` maps to `Won` and `refunded` is the withdrawal
  of `refundableOf`, both by construction.
* [~] 5.4 Partial/variable payment falls back to constrained EIP-2612 or a
  smart-account spend permission. Partial: the AuctionHouse is deliberately
  full-size only and rejects partial amounts
  (`test_partialBidReverts`); variable/partial payment stays on the signed
  `ErodoroIntent` path, whose seller side uses the constrained EIP-2612
  `escrowIntentWithPermit`. Blocker: the smart-account spend-permission
  fallback depends on Item 1.3's contract-side redemption, which is still
  blocked.

# Item 6 — Protocol-fee splitting in atomic settlement

* [x] 6.1 Basis points that must total exactly 10,000; assign rounding dust to a
  designated recipient. Evidence: `ErodoroAuctionHouse.feeSplitBps()` reports
  `sellerBps + protocolBps + referralBps == 10_000` with the seller taking the
  remainder; `setReferralFee` and `_setProtocolFee` reject any combination over
  10,000 (`FeeSplitInvalid`). The fee legs are ceiled in `_bpsCeil`, so rounding
  dust lands with the designated fee recipients and is never silently dropped.
  `test_feeSplitBpsAlwaysTotalsTenThousand`, `test_referralConfigIsBoundedAndAdminOnly`.
* [x] 6.2 Emit one shared settlement reference across legs; settlement object
  carries `clearingPremium`, `grossPayment`, `sellerProceeds`, `protocolFee`,
  `referralFee`. Evidence: `finalizeAuction` emits `Settlement(settlementRef,
  auctionId, winner, clearingPremium, grossPayment, sellerProceeds, protocolFee,
  referralFee)` with
  `settlementRef = keccak256(chainId, house, auctionId, winner, premium)`, and
  `SettlementRecord`/`settlementOf(auctionId)` recompute the same object from
  on-chain config. `test_settlementRecordRecomputesTheSplit`.
* [x] 6.3 Tests for exact conservation, dust routing and a referral leg.
  Evidence: `test_referralLegPaysAndConservesExactly` uses an odd premium,
  asserts `sellerProceeds + protocolFee + referralFee == premium`, the referrer
  is paid exactly `ceil(premium * 100 / 10_000)`, and the house retains nothing;
  `test_referralDisabledWithoutRecipient` pins the zero-referral path. 218
  Foundry tests pass; `ErodoroAuctionHouse` runtime 16,086 B (< 24,576).

# Item 9 — Builder Codes

* [~] 9.1 Register Erodoro on base.dev; add the ERC-8021 `dataSuffix` in the
  Wagmi/viem client so `useSendTransaction`, `useSendCalls` and user operations
  are attributed automatically. Partial: `app/lib/builder-code.ts` validates
  `NEXT_PUBLIC_BUILDER_CODE` and builds the ERC-8021 suffix via
  `ox/erc8021`; `sendAtomicBatch` appends it to every call
  (`attributedCalls`), and the Base Account connector sets
  `preference.attribution.auto` so Smart Wallet calls are attributed even
  before a code exists. `check-builder-code.mjs` proves the suffix decodes to
  the configured codes and that nothing is appended when unset. Blocker:
  registering the code on base.dev and setting `NEXT_PUBLIC_BUILDER_CODE` is an
  external step; the code deliberately does not invent one.
* [~] 9.2 Verify attribution in base.dev. Quickest Base-native win; no contract
  change. Blocker: depends on 9.1's registration; there is no code to verify
  yet.

# Item 11 — Base Verify selectively

* [~] 11.1 Use verified traits for one-person-once reward claims and faucet
  anti-Sybil. Partial: `cloudflare/base-verify.mjs` verifies a signed EIP-712
  trait attestation (`verifyTraitAttestation`), exposes the Worker route
  `POST /api/verify/trait`, and derives one claim key per (trait, subject) with
  `nullifierFor` — the basis for one-person-once. `base-verify.test.mjs` (5
  tests) covers valid/forged signatures, expiry, unknown traits and the route.
  Blocker: the current faucet is permissionless on-chain (`TestFaucet.claim`),
  so there is no verifier-aware claim/reward path to gate yet; a real
  integration needs the faucet/reward claim to consume the nullifier on-chain or
  through a relayer. Until then this is a standalone gate, not enforced
  anti-Sybil.
* [x] 11.2 Never present it as trading eligibility or jurisdiction KYC unless
  the trait explicitly supports that policy. Evidence: `TRAIT_POLICIES` lists
  the purposes each trait may serve; the two supported verification traits
  declare only `sybil-resistance` and `reward-once`, so
  `validateTraitRequest`/`handleVerify` refuse them for `trading-eligibility` or
  `kyc`, and `VERIFY_ALLOW_KYC=1` still cannot promote a trait that does not
  declare those purposes (`base-verify.test.mjs`).

# Item 12 — Transaction-status UX (Base finality stages)

* [x] 12.1 States: Submitted, Preconfirmed, Included, Confirmed, Finalized,
  backed by `updatedAt`/receipt data behind a status-provider abstraction.
  Evidence: `app/lib/finality.ts` defines `FinalityState`, `TxStatusSnapshot`
  (with `submittedAt` and the receipt), the `StatusProvider` interface,
  `createChainStatusProvider(client)`, `readSnapshot`, and `classifyFinality`.
  `check-finality.mjs` walks every transition.
* [x] 12.2 Do not couple to Flashblocks (planned deprecation); use canonical
  block inclusion. Evidence: `createChainStatusProvider` reads only
  `eth_getTransactionReceipt`, `eth_blockNumber`, the canonical `finalized`
  block tag, and the pending pool. `classifyFinality` has no preconfirmation
  input beyond "seen in the mempool", which is labelled separately from Base
  preconfirmations.
* [x] 12.3 No sudden success: map each state to copy and disable double-submit.
  Evidence: `finalityCopy` returns one sentence and a `tone` per state, and
  `canResubmit` is false for every stage except a revert; `check-finality.mjs`
  asserts the intermediate stages stay `pending` and non-resubmittable.

---

# Phase 2 — Indexing and derived reporting (only after Phase 1)

Entry criteria: the onchain auction is enumerable, current auction/portfolio
state works through RPC reads, all Phase 1 checks pass, and measured RPC/log
latency demonstrates which views need caching. D1 must never decide auction
state, custody funds, declare a winner, or become required for settlement.

# Item 7 — Durable D1 event indexer

Replace expensive browser history scans with a persistent, idempotent read
cache on the existing Worker + D1. Base contracts and `eth_getLogs` remain the
source of truth; cursor and logs are written together; only confirmed blocks
are indexed. The app must retain a direct-chain fallback.

### File layout

```
cloudflare/indexer/events.mjs        event registry + decode helper
cloudflare/indexer/store.mjs         D1 + in-memory backends
cloudflare/indexer/indexer.mjs       runIndexer(): cursor, reorg, chunks, decode
cloudflare/indexer/routes.mjs        HTTP handlers
cloudflare/indexer/*.test.mjs        tests
cloudflare/migrations/0001_indexer.sql
cloudflare/worker.mjs                wire routes + scheduled()
wrangler.jsonc                       INDEX_* vars, cron, migrations_dir
```

* [ ] 7.1 Config vars in `wrangler.jsonc`: `INDEX_CHAIN_ID`,
  `INDEX_START_BLOCK` (required; never scan from 0), `INDEX_CONFIRMATIONS`
  (12), `INDEX_OVERLAP_BLOCKS` (64), `INDEX_RANGE_LIMIT` (2000),
  `INDEX_MAX_CHUNKS_PER_TICK` (8), `INDEX_REORG_MAX_DEPTH` (64),
  `INDEX_ADMIN_TOKEN` (secret), `VAULT_ADDRESS`, `FACTORY_ADDRESS`,
  `AUCTION_HOUSE_ADDRESS`, `FAUCET_ADDRESS`, `ISSUER_CONTROLS_ADDRESS`,
  `CLAIM_WRAPPER_ADDRESS`, `INDEX_B20_TOKENS`; reuse existing `RFQ_ADDRESS` and
  `INTENT_ADDRESS` while legacy paths remain supported.
* [ ] 7.2 Schema `cloudflare/migrations/0001_indexer.sql`:
  `indexer_cursor(chain_id PK, block_number, block_hash, updated_at)`,
  `indexer_blocks(chain_id, block_number, block_hash, PK(chain_id,
  block_number))`, `indexer_logs(chain_id, block_number, block_hash, tx_hash,
  tx_index, log_index, contract_role, contract_address, event, topic0,
  series_key, arg0..arg3, args_json, raw_json, indexed_at, PK(chain_id,
  block_hash, tx_hash, log_index))`, plus indexes on
  `(chain_id,event,block_number)`, `(chain_id,contract_role)`,
  `(chain_id,series_key)`, `(chain_id,arg0)`, `(chain_id,arg1)`.
* [ ] 7.3 Ledger lock: `indexer_lock(chain_id PK, holder, locked_until)` lease so
  cron and a manual tick cannot double-process.
* [ ] 7.4 `events.mjs`: register auction creation, bid, refund, finalization,
  rollover and cancellation; SeriesCreated, Split, Merge, Settled,
  FallbackSettled, Redeemed, ShortfallObserved, SettlementHealth, SplitsPaused,
  SplitsUnpaused, AdminRenounced, DustSwept; Filled, NonceCancelled;
  IntentFilled, IntentCancelled, IntentEscrowed; the factory events; Claimed;
  SplitSimulated, TransfersPaused; Wrapped, Unwrapped; and B20 Transfer,
  MultiplierUpdated, Paused, Unpaused, Announcement, EndAnnouncement,
  PolicyUpdated, NameUpdated, SymbolUpdated, SupplyCapUpdated. Topic0 via
  `toEventHash`; `seriesKey` = `arg0` for vault, `claimId & ~1` for rfq/intent.
* [ ] 7.5 `store.mjs`: `migrate`, `getCursor`, `getRecentBlockHashes`,
  `acquireLock`, `commitRange` (one D1 `batch`: delete overlap → chunked
  `INSERT OR REPLACE` → checkpoints → cursor), `deleteThrough`, `queryLogs`,
  `stats`. Memory backend for dev/tests. Chunk inserts to respect D1's 100-bound
  parameter limit.
* [ ] 7.6 `indexer.mjs`: head → safeHead (`head - confirmations`); lease; reorg
  walk-back over stored checkpoints up to `INDEX_REORG_MAX_DEPTH`; rewind +
  `deleteThrough`; `fromBlock = cursor - overlap + 1`; chunk loop to
  `INDEX_MAX_CHUNKS_PER_TICK`; one batched JSON-RPC `eth_getLogs` per address
  with its topic filter; decode known topics only; `hasMore` when
  `toBlock < safeHead`. Never index above `safeHead`.
* [ ] 7.7 Routes + wiring: `GET /api/index/status`, `POST /api/index/tick`
  (Bearer `INDEX_ADMIN_TOKEN`; 503 unset, 401 wrong), `GET /api/index/logs`,
  `GET /api/index/premium?address=` with `totals.earnedRaw/paidRaw`. Add
  `scheduled()` running one tick for cron `*/2 * * * *`.
* [ ] 7.8 Tests: topic/decode, store idempotency + overlap delete + reorg
  replace + lock, indexer confirmation gate + reorg + `hasMore` + unconfigured,
  route auth + premium classification + pagination.
* [ ] 7.9 `app/lib/use-premium-history.ts` reads `/api/index/premium` first,
  keeps the direct RPC/log path as an explicit `source: "chain"` fallback, and
  never exposes internal cursor or loaded-block language to users.

# Item 8 — Settlement reconciliation ledger

Build this as a projection from confirmed indexed events, never as an
independent settlement record.

* [ ] 8.1 D1 ledger joining `auctionId`, `intentDigest`, `bidId`, payment
  authorization nonce, settlement tx, seller payment, protocol fee, P/N
  transfers. Join USDC transfers by settlement event + log index; B20 memos as a
  secondary reference.
* [ ] 8.2 Separate provisional from finalized accounting; portfolio shows
  pending premium, confirmed premium, total earned, premium paid, indicative
  payoff, realized result.
* [ ] 8.3 Rebuild the ledger from chain events in a clean database and prove it
  produces the same totals before enabling it in the portfolio UI.

---

## Blocked / not yet

* [!] Native EIP-8130 account abstraction — Vibenet-only, experimental.
* [!] Validity Transactions — documented as experimental and Vibenet-only.
* [!] Morpho inside Erodoro Earn — would confuse two different products; only an
  explicit opt-in later with yield/liquidity/vault risk disclosed.
* [!] Scheduled multiplier changes — the live B20 release does not expose the
  surface (`effectiveAt()` reverts on AAPLc).

## Definition of done by phase

* `pnpm test`, `pnpm test:e2e`, `pnpm --dir app lint`, `pnpm --dir app build`,
  `pnpm --dir app check:export` all pass.
* Phase 1: Base Sepolia proves create → funded bid → finalize/rollover →
  portfolio → maturity/redemption without D1 or a custom indexer.
* Phase 1: B20 multiplier/policies, Chainlink staleness/pause, 0x simulation and
  spender checks, Base Account fallback, paymaster allowlist, USDC funding,
  fee conservation, attribution, Verify scoping and transaction states have
  explicit tests or smoke-check evidence.
* Phase 2: indexer tests prove confirmed-only, idempotent, overlap-replaced and
  reorg-safe; the reconciliation ledger is reproducible from an empty database.
* No fabricated data, no unconfirmed logs indexed, and no silent fallback.
