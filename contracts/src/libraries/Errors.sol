// SPDX-License-Identifier: Apache-2.0
pragma solidity 0.8.28;

/// @title Errors
/// @notice The protocol's error table, ported one-for-one from the Solana
///         `OptionsError` enum so a failure means the same thing on both chains.
///
///         Names are deliberately identical to the Rust variants. Where a
///         condition cannot arise on Base the variant is omitted rather than
///         retained as dead weight, and the omission is noted here:
///
///         - `DivisionByZero` is kept: `Math.mulDiv` panics rather than
///           reverting with a named error, so callers pre-check.
///         - `AllowanceExpired` is dropped: it belonged to the Solana market
///           prototype, which does not port.
///         - `MultiplierChangeScheduled` is kept but is only reachable on a
///           chain whose B20 Asset advertises the ERC-8056 pending extension.
///           See `StrikeMath` and docs/porting-notes.md.
library Errors {
    // --- Authorisation / lifecycle ---
    error AlreadyInitialized();
    error NotInitialized();
    error Unauthorized();
    error SeriesClosed();
    error SeriesPaused();
    error SeriesNotMatured();
    error SettlementTooEarly();
    error AlreadySettled();
    error NotSettled();
    error CreationPaused();
    error SeriesExists();
    error SeriesNotFound();
    error DustSweepTooEarly();

    // --- Parameters ---
    error InvalidAmount();
    error AmountTooSmall();
    error InvalidStrike();
    error InvalidMaturity();
    error InvalidOracle();
    error InvalidCollateral();
    error InvalidDecimals();
    error InvalidParams();
    error CollateralDecimalsMismatch();

    // --- Oracle ---
    error OraclePriceInvalid();
    error OraclePriceStale();
    error OraclePairInvalid();
    error OracleDecimalsInvalid();
    error FeedMismatch();
    error MarketClosed();
    /// @notice The issuer paused this stock oracle while a corporate action
    ///         synchronises. Distinct from `MarketClosed` so the UI can explain
    ///         the wait instead of implying the market is broken.
    error OraclePausedForCorporateAction();
    error InvalidSettlementConfiguration();

    // --- Balances / solvency ---
    error SupplyMismatch();
    error InsufficientCollateral();
    error InsufficientBalance();

    // --- Arithmetic ---
    error MathOverflow();
    error MathUnderflow();
    error DivisionByZero();

    // --- Corporate actions (§6) ---
    error MultiplierInvalid();
    error MultiplierChangeScheduled();

    /// @notice A multiplier flip took effect strictly between the settlement
    ///         price's publish time and the settling block.
    /// @dev    Has no Solana counterpart. Token-2022 keeps the pre-flip
    ///         multiplier readable in its own field until it is folded, so the
    ///         Solana code can *resolve* which multiplier was in force at the
    ///         price timestamp. B20 Asset computes the flipped value on read
    ///         once `effectiveAt` passes and never writes the old one back, so
    ///         after maturation the pre-flip value is not recoverable through
    ///         the interface. Settlement therefore rejects the stale quote and
    ///         waits for one printed on the far side of the flip.
    error MultiplierFlipInSettlementWindow();
}
