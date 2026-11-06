# ETHGlobal Mumbai submission (draft)

## Project name
Erodoro Rips

## Short description (≤100 characters)
Buy the upside of a stock in $1 slices. One allowance per human, settled at Chainlink's price.

## Description
Rips sell the upside of a tokenized stock in $1 slices. A stock holder locks stock in Erodoro's vault, which splits it
into a capped claim they keep and an upside claim above today's price + 5%. Buyers pay $1 for slices of that upside;
at expiry the vault settles at the stock's price and pays the upside out in the stock itself, so real stock backs every
payout.

Three things stood between that and something people can use:

- **Who gets the small inventory.** Each batch holds about $50 of upside. Without proof of personhood, one buyer with
  many wallets takes it all. With World ID, each person has one allowance per batch, counted across every wallet they
  verify.
- **Who sets the settlement price.** The house sells Rips, so it must not set the price it pays out. A Chainlink CRE
  workflow brings Chainlink's stock feeds from Base mainnet to the settlement oracle on Base Sepolia, and the vault
  settles at the first report after expiry.
- **Getting out before expiry.** Rips couldn't be resold. Each Rip now has a Uniswap v4 pool against USDC, behind a
  hook that only lets verified humans trade.

Everything runs on Base Sepolia with real transactions: verify with World ID, buy Rips (any quantity, split across
transactions), hit the per-person limit, trade on Uniswap, and settle and redeem after expiry.

## How it's made
- **Contracts (Foundry, Solidity 0.8.28).** `CreSettlementOracle` implements Erodoro's oracle interface and stores
  every CRE price report, returning the first one at or after maturity. `HumanRegistry` binds one wallet per World ID
  nullifier, takes reports from the CRE forwarder, and caps each person's spend per batch; the Rips pool asks it before
  every sale. `RipsResaleHook` is a Uniswap v4 hook (`beforeSwap`, `beforeAddLiquidity`, `beforeInitialize`, address
  mined with CREATE2) that resolves the real user through Universal Router's and PositionManager's `msgSender()` and
  requires a verified human.
- **Chainlink CRE (TypeScript SDK).** `rips-prices`: cron → `latestRoundData` on ten Chainlink stock feeds on Base
  mainnet → one report → Base Sepolia. `verify-human`: HTTP trigger with the IDKit proof → checks action, Proof of
  Human and that the signal is the wallet → World's verify API through the HTTP capability with consensus (retried,
  since CRE caps HTTP at 10 seconds) → report to the registry.
- **World ID (IDKit 4).** `IDKitRequestWidget` requests Proof of Human, v4 only, with the wallet as the signal. A small
  verifier signs the request context with the RP key and runs the CRE workflow; the static app has no server.
- **Uniswap v4.** Upside claims are wrapped 1:1 as ERC-20 and pooled against USDC at the house price with full-range
  liquidity through PositionManager. The app quotes with V4Quoter and swaps through Universal Router
  (`V4_SWAP`: `SWAP_EXACT_IN_SINGLE`, `SETTLE_ALL`, `TAKE_ALL`) with Permit2.
- **App.** Next.js 16, wagmi, viem. Tested by driving a real browser on Base Sepolia; the demo video was recorded the
  same way, with Playwright and a scripted cursor.
- **Notable hack.** The CRE simulation forwarder relays reports from anyone, so both receivers also pin the account
  that runs the simulation. With deploy access, they switch to Chainlink's live forwarder and drop the pin.

## Partner prizes
- **Uniswap: Build with Uniswap.** v4 hook + resale pools on Base Sepolia; feedback in `FEEDBACK.md`.
- **World: Best Use of IDKit.** Proof of Human for a one-allowance-per-person rule; trust moment, minimum credential and
  debrief in `docs/ethglobal-mumbai.md`.
- **Chainlink: CRE.** Two workflows (prices for settlement, World ID verification), simulated with real Base Sepolia
  broadcasts.

## Links
- Demo video: `docs/walkthrough/rips-demo.mp4`
- Write-up: `docs/ethglobal-mumbai.md`
- Contracts on Base Sepolia: CreSettlementOracle `0x7f2deb530d3679dad4a3ebc7c542e92ac8b34de0`, HumanRegistry
  `0xfed3524d60eb9936a7f5dc97d454c622c1426a78`, MarketRipPool `0x4d65cfb8776235076116de88969b5c6bb35ac1b2`,
  RipsResaleHook `0x6C996BC405594d0e8116F0E9350f792650D6E880`

## AI tools
Built with Claude Code (Anthropic): partner research, contract, workflow and frontend code, tests, driving the app in a
browser to test it on Base Sepolia, and recording the demo. Uniswap's AI skills (`uniswap/uniswap-ai`) were used as
reference for the hook review.
