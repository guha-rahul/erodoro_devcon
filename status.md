# Erodoro status

Current as of **2026-08-25**.

This file is the short source of truth for what exists, what tests proved,
and what still blocks a production release. Detailed product work remains in
[`todo.md`](todo.md). Contract risks and limitations remain in
[`contracts/SECURITY.md`](contracts/SECURITY.md) and
[`contracts/docs/known-limitations.md`](contracts/docs/known-limitations.md).

## Product

Erodoro lets a holder lock an eligible B20 tokenized stock, choose a strike and
expiry, and receive two ERC-6909 claims. `P` receives the collateral value up to
the strike. `N` receives the value above the strike. The seller keeps `P` and
sells `N` for a cash premium through signed market-maker quotes.

This is a fully collateralized covered-call payoff. It is not downside
protection: the seller keeps the stock's downside and gives up gains above the
strike.

## Network status

### Base mainnet

- **No Erodoro contracts are deployed.**
- [`contracts/deployments/base.json`](contracts/deployments/base.json) is
  configuration-only.
- The repository records Base mainnet fork testing against real AAPLc state, a
  canonical Pyth receiver, and a signed Hermes update. A fork test does not send
  a transaction to Base and is not deployment or audit evidence.
- There is no externally audited release, live USDC market, or committed
  production market maker.

### Base Sepolia

- The vault, Pyth adapter, factory, RFQ contract, faucet, test quote token, and
  issuer-control sandbox are deployed from the current contract source. A UMA
  fallback adapter is also deployed. Exact addresses and runtime code hashes are recorded in
  [`contracts/deployments/base-sepolia.json`](contracts/deployments/base-sepolia.json).
- Direct `eth_getCode` probes on 2026-08-25 confirmed code at every recorded
  Erodoro contract address. The exact collateral, primary oracle, fallback
  oracle, feed, model, delay and precision tuple is active in the factory.
- Separate seller, maker and settlement-caller accounts completed the live
  lifecycle. The seller split 1 tAAPLc, sold 1 N for 6.15 tUSDC, and kept P.
  The first signed Pyth print at maturity settled the series at $310.92342.
  The seller redeemed 0.90054329 tAAPLc and the maker redeemed 0.09945671.
- Both claim supplies, `lockedOf`, `tokenLocked`, the vault collateral balance,
  and the RFQ custody balances ended at zero. All transaction receipts have
  status `1` and are recorded in the deployment artifact.
- The quote was signed outside the lifecycle script, but by the built-in house
  maker. This proves the external-signature plumbing. It does not prove market demand.
- The factory admin is an EOA. That is acceptable for the sandbox and a mainnet
  blocker.

### Live Base Sepolia pilot record

- Series: `0x2c751c04dad65b1cfc72ad52b46bb684ca1f6f39fdf84253a5938edcc8323f4a`.
- Active configuration: `0xa4b94f69258c2187bddfaea4e7f83e3a4133de2c97ba4167bc4ec3472494ce1b`.
- Terms: tAAPLc, $280 strike, RAW_SHARE, regular-session AAPL/USD,
  60-second settlement delay, 60-second price window and 24-hour UMA delay.
- Split: [`0xf7eab7...789c7`](https://sepolia.basescan.org/tx/0xf7eab7934a66e0d81dbd54f91a56893294335790d532cd76f9959afc313789c7).
- RFQ fill: [`0xa7f486...282b`](https://sepolia.basescan.org/tx/0xa7f4863a2e1d9ba11b4671ced081ebb516bfedbb461c9d2f7595348830fc282b).
- Settlement: [`0x9ed3b0...1798e`](https://sepolia.basescan.org/tx/0x9ed3b0f28f0d420f7cead58eeddc67d522f1789d16f915e6d7fb613ebbe1798e).
- P redemption: [`0x1eeb05...5c781`](https://sepolia.basescan.org/tx/0x1eeb05e46cd6e151f998eb3f27007f78d35c56ff0af3f42d4dafdd878745c781).
- N redemption: [`0xb90219...bce26`](https://sepolia.basescan.org/tx/0xb902196697314ec190d719117a6956ff30cdfdca5a6438243200f339e32bce26).

| Checkpoint | Seller | Maker | Vault and RFQ |
| --- | --- | --- | --- |
| After faucet | 5 tAAPLc, 500 tUSDC | 5 tAAPLc, 500 tUSDC | No claims or quote token held by RFQ |
| After split | 4 tAAPLc, 1 P, 1 N | Unchanged | 1 tAAPLc locked |
| After RFQ fill | 1 P, 0 N, 506.15 tUSDC | 1 N, 493.85 tUSDC | RFQ claim and quote balances are zero |
| After redemption | 4.90054329 tAAPLc, no claims | 5.09945671 tAAPLc, no claims | Vault collateral and both lock counters are zero; both claim supplies are zero |

The deployment artifact records the complete address, code-hash, transaction
and raw-balance set. The values above were read again after the receipts were mined.

## Verification status

| Check | Current evidence | Boundary |
| --- | --- | --- |
| Solidity unit, integration, fuzz and invariant suites | `forge test --offline`: 142 passed, 0 failed on 2026-08-25 | Includes the complete pilot deployment, exact feed binding, role-separated lifecycle, both price models, issuer controls, and UMA recovery paths. |
| RFQ worker boundary | `pnpm test`: 6 passed, 0 failed on 2026-08-25 | Covers the public route, a funded response, an unfunded response, no maker, unsupported requests, and changed quote fields. It does not prove external demand. |
| UMA Base Sepolia fork | 2 passed, 0 failed on 2026-08-25 | Uses live OOv2, whitelist and bond-token contracts on a disposable fork. It sends no testnet transaction. |
| Coinbase oracle registry | Live `eth_call` and B20-aware fork returned AAPLc multiplier `1e18` and `paused=false` on 2026-08-25 | The unit suite covers pause, zero multiplier, wrong feed, and registry failure. |
| Base mainnet fork | `make fork-test`: 6 passed, 0 failed on 2026-08-25 | Uses live AAPLc, Coinbase registry, Pyth, and a signed Hermes update. It sends no transaction. |
| Base Sepolia contracts | Current stack, runtime hashes and exact active settlement tuple read on 2026-08-25 | Source has not been published to a public explorer |
| Base Sepolia lifecycle and RFQ | All recorded receipts independently returned status `1`; final balances and supplies were read from chain | The maker is a project-controlled test account, not an external desk |
| Frontend lint | `pnpm lint`: passed on 2026-08-25 | Static frontend check only |
| Frontend production build | `pnpm build`: passed with webpack on 2026-08-25 | The static export uses recorded series IDs when the build runner cannot reach Base Sepolia. Viem emits a non-fatal Tempo import warning. |
| Static platform routes | `pnpm check:export` verifies six fixed routes and at least one recorded market route in CI | This checks generated files and route-specific content. It does not replace wallet-browser automation. |
| External security review | None | Internal review is not an audit |
| Mainnet economic evidence | None | No real maker, production quote, real USDC premium, or mainnet expiry |

## Current blockers

1. **N liquidity is unproven.** The RFQ path works with a house test maker, but
   no external desk has committed to quote real size or described its pricing,
   inventory, and hedge policy.
2. **The public release boundary is open.** There is no external audit, mainnet
   multisig/admin policy, verified mainnet deployment, legal eligibility review,
   or capped canary plan.
3. **The testnet source is not public on an explorer.** The repository records
   the source commit and live runtime hashes. Publishing the source still needs
   explicit approval because it is a public disclosure.
4. **Some issuer state is still not readable.** The live B20 release does not
   expose the scheduled-multiplier surface. Coinbase's current oracle pause is
   readable, but an instant multiplier change cannot be detected before it
   happens on the live Beryl release.

## Local pilot evidence

The local pilot uses separate seller, maker, and settlement-caller addresses.
It completes the faucet, split, signed N sale, settlement, and separate redemption path.

The pilot also exercises these failure states:

- No maker and changed maker response at the worker boundary.
- Expired and unfunded maker quotes.
- A stale oracle print and a wide confidence band.
- A 2-for-1 multiplier change.
- An issuer transfer pause and a policy denial.

This deterministic evidence is supplemented by the completed Base Sepolia pilot
above. Neither form of evidence includes an external maker commitment.

[`contracts/docs/base-sepolia-pilot.md`](contracts/docs/base-sepolia-pilot.md)
defines the live procedure. `DeployPilot.s.sol` deployed the complete current
stack and granted the required B20 roles. The live run used separate funded
accounts and encrypted local keystores. Raw private keys are not stored in the repository.

The internal review found and corrected these integration errors:

- The factory configuration did not bind the fallback delay.
- The house maker used an old vault ABI.
- The create hook decoded a named tuple as a positional tuple.
- The broad Wagmi connector import broke the webpack build.
- The worker defaulted to the wrong Base network.
- The worker returned quotes before the on-chain funding check.
- The fork reused a Pyth unique update and selected a non-first print.

## Next release proof

The role-separated Base Sepolia contract lifecycle is complete. The next proof
is economic, not another house-account transaction. Obtain one external maker
commitment, connect its endpoint, and run the same narrow series with a funded
quote. Record response rate, size, spread, expiry, failures, inventory limits,
hedge path, monitoring owner and settlement owner.

That would close Task 4 for a testnet pilot. It would still not justify a
mainnet launch until the security, legal, oracle and admin gates close.
