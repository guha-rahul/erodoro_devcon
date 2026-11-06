# Permissionless intent auction (no market maker required)

The RFQ path (`ErodoroRFQ` + `/rfq`) needs a funded desk to sign first. This
layer removes that dependency: the **seller signs first**, anyone can bid,
and the chain enforces the seller's floor at settlement.

Economics are unchanged. The seller pre-splits (`split` → P+N), lists N via a
signed intent, keeps P, and receives USDC from the winning buyer. A failed
auction leaves the seller holding P+N, recoverable via `merge` — never locked.

## End-to-end transaction flow

1. Writer: `approve(collateral)` → `vault.split(seriesId, amount)` → holds P+N.
2. Writer: `setOperator(intentContract, true)` (one approval, reusable).
3. Writer: sign EIP-712 `SellIntent` (no gas) → `POST /intents`.
4. Coordinator opens a **10-minute auction**.
5. Bidders: `GET /auctions` → price off your own book → sign EIP-712 `Bid` → `POST /auctions/:id/bids`.
6. Coordinator declares the best valid premium above the floor the winner; the
   winner holds a ~45s **exclusive settlement window**.
7. Winner: `ErodoroIntent.fillIntent(intent, sellerSig, amount, premium)` —
   N→buyer and USDC→seller atomically, or nothing moves.
8. Winner reports: `POST /settlement/report` (indexing hint; chain is truth).
9. If the winner lapses, exclusivity releases and the next valid bid can settle.
10. No acceptable bid → another 10-minute round when the intent sets
    `allowRollover`; otherwise the auction expires. Empty rounds never touch
    the chain.
11. At maturity: anyone calls `vault.settle`, then P/N `redeem` separately.

## Auction state machine

`Signed → Searching → FastAuction → DiscoveryAuction → BidReceived →
PartiallyFilled → Filled → SettlementPending → Settled`
with terminal `Cancelled / Expired / Failed`. `advanceAuction` (in
`cloudflare/auction.mjs`) is the only transition function; `declareWinner`
refuses to overwrite a live exclusive winner, so two workers cannot crown two
winners. Empty/unsuccessful rounds emit no transactions.

## Batching and Dutch reserve

- Series key: `claims|collateral|claimId|strike|maturity|quoteToken`
  (`seriesKey`). Same key ⇒ same economics ⇒ may share a batch.
  Strike/maturity standardization stays a UX decision (weekly / 2-week /
  monthly); the contracts accept any canonical terms.
- Dutch reserve is optional and configurable: linear decay from
  `startPremium` to the seller floor over the discovery window, never below
  the floor (`dutchReserve`). Explicit bids above the reserve still compete;
  full-size acceptable execution closes early.

## Files

| Area | Files |
| --- | --- |
| Settlement | `contracts/src/ErodoroIntent.sol`, `contracts/script/DeployIntent.s.sol` |
| Contract tests | `contracts/test/unit/ErodoroIntent.t.sol` (14), `contracts/test/integration/AuctionFlow.t.sol` (8) |
| Coordinator | `cloudflare/auction.mjs` (pure logic), `cloudflare/auction-store.mjs` (file/D1 persistence), `cloudflare/auction-routes.mjs` (HTTP), wired in `cloudflare/worker.mjs` |
| Coordinator tests | `cloudflare/auction.test.mjs` (11), `cloudflare/auction-routes.test.mjs` (5) |
| Frontend | `app/lib/use-intent.ts`, `app/components/intent-panel.tsx`, `app/components/bid-panel.tsx`, `app/components/series-detail.tsx` (wiring), `app/lib/deployment.ts` (intent address) |
| Solver CLI | `app/scripts/bid-cli.mjs` |
| E2E demo | `scripts/e2e-auction.mjs`, `pnpm test:e2e` |

## API

- `POST /api/intents` — register signed intent, opens fast auction.
- `GET /api/intents?status=active|all|cancelled|filled`
- `GET /api/auctions`, `GET /api/auctions/:id`
- `POST /api/auctions/:id/bids` — signed bid (unsigned bids accepted but flagged).
- `POST /api/auctions/:id/advance` — coordinator tick (winner declaration/rollover).
- `POST /api/intents/cancel` — halts matching; returns `requiresOnchainCancel: true`.
- `GET /api/auctions/:id/result` — winner, bids, settlement tx.
- `POST /api/settlement/report` — record an on-chain fill.

## Solver / buyer integration

1. Poll `GET /api/auctions` (or `/api/intents?status=active`).
2. Resolve the series via the vault (`seriesConfig`) — never trust the
   coordinator's copy of strike/maturity; the contract re-checks both.
3. Sign `Bid { bidder, intentHash, amount, premium, expiry, nonce }` under
   domain `{ name: "ErodoroAuction", version: "1", chainId, verifyingContract: INTENT_ADDRESS }`
   (see `app/scripts/bid-cli.mjs`).
4. `POST /api/auctions/:id/bids`.
5. If you win, call `fillIntent` within the exclusivity window. Verify the
   seller's floor yourself with `checkIntent` first — bidding above floor is
   your own pricing decision; the contract rejects anything below it.

## Security assumptions (read before mainnet)

- `ErodoroIntent` uses CEI + `ReentrancyGuard` + `SafeERC20`; holds no funds.
- Replay protection: EIP-712 domain (chain id + contract), per-seller nonces
  burned on full fill or cancel, per-intent `filledOf` accounting.
- Floor pro-rating uses ceiling division; partial fills only when the seller
  signed `allowPartial` (N is fungible, so partials are economically safe).
- Series binding: `collateral/strike/maturity` are re-read from the vault at
  settlement (`seriesConfig` by word offset); a coordinator cannot alter terms.
- Fee-on-transfer quote tokens are rejected by a post-transfer receipt check;
  quote only standard tokens (USDC).
- Offchain ECDSA verification is best-effort (EOAs); contract `SignatureChecker`
  (EIP-1271 capable) is authoritative at settlement.
- Coordinator cancellation is advisory until `cancelIntent` is mined — the UI
  sends the transaction first and says so.
- Oracle/maturity safety inherits the vault + adapter stack (freshness window,
  confidence, Coinbase pause, UMA fallback). The intent layer adds no oracle.
- Centralized in MVP: ordering, timing, bid relay, offchain sig checks.
  Permissionless/onchain: signing, floor, terms, custody (seller keeps N until
  fill), settlement, cancellation, redemption.

## Commands

```sh
# contracts
cd contracts && forge build && forge test --offline

# coordinator + worker
pnpm install --frozen-lockfile && pnpm test

# deterministic local E2E (anvil + deploy + sign + bid + settle + redeem)
pnpm test:e2e

# frontend
pnpm --dir app install --frozen-lockfile
pnpm --dir app gen:abis
pnpm --dir app lint
SKIP_BUILD_RPC=1 pnpm --dir app build
```

## Environment

`contracts/.env.example`: `INTENT_ADDRESS`, `FAST_AUCTION_SECONDS`,
`SETTLEMENT_EXCLUSIVITY_SECONDS`, `DISCOVERY_AUCTION_SECONDS`,
`FAST_BATCH_CREATION_INTERVAL_SECONDS`. `app/.env.example`:
`NEXT_PUBLIC_INTENT_ADDRESS`. Worker: same keys as `wrangler.jsonc` vars;
secrets (`PRIVATE_RPC_URL`, maker keys) via `wrangler secret put`. No keys are
committed; the E2E uses anvil's default mnemonic only.

## Base Sepolia evidence (fork, no keys)

`contracts/test/fork/IntentSepoliaFork.t.sol` runs the intent flow against
live Sepolia state with `base-forge` (B20 precompiles):

```sh
cd contracts
BASE_SEPOLIA_RPC_URL=https://sepolia.base.org \
  FOUNDRY_PROFILE=fork base-forge test --match-contract IntentSepoliaFork -vv
```

Verified 2026-09-14: 3 passed. A fresh canonical series was created through
the live factory under its active settlement configuration, 0.5 live tAAPLc
was split (funded from the completed pilot accounts — fork only, no keys),
and the fresh `ErodoroIntent` filled 0.5 N for a 5 tUSDC floor on the live
vault (N→buyer, P retained). Low-bid and cancelled-intent fills revert.
Maturity settlement against the live Pyth adapter is out of scope here (needs
a signed Hermes print in-window); it is proven locally in `AuctionFlow.t.sol`
and live by the recorded pilot.

## Base Sepolia runbook (live broadcast)

1. `ErodoroIntent` is deployed at `0x8c63bbC4b077a73e67258A0F384186c316855Cd8` (transaction `0x068f495efeda6d7e616d5222480b8071ba5fe0b4f53e39c88f03dfeb42390b47`).
2. The address is recorded in `contracts/deployments/base-sepolia.json`,
   `app/lib/deployment.ts`, `wrangler.jsonc`, and both environment examples.
3. `npx wrangler deploy`; smoke-test `POST /intents` → bid → `fillIntent`
   with the house accounts from the existing pilot (seller/maker/settler).
4. Run the E2E against the fork (`BASE_SEPOLIA_RPC_URL`) before any real funds.

## Known limitations / still blocking production

- `ErodoroIntent` is live on Base Sepolia; the frontend and Worker must keep
  the same address or EIP-712 signatures will not verify.
- Auction state is persisted in the `erodoro-auctions` D1 database through the
  `AUCTION_DB` binding; local development uses a JSON store under `/tmp`.
- No external bidder, no audit, factory admin is an EOA, testnet source not
  published — same mainnet blockers as `status.md`.
- Dutch parameters have no UI yet (API-level only); batch UI shows per-intent
  auctions, not grouped batch boards.
- Stale-bid funding is checked at settlement (`checkIntent` + atomic transfer),
  not continuously — a winner that empties its wallet fails loudly, releases
  exclusivity, and the next bid proceeds.
