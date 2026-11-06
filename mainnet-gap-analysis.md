# Erodoro mainnet gap analysis

Written **2026-09-20** against `UX-maxxing` at the merge commit `7dd767b`
(`origin/main` `4dcaf93` merged in; branch is 6 ahead, 0 behind main).

This file is a point-in-time audit, not a source of truth. It exists because the
repository's declared sources of truth — [`status.md`](status.md),
[`contracts/deployments/base.json`](contracts/deployments/base.json) and
[`app/lib/deployment.ts`](app/lib/deployment.ts) — currently contradict the state
of Base mainnet. Where this file says "verified", an on-chain read or a
`file:line` citation backs it. Where it says "reported", it came from an automated
sweep and has *not* been independently confirmed.

---

## A. Erodoro is already deployed to Base mainnet

**This is the headline finding and it inverts the question.** The launch is not
entirely ahead of us; a piece of it happened on 2026-09-09 and was never recorded.

Verified by `eth_getCode` against `https://mainnet.base.org` on 2026-09-20:

| Contract | Address | Code |
| --- | --- | --- |
| `ErodoroVault` | `0x01c4ca673057a2ddc64202a31b81f9bf838f4444` | 21,553 bytes |
| `PythAdapter` | `0x578ffb7486447e4040a07d6df957c2826d2e58e9` | 3,338 bytes |
| `Factory` | `0x7e63b6a2948d317cca06d7df9437613d5249afc1` | 12,376 bytes |
| `ErodoroRFQ` | `0xc01730bf883dc0a0e3f2bd7a5f78e72cc54b0951` | 5,618 bytes |

Provenance: `contracts/broadcast/Deploy.s.sol/8453/run-latest.json` — chain `8453`,
commit `864ebd1`, timestamp `1788975372101` (2026-09-09 23:06), four receipts all
`status 0x1` in block `0x30b9e15`. **That artifact is gitignored**
(`.gitignore:5`), so this evidence does not survive a fresh clone. It is the only
in-repo record that the deployment happened.

### Admin custody is a single key

Verified on-chain:

- `Factory.admin()` = `0x8CC096359ade18A3a5826E48FC4EFaA98789eF53`
- That address is a Gnosis Safe, `VERSION()` = `1.4.1`
- `getThreshold()` = **1**
- `getOwners()` = **`[0xc0296012cfbb0e6df5da7158b65dbc46dd9650e0]`** — one owner

`status.md:53-54` says *"The factory admin is an EOA. That is acceptable for the
sandbox and a mainnet blocker."* A 1-of-1 Safe is not an EOA, but it is the same
single point of failure wearing a contract wrapper. The one on-chain guard in the
hardened deploy script is `require(admin.code.length > 0, ...)`, which a 1-of-1
Safe satisfies trivially.

### What limits the blast radius today

- `seriesCount()` is 0; no canonical series exists.
- No active settlement configuration for any collateral.
- No collateral locked in the vault.

**The deployed stack is dormant. No user funds are at risk right now.**

### What does not limit it

- `ErodoroVault.createSeries` is permissionless (`contracts/src/ErodoroVault.sol:145`).
- The vault has no global pause and no contract-level owner.
- `Factory.creationPaused()` is `false`.
- The most dangerous privileged function, `Factory.setSettlementConfiguration`,
  takes effect immediately with no timelock — it decides what price a future
  canonical series settles against.
- The deploy script that produced this deployment (with `MAINNET_FACTORY_ADMIN`,
  signer pinning and the admin code-length check) exists only on
  `feat/erodoro-product-v2` and was never merged. `contracts/script/Deploy.s.sol`
  on this branch has **no chain-id guard** and reads a raw `PRIVATE_KEY` (`:27`).

### Three surfaces to reconcile

| File | Claim | Reality |
| --- | --- | --- |
| `contracts/deployments/base.json:3,9-13` | `"No erodoro contract is deployed."`, contracts `null` | four contracts live |
| `status.md:24-26` | `"**No Erodoro contracts are deployed.**"` | same |
| `app/lib/deployment.ts:48-50` | `status: "configuration-only"`, all contracts `null` | same |

---

## B. The declared release gates

### `todo.md:170-195` — Task 7, "Clear the mainnet release gates": 0 of 8 ticked

Freeze the reviewed contract and settlement scope · external security review with
published scope · reproducible deployment, source-verification and preflight
scripts · factory administration behind a documented multisig with every admin and
emergency power defined · re-run the Base fork suite against the exact live B20
release · legal review for jurisdiction, eligibility, frontend restrictions and the
RFQ operator's role · funded production maker plus monitoring for B20
announcements, multipliers, pauses, oracle health, collateral shortfall and RFQ
failures · launch as a capped one-stock, one-configuration canary through a full
real expiry.

Note the tension with the first gate: `contracts/src/ErodoroAuctionHouse.sol`
changed `+221/-28` on this branch on 2026-09-19, and its test file grew by 267
lines. **The contract scope is not frozen**, so an audit scoped today would be
auditing a moving target.

### `status.md:95-109` — Current blockers

1. **N liquidity is unproven.** Confirmed in config: `wrangler.jsonc` has
   `MM_ENDPOINTS: ""` and `MM_NAME: "House maker (test)"`. No external desk is
   wired. `cloudflare/worker.mjs:416` calls the house maker *"a stand-in so the
   flow works before a real desk is wired."*
2. The public release boundary is open — no audit, no mainnet admin policy, no
   verified deployment, no legal review, no canary plan.
3. Testnet source is not published on an explorer.
4. Issuer scheduled-multiplier state is unreadable — `effectiveAt()` reverts on the
   live AAPLc release, so `StrikeMath.requireNoScheduledChange` is a no-op and an
   instant multiplier flip is silently absorbed. `SECURITY.md:118` and
   `known-limitations.md:8-16` both state this cannot be fixed from our side.

### `plan.md` — feature roadmap, 40 done / 7 partial / 12 unstarted / 4 blocked

**Phase 1 is essentially complete on this branch.** The 5 items that were unstarted
on `main` (5, 6, 9, 11, 12) all landed here on 2026-09-19.

The 7 partials are mostly external-registration or config blockers, not code:
- `1.3` — spend permissions need `ErodoroIntent` to redeem Base's
  `SpendPermissionManager`, a contract change tracked outside the item.
- `9.1`/`9.2` — Builder Codes need Erodoro registered on base.dev.
- `10.2` — `PAYMASTER_URL` / `PAYMASTER_API_KEY` are unset, so a live no-ETH run
  cannot be executed. The endpoint returns 503, never silently unsponsored.
- `11.1` — Base Verify trait gate needs live traits.
- `5.3`/`5.4` — onchain bid-state tracking and the EIP-2612 fallback.

Genuinely unstarted: **Phase 2 only** — Item 7 (durable D1 event indexer) and
Item 8 (settlement reconciliation ledger), 12 boxes.

> **Framing that matters:** `plan.md` is feature work. Finishing Phase 2 ticks
> zero boxes in Task 7. The two lists are orthogonal, and only Task 7 gates a
> launch.

### Documentation staleness

`status.md`, `contracts/SECURITY.md`, `contracts/docs/known-limitations.md` and
both deployment JSONs are all dated **2026-08-25**. The mainnet deployment was
2026-09-09. `status.md:82` claims 142 passing tests; the suite on this branch is
**216**. `known-limitations.md:55-56` says `audit-brief.md` "has not been written"
— it was, on `feat/erodoro-product-v2`, and is not on this branch.

---

## C. Code-level gaps

Each item below was re-checked against the merged working tree, not against the
stale branch the sweep originally ran on.

### Already fixed — do not re-report

- Auction routes moved to `/api/*`, and `/api/*` was added to `run_worker_first`,
  so `GET /auctions` no longer collides with the static `/auctions` page.
- `wrangler.jsonc` now binds `d1_databases` → `AUCTION_DB`; auction state is no
  longer per-request in-memory.
- `setOperator` / `isOperator` are now in `app/lib/use-intent.ts:157,165`, so a
  winner's `fillIntent` no longer reverts for want of an operator grant.
- The client now calls `/api/auctions/:id/advance`
  (`app/components/auction/LiveAuctionTable.tsx:40`), so a winner does get
  declared without a cron.

### Still present — verified on the merged tree

**1. No chain-id assertion between the worker RPC and the app's active chain.**
`cloudflare/worker.mjs:81,358` both default to `https://sepolia.base.org`;
`app/lib/chain.ts` contains no `eth_chainId` check of any kind. Setting
`NEXT_PUBLIC_CHAIN_ID=8453` without also changing `PUBLIC_RPC_URL` renders Sepolia
state while the wallet is asked to sign Base mainnet transactions. Given that
mainnet contracts now exist, this is the highest-severity configuration hazard in
the repo.

**2. `AuctionBuilder` splits tokens before checking the intent contract exists.**
`intentAvailable` is not referenced anywhere in
`app/components/auction/AuctionBuilder.tsx`. Its `disabledReason` gates on wallet,
quote, token, quantity, match and floor — but not on the intent address. Compare
`app/components/intent-panel.tsx:34` and `app/components/bid-panel.tsx:78`, which
both check it. With `NEXT_PUBLIC_INTENT_ADDRESS` unset (the `.env.example`
default) the seller pays gas for `approve` + `split`, then fails with
"Connect a wallet first." Recoverable via `merge`, but it costs real gas and
strands the user holding P+N.

**3. The "Base Mainnet · Real funds" banner is driven by localStorage.**
`app/components/app-chrome.tsx:47-48` derives `isTestnet` from `useAppNetwork()`
— a localStorage-backed selector — while every other disclosure uses the
build-time `IS_TESTNET` from `DEPLOYMENT`. Selecting "Base Mainnet" in the header
on a Sepolia build swaps the preview banner for a real-funds banner and hides the
testnet tabs, while every contract read stays on Sepolia.

**4. The frontend cannot be pointed at mainnet by flipping one env var.**
`app/lib/deployment.ts:50` has every `BASE_MAINNET` contract as `null` and
`staticSeries: []`. `IS_LIVE` goes false, the series list disables itself, and
`app/scripts/check-export.mjs` fails the build for having no market route.

### Worker authentication — verified 2026-09-22

Previously listed here as unconfirmed sweep output. I have now verified each one
against the merged tree, and **exercised the two worst through the real router**
(`createAuctionRouter` + `AuctionStore`, the same code the Worker runs). Three of
the original characterisations were overstated and are corrected below.

**The bounding fact, established first:** none of these can move user funds.
`ErodoroIntent._requireFillable` independently re-checks signature, nonce, floor,
partial-fill permission and the series tuple on-chain, and `ErodoroIntent` holds
no custody. Every finding below is coordinator-state corruption, denial of
matching, or UI-level fabrication — not theft.

**1. `POST /api/settlement/report` — unauthenticated. Confirmed, most severe.**
No auth, no signature, no chain verification; it validates only that
`intentHash` is 32-byte hex, then passes caller-supplied `amount`, `txHash`,
`premium` and `buyer` straight to `store.recordFill`
(`cloudflare/auction-routes.mjs:266-278`). Demonstrated against a live intent by
a caller holding no key:

```
intent status now     : filled
auction state now     : Filled
settlementTx recorded : 0xdededede…dede     (fabricated)
winner field          : null                 (a legitimate winner is erased)
```

`recordFill` (`auction-store.mjs:148-169`) flips status to `filled`, writes the
attacker's `settlementTx`, and sets `auction.winner = null` and
`winnerExclusiveUntil = 0`. Because `submitBid` rejects bids when
`intent.status !== "active"`, one unauthenticated request permanently kills any
seller's auction and writes a fake settlement hash the UI will display. Routed
in production at `worker.mjs:466`, and `/api/*` is in `run_worker_first`.

**2. `POST /api/auctions/:id/bids` — signature optional. Confirmed.**
`verifyBidSignature` returns `{ ok: true, unsigned: true }` when `bid.signature`
is absent (`auction-routes.mjs:105`), `validateBidShape` does not require the
field, and `submitBid` ignores the `unsigned` flag. Demonstrated: an unsigned bid
attributed to `0x…BEEF`, an address the caller does not control, was accepted
(HTTP 200) and **selected as best**. A stranger can therefore forge the winning
bid in coordinator state under someone else's address. It cannot be filled
on-chain, so the effect is to deny the seller a real match.

**3. `POST /api/intents/cancel` — spoofable. Confirmed.**
`auction-routes.mjs:242` compares caller-supplied `body.seller` to
`record.seller`. The seller address is published by the public `GET /api/intents`.
Demonstrated end to end: read the seller from the public listing, echo it back,
`status: cancelled`. Mitigation, and it is real: the response says
`requiresOnchainCancel: true`, and only `ErodoroIntent.cancelIntent` is
authoritative — so this halts matching, it does not cancel the seller's position.

**4. `POST /api/auctions/:id/advance` — unauthenticated. Confirmed, but the
earlier severity was wrong.** There is no caller gate; `worker.mjs:463` does not
even pass the request to `tickAuction`. But the claim that a caller "forces
winner declaration and the 45s exclusivity lock" is **false**: `nowSeconds` is
test-only and the HTTP route never passes it, so production always uses the wall
clock. I confirmed a caller cannot close early — with an injected future clock no
winner was declared, and over HTTP the fast window governs. Permissionless
advancement is also deliberate (`plan.md` F.3: contracts cannot wake themselves).
This is close to working as designed.

**5. `POST /mm/quote` — bypasses `validateQuoteRequest`. Confirmed mechanism,
testnet-scoped.** `validateQuoteRequest` (`worker.mjs:268`) pins `claims` to
`RFQ_CLAIMS_ADDRESS` and `quoteToken` to `MM_QUOTE_TOKEN`, but is called only at
`:140` on the `/rfq` path; `/mm/quote` reaches `houseQuote` directly
(`worker.mjs:442`). So a caller controls `claims` and `quoteToken`, reads series
config from a contract of their choosing, and gets the house key to sign the
result. `ErodoroRFQ.fill` does **not** validate `q.claims`
(`ErodoroRFQ.sol:120`) and pulls the maker's ERC20 at `:121`, so a worthless
claim in exchanges for real quote token out, bounded by the maker's allowance.

Scope, which the earlier note understated: `houseQuote` returns 403 off Sepolia
(`market-maker.mjs:115-117`) and signs with `chainId: SEPOLIA` and
`verifyingContract: env.RFQ_ADDRESS`, so the signature is unusable on mainnet.
Today this drains testnet tUSDC only. It becomes a real-funds bug the moment a
mainnet maker is wired, which is Task 7 item 11.

**6. No rate limiting.** Confirmed — the only matches in `cloudflare/` are two
comments. No Cloudflare rate-limit binding in `wrangler.jsonc`.

**One earlier characterisation retracted.** The sweep reported that
`verifyIntentSignature` "accepts a malformed signature as valid" because its
`catch` returns `{ ok: true, deferred: true }`. That is a deliberate EIP-1271
accommodation — contract wallets cannot be verified off-chain, and the intent
contract re-checks with `SignatureChecker` at settlement, which is authoritative
(`auction-routes.mjs:96-100`). `verifyBidSignature` does **not** do this; its
`catch` returns `{ ok: false }`. The two were conflated.

---

## D. Testing boundary

Run on the merged tree, 2026-09-20 — all green:

| Suite | Result |
| --- | --- |
| `forge test --offline` | 216 passed, 0 failed, 19 suites |
| `pnpm test` (worker) | 68 passed, 0 failed |
| `pnpm test:e2e` | PASS — sign → bid → win → settle → mature → redeem reconciles |
| `pnpm --dir app lint` | clean |
| `pnpm --dir app build` + `check:export` | 10 fixed routes, 3 market routes |

What that does **not** cover:

- **All 11 fork tests are excluded from CI.** `contracts/foundry.toml:11` sets
  `no_match_path = "test/fork/**"` and `.github/workflows/ci.yml` runs plain
  `forge test`. The Base mainnet fork suite — the only thing that exercises real
  AAPLc, the Coinbase registry and a signed Hermes update — never runs
  automatically. Each fork test is additionally self-gated with `vm.skip(true)`
  when unconfigured.
- **There are zero stateful invariant tests** despite the `test/invariant/`
  directory name. The 7 `testFuzz_*` tests are stateless; the
  `[profile.default.invariant]` block in `foundry.toml:16-19` configures a fuzzer
  that is never invoked.
- **`cloudflare/market-maker.mjs` has no test file** — it is the only component
  holding a signing key.
- **CI triggers on push to `main` only**, not on pull requests. This branch's 6
  commits have no CI result; the table above is local evidence.
- Everything under `test/unit` and `test/invariant` runs against mocks. Per
  `known-limitations.md:68-69`, *"They prove nothing about the issuer."*

---

## E. Open questions

These are judgment calls, recorded without a recommendation.

1. **The live deployment.** Rotate the Safe to a real multisig, redeploy from a
   guarded script, or document and freeze what is there? The unrecorded addresses
   and the gitignored broadcast artifact need resolving either way.
2. **Ordering.** Phase 2 of `plan.md`, or Task 7's gates? They share no items.
3. **Scope freeze.** Task 7's first gate cannot close while
   `ErodoroAuctionHouse.sol` keeps changing. When does the contract scope freeze?
4. **Accepted-and-priced, or blocking?** `SECURITY.md` leaves open: `sweepDust`
   forfeiting a non-redeemer's whole share (`:229`), the unsolved dividend case
   (`:232`), no maximum deposit cap on `split`, one address holding every series'
   collateral (`:151`), and a series nobody settles staying locked (`:164`).
5. **Liquidity.** `status.md` calls the next proof *economic, not another house
   transaction*. No external maker is wired. Does a canary launch without one?

---

# Product check — 2026-09-20

Run against `UX-maxxing` at `7dd767b`. Every row is an actual run, not an
inference. A check that could not run is BLOCKED, never a pass.

## Results

| Check | Result | Note |
| --- | --- | --- |
| `forge build --sizes` | **PASS** | vault runtime margin only 2,541 B under the EIP-170 limit |
| `forge test` | **PASS** | 216 passed, 0 failed, 19 suites |
| `pnpm test` (worker) | **PASS** | 68 passed, 0 failed |
| `pnpm --dir app gen:abis` | **PASS** | |
| `pnpm test:e2e` | **PASS** | sign → bid → win → settle → mature → redeem reconciles |
| `pnpm --dir app lint` | **PASS** | |
| `check:product-logic` | **PASS** | 8 scripts + 16 node tests |
| `check-portfolio-balances.mjs` | **PASS** | |
| `check:stock-swap` | **PASS** | |
| `pnpm --dir app build` | **PASS** | warnings only |
| `check:export` | **PASS** | 10 fixed routes, 3 market routes |
| `check:premium-history` | **PASS** | browser |
| `check:stock-swap-browser` | **PASS** | browser, zero page errors |
| `check:responsive` | **PASS** (after fix) | was failing: `/app` overflowed at 768px — see below |
| `check-auction-purchase.cjs` | **PASS** | orphaned; in no package.json and no CI |
| `make test-base` | **PASS** | 216 tests under base-forge with B20 precompiles hosted |
| **`make fork-test`** | **FAIL** | 6 of 7 pass; Base mainnet fork blocked — see below |
| `make preflight` | **PASS** | 0 fails, 7 warns, first run against the live vault |

## Failure 1 — `/app` overflows horizontally at 768px

`check:responsive` fails one of 30 viewport/route combinations:

```
/app at 768px overflows horizontally: 1174px > 768px
```

375px, 390px, 430px and 1440px all pass.

**Root cause (corrected).** My first diagnosis — a missing `min-w-0` on the
wrapper at `app/components/markets-table.tsx:287` — was wrong. That wrapper's
parent is `display: block`, and `min-width: auto` only differs from `0` for flex
and grid items, so the class would have been inert. I verified the real cause by
bisecting in the browser: hiding the wrapper drops
`document.documentElement.scrollWidth` from 1174 to 768, and injecting a known
1600px element moves it to 1600, so the metric is sound and the table really is
the source.

The wrapper already has `overflow-x-auto`, but it was `position: static`. A
static scroll container does not stop its child's layout overflow propagating to
the root, so the 74rem (1184px) table at `:288` inflated the document even though
it painted clipped. Adding `relative` fixes it — confirmed empirically against
six candidates; `contain: paint` also worked, `max-width`, `width: 100%`,
`display: flow-root` and `overflow-x: hidden` on `main` did not.

**Fixed** in `markets-table.tsx:287`; `check:responsive` now passes 6 routes × 5
widths.

One methodological note worth keeping: an intermediate attempt to "fix" this by
changing the check to measure `window.scrollX` after a programmatic scroll was
reverted. Validating that metric against an injected 1600px overflow showed it
reported no overflow — `window.scrollTo` does not move the page in this headless
context, so it would have silently disabled the check.

## Failure 2 — Pyth settlement is unreachable

`make fork-test`: 6 of 7 pass. `BaseMainnetForkTest` fails in `setUp()` with
`environment variable "BASE_PYTH_UPDATE" not found`, because
`contracts/script/fetch-hermes.sh` produced nothing. Diagnosing the fetch:

| Endpoint | Auth | AAPL equity | BTC crypto |
| --- | --- | --- | --- |
| `hermes.pyth.network` (public, used by `fetch-hermes.sh`) | none | **401** `unauthorized` | **401** |
| `pyth.dourolabs.app` (used by the Worker) | repo `PYTH_API_KEY` | **403** `Not entitled` | **403** `Not entitled` |

The public Hermes API is now gated, and the configured key is entitled to **no
feed at all** — not equity, not even crypto. This is broader than the previously
recorded "403 on the equity feed".

Consequence beyond the fork suite: `app/lib/use-actions.ts:202` calls
`fetchPrint(feedId, maturity)` to obtain the signed update that settlement
submits, routed through `/hermes/*` → the Worker → the Douro endpoint. **Primary
Pyth settlement cannot execute on any network today.** Display prices are
unaffected — `fetchReference` reads `getPriceUnsafe` on-chain and needs no Hermes.

That makes the missing mainnet UMA fallback load-bearing rather than theoretical:
`DeployUmaFallback.s.sol:15` refuses any chain but Base Sepolia, so a mainnet
series has no recovery path if the primary oracle cannot produce a print.

The other 6 fork tests, which have never run in CI, all pass — including
`test_liveRegistryReportsAaplOperational` against the live Coinbase registry and
three Sepolia intent-fill tests.

## Preflight against the live vault — first ever run

```
chain id: 8453   collateral: 0xb200000000000000000000C2e324d24d7eEcd1fb (real AAPLc)
fails: 0   warns: 7
```

This answers the open question. The live vault **is** currently authorized under
`TRANSFER_SENDER_POLICY`, `TRANSFER_RECEIVER_POLICY` and
`TRANSFER_EXECUTOR_POLICY` (all policy id 5), so `split`, `merge` and `redeem`
would work on mainnet today. TRANSFER is live and the multiplier is unity.

The seven warnings, each a decision rather than a defect: AAPLc is 8 decimals not
18; all three transfer policies are ARMED and the authorization **can be revoked**
by the issuer at any time; seizure is pre-Cobalt burnBlock + re-mint, so a drain
and a redemption freeze arrive together; there is no ERC-8056 pending surface on
Beryl, so the creation-time corporate-action gate is unavailable rather than
passing; and `priceDecimals` (8) differs from the live feed exponent (5), so
strikes must be quoted in series units — quoting in feed-native units understates
by 1000x and nothing complains.

## Live mainnet read sweep

Bytecode identity, read 2026-09-20:

| Contract | Deployed size | HEAD build | Match |
| --- | --- | --- | --- |
| `ErodoroVault` | 21,553 | 22,035 | **no — changed since deploy** |
| `PythAdapter` | 3,338 | 3,338 | size only |
| `Factory` | 12,376 | 12,376 | size only |
| `ErodoroRFQ` | 5,618 | 5,618 | size only |

The deployed vault hash `0xd241995…` is **byte-identical to the Base Sepolia vault
recorded on 2026-08-25**. The vault has no constructor, so its runtime code is
deployment-independent — the mainnet vault is that same build. The other three
differ from their Sepolia twins only because each embeds deployment-specific
immutables; sizes match exactly. Verifying any of this on a block explorer
requires checking out `864ebd1`, not HEAD.

Factory state: `admin` = the 1-of-1 Safe, `creationPaused` false, `seriesCount` 0,
`canonicalCount` 0, `activeConfigurationId(AAPLc)` zero. Safe: v1.4.1, threshold
1, one owner, no modules, **nonce 0 — it has never executed a transaction**.

Deployed bounds are `minPriceLag 1` / `maxPriceLag 90000`, against a documented
policy of `600` / `21600`. A canonical mainnet series could be created with a
one-second or twenty-five-hour price window and the factory would accept it.

All four Coinbase Chainlink feeds re-verified: `description()` returns
`Coinbase AAPL` / `NVDA` / `META` / `GOOGL`.

These findings are now recorded in `contracts/deployments/base.json`, which
previously said no contract was deployed.

---

# What remains before mainnet launch

Separated by kind, because they are not interchangeable.

## Verified failures — code, found by running the checks

1. **Pyth settlement is unreachable.** No entitled Hermes access; public endpoint
   401, configured key 403 on every feed. Blocks settlement, not just the fork
   suite. Either obtain an entitled key, or finish the Chainlink adapter path
   (`ChainlinkTotalReturnAdapter` is built and unit-tested but **deployed nowhere**).
2. **No mainnet oracle recovery.** `DeployUmaFallback.s.sol:15` refuses chain 8453.
   With (1) unresolved, a mainnet series would have no way to settle at all.
3. ~~`/app` overflows at 768px~~ — **fixed**: `markets-table.tsx:287` is now
   `relative`. Was present on `main` too.
4. The four still-present findings from Section C above: no chain-id assertion
   between the Worker RPC and the app's active chain; `AuctionBuilder` splits
   before checking the intent contract exists; the real-funds banner is driven by
   localStorage; `BASE_MAINNET` contracts are all `null`.

## Missing tooling — mechanically blocks a launch

5. **There is no script that can list a canonical series on mainnet.**
   `ListSeries.s.sol:42` is `require(block.chainid != BASE_MAINNET)`. Without it,
   `seriesCount` stays 0 and nothing can be sold.
6. **No hardened mainnet deploy script on this branch.** `Deploy.s.sol` has no
   chain guard and takes a raw `PRIVATE_KEY`; the guarded variant was never merged
   from `feat/erodoro-product-v2`.
7. **No source verification.** Nothing is published to Basescan, and doing so
   requires building at `864ebd1`, not HEAD.

## Process gates — `todo.md` Task 7, still 0 of 8

8. External security review, with published scope.
9. Factory administration behind a real multisig. Today: 1-of-1 Safe, nonce 0.
10. Legal review — jurisdiction, eligibility, frontend restrictions, RFQ operator.
11. A funded production maker. `MM_ENDPOINTS` is still empty.
12. Monitoring for B20 announcements, multipliers, pauses, oracle health,
    collateral shortfall and RFQ failures.
13. Re-run the Base fork suite against the live B20 release — **currently blocked
    by (1)**.
14. A capped one-stock canary through a full real expiry.
15. Freeze the contract scope. `ErodoroAuctionHouse.sol` changed +221/-28 on
    2026-09-19; HEAD's vault already differs from what is deployed.

## Coverage gaps — not failures, but unrun

16. Fork tests remain excluded from CI (`foundry.toml:11`); `make test-base`,
    `make fork-test` and `make preflight` are in no workflow.
17. Zero stateful invariant tests despite the `test/invariant/` directory name.
18. `cloudflare/market-maker.mjs` — the only component holding a signing key — has
    no test file.
19. CI runs on push to `main` only, not on pull requests.
20. ~~The five Worker auth items remain unverified~~ — **verified 2026-09-22**;
    see Section C. Four confirmed, one severity corrected, one claim retracted.
    They now belong under verified failures, not coverage gaps:
    `POST /api/settlement/report` needs authentication before anything else here
    ships, and bid signatures should stop being optional.
