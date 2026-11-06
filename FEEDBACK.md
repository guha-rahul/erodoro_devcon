# Uniswap developer feedback

Erodoro Rips sells the upside of tokenized stocks in $1 slices. At ETHGlobal Mumbai we gave every Rip a resale
market: Uniswap v4 pools on Base Sepolia that pair the wrapped upside claim with test USDC, behind our own hook
(`RipsResaleHook`) that lets only World ID verified humans trade.

## What worked well
- **Routers name the user.** Universal Router and PositionManager both answer `msgSender()` while they hold the
  lock, so a hook can check the person behind a swap, not the router. That's what made an identity gate possible
  without asking users to sign hook data.
- **V4Quoter as an exempt caller.** Its simulated swaps always revert, so exempting it from the gate lets anyone
  see a price before verifying, without opening a way around the gate.
- **Hook address mining is cheap.** With the deterministic CREATE2 deployer on Base Sepolia, finding a salt for
  `beforeInitialize | beforeAddLiquidity | beforeSwap` took a few thousand tries in a script.
- **The Uniswap AI skills.** `v4-security-foundations` gave us a checklist; its "fuzz testing" item led to a fuzz
  test that found a real bug in our hook (a zero address meant "exempt" internally, so a router that named no user
  would have passed). We fixed and redeployed before the demo.

## Where we got stuck
1. **Two Universal Routers on Base Sepolia with different calldata.** The deployments list both UR 2.0
   (`0x492E…4104`) and UR 2.1.2 (`0x8702…2650`, the one the Trading API uses). From 2.1.1 the v4 swap actions carry
   `minHopPriceX36`, so the same `SWAP_EXACT_IN_SINGLE` encoding is valid on one and reverts on the other. A table of
   router version → action layout per chain would have saved a round of trial swaps.
2. **Hook reverts come back wrapped.** A refused swap returns
   `WrappedError(hook, beforeSwap.selector, NotVerifiedHuman(user), HookCallFailed())`. We decode it ourselves to show
   "verify with World ID first"; a decoding helper in the SDK would help every hook with user-facing errors.
3. **`msgSender()` isn't documented as a guarantee for hooks.** We confirmed on-chain that both routers on Base
   Sepolia expose it. Stating which router and position-manager versions implement `IMsgSender`, and that they
   return the locker during a swap, would let hook authors rely on it.
4. **Permissioned pools stop at Ethereum Sepolia.** Our stock tokens and the rest of Erodoro live on Base, so we
   wrote our own allowlist hook rather than using Uniswap's permissioned pools.
5. **Hook mining lives in test utilities.** `HookMiner` sits under v4-periphery's tests; a small CLI or SDK
   function would make deploying a hook a one-liner.
6. **Trading API and custom hooks.** The supported-chains page lists Base Sepolia, but we couldn't tell from the
   docs whether the API routes pools with arbitrary hooks, so the app calls Universal Router directly with quotes
   from V4Quoter.

## What we'd like
- A per-chain table of router versions and their v4 action layouts.
- `WrappedError` decoding in the v4 SDK.
- Documented `msgSender()` behaviour for routers that hooks can rely on.
- Permissioned pools on Base Sepolia, or guidance for running identity-gated pools on chains without them.
