# Market Rips port and verification

Verification date: 8 October 2026. Local app: `http://localhost:3000/market-rip`.

**The port is implemented and independently tested. A real Base Sepolia $1 selected purchase succeeded; its receipt, claim balance, recorded cost, reload/reconnect persistence and live sharing were verified. Further live purchase modes remain pending final wallet confirmations. No mainnet funds were spent.**

## Inventory and implementation

Both working trees were inspected before editing. Applicable `web/AGENTS.md` and `app/AGENTS.md` and the installed Next.js guidance were read. The source `rips` working tree was preserved, including its five modified components. The destination's unrelated uncommitted work was retained.

| Experience | Ported behavior and files |
| --- | --- |
| Home and reveal | `components/rips/rips-home.tsx`, `rip-flow.tsx`, `bits.tsx`; home hero, drifting tickers, torn reveal, repeat pull, $5 top-up, and held-position preview |
| Modes and balance | `rips-shell.tsx`, `lib/rips/use-rips.ts`; live default, explicit testnet demo, actual payment-token balance, wallet/RPC/build network agreement |
| Buying | `MarketRipPool.sol`, `purchase.ts`, `use-rips.ts`; random $1 N-only purchase and selected $1/$5/$20 purchase from funded inventory with reviewed quotes |
| Finding positions | Home search and available-position links; current active batch and its actual inventory/quote expiry |
| My Rips | `my-rips.tsx`, `rip-card.tsx`, `live.ts`, `history.ts`; current ERC-6909 balance, lifetime contract-recorded spend, historical buyer index, Recent/Value/Expiry sorting |
| Position details | `rip-detail.tsx`; strike, expiry, raw claim IDs/decimals, current/original units, cost, receipt history, purchase amounts, settlement and redemption |
| Sharing | `share-card.tsx`, `share.ts`; 1200×675 canvas card, copy link/image where supported, download/native/X controls, direct share preview, explicit demo/testnet labels |
| Navigation and layout | `/market-rip`, `/rips`, `/rips/position?id=…`, app navigation, mobile cards/details, focus handling, animations and reduced-motion CSS |
| Recovery | Loading, no wallet, unknown balance, empty/unconfigured pool, no search results, invalid position link, wrong network, cancelled connection/signing, liquidity/quote races, failed/uncertain transactions |

All paths in the table are under `app/`, except the Solidity contract under `contracts/src/`. Generated pool/put ABIs and the ABI generator/export list are included. `components/market-rip-screen.tsx` preserves the previous import entry point.

## What a live Rip buys

The existing Base retail RFQ path supports selling to maker bids; it does not provide the source's retail upside purchase mechanism. Rips instead purchases actual N claim units already held by `MarketRipPool`.

Payment is exactly 1,000,000 raw units per dollar of the configured six-decimal token: tUSDC on Base Sepolia or canonical USDC on Base. Claim quantities use the collateral's actual decimals. Approvals are bounded to the chosen amount and confirmed before purchase. The UI simulates the contract request and accepts a purchase only after a successful receipt containing a matching `RipPurchased` event from the configured pool, for the buyer and exact payment.

`ripUp` excludes put/DOWN inventory and binds random selection to the reviewed inventory hash. Selected purchases bind quantity and quote reference; $20 never silently becomes a partial fill. Block entropy can be biased, which is disclosed. Quotes expire within five minutes and must be maintained by the operator.

The supported live N series use TOTAL_RETURN settlement. The strike may be in total-return oracle units rather than raw stock-price units. N redemption delivers the above-strike share of **underlying collateral tokens** after settlement, subject to contract rounding, fees and collateral risks. It can be worthless. A sale quote is not a resale bid; the app does not invent live P/L or promise USDC cash-out. Current claim balance and lifetime purchase cost remain separate after transfers or redemption.

Purchase totals and holdings recover from contract getters across wallets/devices/reloads. Optional event scanning adds timestamps, modes, and transaction links. Without the deployment block, the app shows an explicitly undated on-chain purchase aggregate rather than invented purchase dates.

## Checks actually run

| Check | Result |
| --- | --- |
| `forge test --offline` | 262 passed, 0 failed across 22 suites |
| Rips contract suites | 32 passed, including exact $20 delivery, no partial fill, quote races, insufficient funds rollback, N-only selection, transfers, and settlement redemption |
| `npm test` | 93 worker tests passed after remote-history merge |
| `pnpm check:product-logic` | Existing product checks and 16 existing Node tests passed, plus 12 Rips tests |
| `pnpm check:rips` | 12 passed: actual receipt identity/payment, inventory commitments, history concurrency, cost/quantity separation, chain mismatch, demo and share validation, error recovery, quote-expiry detail persistence, the public RPC’s 200-block log limit, and retention of verified holdings after transient RPC failure |
| Targeted ESLint and `tsc --noEmit` | Passed |
| `pnpm check:portfolio-balances` | Passed |
| `pnpm check:auction-purchase` | Passed on the committed-code archive. The current working tree fails because the existing uncommitted `use-intent.ts` imports `pending-intent.ts`, which this older VM harness does not resolve. This is outside the Rips port; the existing intent work was preserved. |
| `pnpm build` | Production static export passed after integrating newer remote history; all three Rips routes generated |
| `pnpm check:export` | 13 fixed routes plus 4 market routes passed, including all three Rips routes |
| `pnpm check:responsive` | 9 routes passed at 375/390/430/768/1440px, including all three Rips routes |
| Committed-code verification | An isolated archive of pushed commit `0f1edb0` passed TypeScript, all 9 Rips tests and all 32 Rips contract tests; production build also passed. This excludes unrelated working-tree changes. |

The production build emits existing optional `ox`/`viem` import warnings. Desktop MetaMask/Base Account testing also exposed external wallet SDK analytics/network warnings; these are distinguished from the Rips hydration error that was fixed and retested.

The latest responsive rerun initially timed out waiting for `networkidle` on the homepage. Wallet SDK background traffic prevents that condition. The check now waits for the loaded document, a visible heading, fonts and two layout frames; all nine routes at five widths passed again with the same overflow and navigation assertions.

## Browser journeys actually completed

The rendered app was exercised through Codex's desktop in-app browser and subsequently Brave with the real MetaMask/Base Account connectors. These were direct clicks, typing, navigation, and reloads, not just code inspection or a headless test.

| Journey | Verification |
| --- | --- |
| Open with no wallet | Live loading and unconfigured-pool state; buying disabled and honest reason visible |
| Connect an actual wallet | Connected MetaMask account `0x9757724C3EcDC93479a039Eb062F5111f0B66aa5`; real 511 tUSDC balance displayed |
| Wrong wallet network | Base Account fallback showed the Base Sepolia guard; clicking Switch recovered to the correct network and its real 0 tUSDC balance |
| Cancel and retry connection | Cancelled a real MetaMask prompt; fixed missing second-wallet error, repeated cancellation and verified message, then successfully connected |
| Reconnect/reload balance | MetaMask reconnection and page reload restored its actual 511 tUSDC balance |
| Wrong app network | Selected Base Mainnet in app selector; Rips blocked mismatched build/network, then recovered after choosing Base Sepolia. No mainnet transaction requested |
| Demo random/reveal/top-up | $1 pulls and $5 reveal top-ups completed. Demo was clearly labelled; no transaction submitted |
| Demo selected purchase modes | $1, $5 and $20 detail purchases completed; costs accumulated correctly |
| My Rips and persistence | In-app demo BTC cost reached $28 and ETH $5, aggregate $33, survived reload; separate Brave demo $1+$5 BONK cost was $6 |
| Find/select | Typed ETH search, verified filtered positions; typed NOASSET, verified empty search, cleared and recovered; opened an unowned listed position |
| Sorting/navigation | My Rips, Recent, Value and Expiring soon, detail links, home navigation |
| Detail reload | Found source-style Suspense hydration mismatch; repaired the child hydration guard and repeated reload with no new hydration error and retained cost |
| Sharing/direct links | Desktop and mobile preview, verified copied share text/link from clipboard, opened link and saw friend's demo pull, Escape close with restored focus |
| Invalid direct link | Missing position ID displayed recovery message; Back to My Rips worked. Also loaded the exported route at `127.0.0.1:4333` and verified its heading, disconnected/live and demo-empty states |
| Mobile | 375×812 layouts for home, reveal, holdings, details, share sheet and navigation; inspected screenshots and no document horizontal overflow |

No social post or message was sent. Native sharing and image-copy support vary by browser; those external flows are not claimed as completed.

## Real Base Sepolia setup and remaining journeys

The user funded isolated operator `0x6B7621352A3A30a56d2D257c71B0231218A5C68C` with 0.01 test ETH. The helper deployed an isolated vault, Factory, mock TOTAL_RETURN oracle, put, pool and ten explicitly labelled test assets. The active batch holds real ERC-6909 N units on chain 84532. The public [deployment manifest](rips-evidence/sepolia-test-deployment.json) records addresses and transaction hashes; [inventory audit](rips-evidence/sepolia-pool-audit.json) records actual units and zero buyer costs before any successful purchase. The session-only operator key remains outside the repository.

The pool is [`0xeda960663c1b38f5ab172b75b472fa82c48a92c7`](https://sepolia.basescan.org/address/0xeda960663c1b38f5ab172b75b472fa82c48a92c7), deployed in [transaction `0x095c…d7a6`](https://sepolia.basescan.org/tx/0x095c84a3a13fdec75c6a093664fabbebcbc0aeea415b2202e087ab96fb17d7a6). The existing pilot manifest and unrelated work were preserved.

Additional actual desktop journeys:

- Opened the funded live pool without a wallet: Connect wallet shown; RIP disabled; actual available inventory still readable.
- Switched to the connected Base Account with actual zero tUSDC; clicked RIP $1; saw the insufficient-tUSDC error with no transaction request. Closed the error and recovered.
- Reconnected MetaMask, typed TRIP3 search, opened its live direct link, reviewed actual strike/expiry and selected $1.
- Cancelled a real 1 tUSDC approval prompt; verified “Signing was cancelled” and retry recovery.
- The user confirmed the bounded 1 tUSDC approval. [Successful approval transaction](https://sepolia.basescan.org/tx/0x0213fe4fd86c52ba05bd1a1a0f3474cd40fe8903946abd35bc5d303e0934718c); [actual Approval event](rips-evidence/sepolia-test-approvals.json). Allowance is 1,000,000 raw units, not unlimited.
- Quote expiry during approval exposed a disappearing unowned detail page. Fixed it by retaining the catalog separately from executable quotes; retested the expired direct link with readable metadata, buying disabled and Refresh pool recovery.
- A subsequent wallet purchase attempt showed “Interaction failed” on Base Sepolia, without a transaction hash or explorer link. Getter checks confirmed no purchased position and zero cost. This is a verified wallet failure, **not a claimed on-chain reverted receipt**.
- Public RPC rejected 1,000-block history queries with “eth_getLogs is limited to a 200 range”. Reduced pages to 200 blocks and added a regression test; actual bounded approval-log scanning succeeded.
- Inspected the live unowned position at 375×812; no document horizontal overflow. Added actual transaction-phase text, disabled amount changes while pending, and displayed the quoted N quantity before purchase.

The selected $1 purchase succeeded in [transaction `0x4ab5…21bd`](https://sepolia.basescan.org/tx/0x4ab5820f4571a47c4ca087ca8f8d318a419f48f7a346ad5a355b7d69141621bd), block 47857134. [Verified receipt/event and getter audit](rips-evidence/sepolia-purchase-receipt.json): position 3, 10,000,000 raw N units (0.1 at 8 decimals), 1,000,000 raw tUSDC paid, lifetime cost 1 tUSDC, current held units 0.1 N, wallet balance 510 tUSDC. The UI showed “Added $1.00” and the same receipt link. My Rips showed $1 spent after reload and disconnect/reconnect. Owned detail and mobile share cards showed the real cost and testnet label; clipboard text/link and direct friend preview were verified. The 375px owned layout had no horizontal overflow.

A transient RPC failure during navigation briefly showed “No Rips yet.” The recovery fix retains the same wallet’s last verified snapshot with an explicit stale-data notice, disables buying on a failed read, and shows unavailable holdings rather than an empty wallet when there is no verified snapshot. Wallet changes still clear the previous snapshot. The retry recovered the real holding. Rips tests, TypeScript, targeted lint and production build passed after the recovery change.

MetaMask was subsequently locked. It was unlocked using the user-supplied credential without saving it. Two pending requests were visible; an expired quote warning decoded to `NoInventory()`. Both were cancelled and the app’s signing-cancelled recovery was verified. An individual quote refresh prepared the successful retry. No on-chain reverted receipt is inferred from this simulation warning.

The first deployment read returned no contract data immediately after its successful receipt. Receipts/code were rechecked and recovered; the helper now waits for two confirmations and checkpoints each submitted hash, avoiding duplicate deployment or split actions on restart. A long-name mock-token deployment estimate also failed; shorter, still explicit test-asset names successfully deployed.

The original Base pilot uses RAW_SHARE series and cannot seed this pool’s required TOTAL_RETURN N inventory. The fixture’s mock oracle, collateral and arbitrary quotes have **no economic value**. A successful fixture purchase will prove transaction plumbing and ownership persistence, not real-stock pricing or liquidity.

Automatic approval review rejected final funding and token-approval Confirm clicks because it requires the user to execute consequential wallet actions personally, even with explicit authorization and test assets. The user performed funding and approval. Permission is recorded; the remaining requirement is execution of final wallet confirmations.

## 9 October 2026 run (Brave + Claude in Chrome)

App: `http://localhost:3100` (`pnpm dev -p 3100 --webpack` with the pool overrides below; port 3000 was another project).

| Journey | Result |
| --- | --- |
| Connect MetaMask in Brave | `0x9757…6aa5`, 510 tUSDC shown |
| Random $1 Rip through the UI | Pulled TRIP3 (position 3). [tx `0x74dc…3bfc`](https://sepolia.basescan.org/tx/0x74dca0d2a899b9161326163db360c8016ae76d39fa387fc0192b30a13cb63bfc) success; `RipPurchased` from the pool; balance 509; TRIP3 inventory $49 → $48. MetaMask sent it as an EIP-7702 smart account via a relayer, so `to` is not the pool; the pool event is authoritative. |
| Reveal “Buy $5 more” through the UI | Exact 5 tUSDC approval confirmed. Purchase refused by the MetaMask relay (`FAILED_WOULD_REVERT`) because the quote expired, then later because a quote refresh replaced `quoteRef` while the request was pending (`QuoteChanged`). Nothing was charged. |
| Selected $5 through the UI | Not completed: the human confirmation round trip repeatedly exceeded the pool’s 5-minute `MAX_QUOTE_AGE`. |
| Random $1, $5 top-up, selected $20 (contract path) | Sent from a session-only test buyer `0x31C7…49f6` with the app’s call sequence (exact approve, then `ripUp`/`buyPosition` with on-chain `unitsPerRip`/`quoteRef`). [`ripUp` `0x6cc2…83ec`](https://sepolia.basescan.org/tx/0x6cc24efa99b4395b44ba11283cdc0dacc9d29c61ad1e91fd35111e6e180083ec) pulled position 5 for 1 tUSDC; [$5 `0xf2ce…018c`](https://sepolia.basescan.org/tx/0xf2ce2e7d791c4e77a3d5647bd5b8587d81ffc32885f103d8a83d2e4e0e13018c) on position 5 (lifetime 6 tUSDC, 0.6 N); [$20 `0x6409…e125`](https://sepolia.basescan.org/tx/0x640909637d34192ffc101ee6531f5dbffab3afba128c68ad64d2225e1b74e125) on position 7, full 2.0 N fill. |
| Real on-chain reverted purchase | [`0xdeca…47da`](https://sepolia.basescan.org/tx/0xdeca728486b84abdc4f94430168068cf515a1a03c1826602c8faf5ad39f247da): stale `quoteRef`, simulation skipped, status `reverted`, no event, no tUSDC moved. |
| UI reflects chain | Reload showed TRIP5 $44, TRIP7 $30, TRIP4 unchanged $50, total $472. My Rips for `0x9757…` showed TRIP3 $2 spent after reload. |

Fixes from this run: wallet-relay `would revert` errors now say the quote likely expired or changed and nothing was charged (with a regression test); the reveal screen offers Refresh pool when top-up is unavailable; token metadata reads retry so tickers don’t fall back to addresses on public RPC drops; non-essential Rips UI is hidden behind `app/lib/rips/ui.ts` flags.

## 10 October 2026: full UI run with the embedded test wallet

`app/lib/dev-test-wallet.ts` adds a **Test wallet (dev)** connector, only under `next dev` on chain 84532 and only when `NEXT_PUBLIC_DEV_TEST_WALLET_KEY` is passed to the dev process (never stored in the repo or `.env.local`). It signs locally with a session-only test key, so every journey, including confirmations, was clicked in the app in Brave.

| Journey (UI, test wallet `0x31C7…49f6`) | Result |
| --- | --- |
| Switch wallet from MetaMask to Test wallet (dev) | Address and 74 tUSDC balance shown |
| Random $1 Rip → reveal | Pulled TRIP5; [tx `0xa330…e174b`](https://sepolia.basescan.org/tx/0xa330f67efd57ee8fed56c88d595259b984e9cfbd6221adf82c29fb65bffe174b) |
| Reveal “Buy $5 more” | “Added $5.00 · total spent $12.00 on TRIP5” |
| Selected $20 (TRIP8) | Succeeded on chain ([`0x65a5…b78a`](https://sepolia.basescan.org/tx/0x65a5c7292df35203e8207b7f24fd479c9a1bb692f2270cc6ad06c33ece79b78a)) but the UI said “could not confirm”. **Bug, fixed below.** |
| Selected $20 (TRIP9) after a fresh approval | Simulation falsely reverted against a lagging RPC node. **Bug, fixed below.** Retried: [`0xf2cd…7b14`](https://sepolia.basescan.org/tx/0xf2cd328433b5939e3de7ba2bfb9ccf8e0cefc12752917013cbe6958669cd7b14), “Added $20.00” |
| Selected $5 (TRIP10) with approval | Purchase succeeded ([`0x9f4a…1425`](https://sepolia.basescan.org/tx/0x9f4a586701343e7b9e45cfdb7bfe8634e4df7768db96494de90b3b1369b01425)); UI correctly said confirmed-but-not-loaded, which led to the root cause below |
| After the root-cause fix: random $1, “Buy $5 more”, selected $20 (TRIP1) with approval | All clean, no error banners: TRIP5 total $18; [$20 `0xe72e…3ad0`](https://sepolia.basescan.org/tx/0xe72e5d9db20f92a2a357a22a90e80e5f699258df9c8eac5b04e4af3d5cc83ad0); Full details 2.0 N held / 2.0 N purchased |
| My Rips after reload | $103 spent: TRIP5 $18, TRIP7 $20, TRIP8 $20, TRIP9 $20, TRIP10 $5, TRIP1 $20, matching `purchasedValue` on chain |

Root cause of the intermittent failures: the public Base Sepolia RPC allows 25 requests/second and counts each call in a JSON-RPC batch; the app sent batches of up to 32 (`-32007 25/second request limit reached` on roughly a quarter of calls). Fixes:

- `lib/chain.ts`: Multicall3 batching for contract reads, JSON-RPC batches capped at 10.
- `lib/rips/use-rips.ts`: pool refresh and post-receipt reads retry; a decoded `RipPurchased` is never reported as failed (“Purchase confirmed on chain, but loading it failed…”); after an approval, wait until the allowance is visible before simulating.
- `lib/rips/live.ts`: token metadata reads retry before falling back to an address.

Signing cancellation and the MetaMask relay refusal were verified with MetaMask on 9 October; the embedded wallet always signs. Real redemption still waits for batch maturity.

## 10 October 2026: seller-supplied Rips

`MarketRipPool` now lets any seller lock stock into an active house market and be paid directly (see [operations](market-rip-operations.md#seller-listings)). Six new contract tests cover direct payment, kept P, repricing invalidating reviewed quotes, withdraw-then-merge, seller-only controls and return-to-seller at expiry; `forge test --offline` passes 274/274.

v2 fixture on Base Sepolia (`/tmp/erodoro-rips-sepolia-v2.json`): pool [`0xa102…760d`](https://sepolia.basescan.org/address/0xa102bc9ec5d8b6e9e8d33a3083a1e816e756760d), put `0xad55…8085`, deploy block 47903477, ten house markets active. Clicked in Brave with **Test seller (dev)** `0x827b…d402` and **Test buyer (dev)** `0x31C7…49f6`:

| Journey | Result |
| --- | --- |
| Seller: Lock & list 2 TRIP1 at $8/claim | Exact approval + `lockAndList` confirmed; listing shows $8.00/claim, seller holds 2 P |
| Buyer: market list | Listing shown as “TRIP1 ↑ $16.00 available · Sold by 0x827b…d402” beside the house TRIP1 |
| Buyer: selected $5 of the listing | 0.625 N at the seller's price; [tx `0x1927…2c0f`](https://sepolia.basescan.org/tx/0x19277b6ad812dcf157dfc379d8b5eb2da5e2b35a7ac08f91921753d4e6672c0f) transfers 5 tUSDC buyer → seller; house balance unchanged |
| Seller: earnings | “$5.00 earned · 1 buyer”; wallet 5 tUSDC |
| Seller: Change price → $9 | Confirmed, listing shows $9.00/claim |
| Seller: Withdraw unsold, then Unlock | 1.375 N returned, merged back to 1.375 TRIP1; seller holds 9.375 TRIP1 and 0.625 P backing the sold N |
| Buyer: My Rips | TRIP1 $5.00 spent |

Not yet clicked: reclaim after expiry and redeeming P after settlement (batch matures 9 November); covered by contract tests.

## Continue the real testnet run

The local app uses `NEXT_PUBLIC_RIP_POOL_ADDRESS=0xeda960663c1b38f5ab172b75b472fa82c48a92c7`, `NEXT_PUBLIC_RIP_PUT_ADDRESS=0x096e94a423add6b8ec255e44d98b8019b0cab42d`, `NEXT_PUBLIC_RIP_DEPLOY_BLOCK=47852434`, chain 84532 and the public Sepolia RPC. These are process overrides, not pilot configuration edits.

Refresh all short-lived mock quotes with `node scripts/rips-sepolia.mjs quotes`, or one position with `node scripts/rips-sepolia.mjs quotes 3`. The successful $1 purchase consumed its bounded allowance. Continue random $1, reveal top-up $5 and selected $5/$20 purchases, inspecting each real receipt and on-chain getters. The user must click final MetaMask Confirm buttons as required by automatic browser approval review. Continue the other pending journeys and update this report with verified receipts and costs.

## Evidence and files

- [Successful live purchase](rips-evidence/live-purchase-success.jpg)
- [Reloaded live My Rips](rips-evidence/live-my-rips-reloaded.jpg)
- [Owned mobile Rip](rips-evidence/live-owned-mobile.jpg)
- [Live share card](rips-evidence/live-share-card.jpg)
- [Live mobile share](rips-evidence/live-share-mobile.jpg)
- [Funded live pool without wallet](rips-evidence/live-no-wallet.jpg)
- [Live insufficient funds](rips-evidence/live-insufficient-funds.jpg)
- [Cancelled real signing](rips-evidence/live-signing-cancelled.jpg)
- [Expired quote details](rips-evidence/live-expired-quote-details.jpg)
- [Live unowned mobile position](rips-evidence/live-unowned-position-mobile.jpg)
- [Wallet failed interaction](rips-evidence/live-wallet-failed-interaction.png)
- [Source hashes and dates](rips-evidence/source-provenance.json)
- [Reuse disclosure](rips-colosseum-disclosure.md)
- [Real wallet and unconfigured pool](rips-evidence/live-wallet-desktop.jpg)
- [Restored app while final funding confirmation is pending](rips-evidence/funding-handoff-app.jpg)
- [Cancelled wallet connection](rips-evidence/wallet-cancelled-desktop.jpg)
- [Mobile My Rips, simulated](rips-evidence/my-rips-mobile.jpg)
- [Mobile position, simulated](rips-evidence/position-mobile.jpg)
- [Desktop share card, simulated](rips-evidence/share-card-desktop.jpg)
- [Mobile copied share link, simulated](rips-evidence/share-card-mobile.jpg)

Changed files are recorded precisely by the logical Git commits: contracts/interfaces (`572abbe`), UI/Base integration (`0f1edb0`), browser-discovered recovery/layout fixes, and test/evidence support. Browser fixes are `06ba49b`. The [exact Rips file list](rips-evidence/changed-files.txt) and saved check logs are included. Newer remote commits were merged without rebasing or changing dates (`03ced25`). Unrelated local edits remain uncommitted, and the preservation stash is retained for recovery.
