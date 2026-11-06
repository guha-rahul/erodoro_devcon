# Stock Buy / Sell

Route: `/swap`, with a direction switch for USDC → stock and stock → USDC.
Legacy `/buy` and `/sell` links redirect to the corresponding direction.
This is a frontend/Worker change only: no contracts, routers, approvals or
deployment addresses change. This route is **Base mainnet** (8453), independent of
the Base Sepolia Earn/vault configuration. Buying does not deposit into Earn.
Selling requires tokens in the wallet, not claims or locked collateral.

Routing is provided by the [0x Swap API](https://0x.org/docs/api) through the
Worker. The 0x API key is a Worker secret and never reaches the browser. The
Worker validates the request, pins the chain to Base mainnet, and returns 0x's
own executable transaction plus the `allowanceTarget` the wallet must approve.
The app approves **that** address, for exactly the amount being swapped, and
never a router named in a response or a spender copied from documentation.

## Local development

Create `app/.env.local` (gitignored) with:

```dotenv
BASE_MAINNET_RPC_URL=https://YOUR-BASE-MAINNET-RPC-ENDPOINT
```

Run `pnpm --dir app dev --port 3001`. This starts Next on 3001 and a local
read-only API shim on 127.0.0.1:8787. Restart after editing `.env.local`.
Never add `NEXT_PUBLIC_` to a private RPC variable. The optional
`NEXT_PUBLIC_BASE_MAINNET_RPC_URL` override is for intentionally public endpoints.

## Cloudflare deployment

The existing `erodoro-base` Worker serves `/stocks`, `/rpc/mainnet`, and the 0x
proxy at `/api/swap/price` and `/api/swap/quote`; no separate backend
deployment, database, or new swap contract is needed.

1. Add `BASE_MAINNET_RPC_URL` as an **encrypted Worker secret** on `erodoro-base`
   in the Cloudflare dashboard (or `npx wrangler secret put BASE_MAINNET_RPC_URL`).
   Use a Base mainnet endpoint, not Sepolia. Do not put its value in build output,
   source control, a `NEXT_PUBLIC_` variable, or `wrangler.jsonc`.
2. Add `ZEROX_API_KEY` as an **encrypted Worker secret**
   (`npx wrangler secret put ZEROX_API_KEY`). Without it the proxy returns 503
   and the UI says swap routing is not configured; it never falls back to an
   unauthenticated route.
3. Deploy the code through the existing GitHub / Workers Builds integration.
   `npx wrangler deploy` runs the configured install/build/export checks.
4. Check `/rpc/mainnet` returns chain ID `0x2105`, `/stocks` returns a fresh
   catalog, and `/api/swap/price` returns an executable transaction for a small
   USDC → stock quote. Do not submit a transaction for a smoke test.

The mainnet RPC secret does **not** replace `PRIVATE_RPC_URL`, which is used by
the existing testnet vault/RFQ. Without a mainnet secret, reads fall back to
`https://mainnet.base.org`, which rate limits. The proxy refuses transaction
submission methods; users sign and broadcast using their own wallets.

## Discovery and coverage

There is no fixed stock array. `cloudflare/stock-catalog.mjs` reads:

- [Base's launched Coinbase stocks](https://brand.base.org/stocks).
- [Backed xStocks token list](https://github.com/backed-fi/cowswap-xstocks-tokenlist).
- [Ondo's token list](https://github.com/ondoprotocol/ondo-global-markets-token-list).
- [Backed bToken product pages](https://assets.backed.fi/products), using each
  page's explicitly marked Base address, with a legacy-issuance warning.

Only Base addresses are included. Stocks/funds may share a ticker across
issuers; identity is chain + token address. Pool names are not issuer proof.
The cache lasts at most 15 minutes (one minute on partial failure). Source
failures appear in the UI and never manufacture a fallback stock list. Future
assets in these sources appear without an app release; new issuers need a
reviewed source adapter. This is not a claim to cover every possible issuer.

On 2026-09-09 these sources returned 27 distinct Base listings: 10 Coinbase
stocks and 17 legacy Backed products, including funds. The downloaded xStocks
and Ondo lists had no Base entries. This is a catalog count, not 27 executable
markets; token reads, routing, and live quotes are separate checks. Routing
coverage is now 0x's, not a hand-maintained factory list, so it extends to any
venue 0x routes on Base. That is a coverage improvement and also a dependency:
the app no longer decides which pools exist. No transactions were submitted.
This is a point-in-time observation, not a liquidity guarantee.

## Execution safeguards

- Read chain and wallet chain must both be 8453; recipient is the active wallet.
- The Worker pins chain and both token roles; a caller cannot relabel a sell as
  a buy. One leg of every swap must be the configured quote token (USDC).
- A response is refused unless it names a valid non-zero `allowanceTarget`,
  non-zero `buyAmount`, and a transaction with calldata whose token roles match
  the request.
- Amount parsing rejects excess precision, scientific notation, and overflow.
- Slippage options: 0.1%, 0.5%, 1%, bounded to 0–10% at the Worker as well.
- Exact-amount approval to the returned allowance target, then a **separate**
  fresh `quote` and swap confirmation. A `price` quote is for editing only.
- Every write is simulated, with wallet/account/chain checks immediately before
  submission. Reverted receipts never show success.
- Stock restrictions can reject transfers even when approvals succeed. The
  issuer-terms acknowledgement is not a compliance/KYC verification system.
- Fees are included in quotes; wallet gas is additional. No real transactions
  are sent by automated tests.

## Checks

`pnpm test` covers catalog parsing, source failures, mainnet proxy isolation,
and the 0x proxy's request/response validation. `pnpm --dir app check:stock-swap`
covers amount parsing, USDC-leg derivation, quote validation and execution
guards with mocked reads/writes. `check:stock-swap-browser` drives the real
client against a fixture routing response. CI also builds and checks both static
routes.

These tests are not an audit, jurisdictional clearance, or proof that an
arbitrary user's wallet can trade every listed token. Verify those before
promoting a public real-money launch.

