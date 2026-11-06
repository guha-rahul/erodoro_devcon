// SPDX-License-Identifier: Apache-2.0
pragma solidity 0.8.28;

import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {Errors} from "./Errors.sol";

/// @title PayoutMath
/// @notice Solvency-critical integer math, ported from `common/src/math.rs`.
///
/// Two rounding conventions run through this library, and both are deliberate:
///
/// 1. **Payouts floor.** Every value paid out of the vault rounds down, so
///    `totalPaid <= collateralLocked` regardless of redemption order.
/// 2. **Rounding favours P.** P is the senior claim; where a rounding choice
///    moves value between the two sides it moves it to P. Flooring the
///    normalized price rounds `pPool` up; ceiling the effective strike (see
///    `StrikeMath`) does the same. Both are asserted in tests rather than left
///    to emerge from the arithmetic.
///
/// @dev The Rust original works in `i128` and guards every input against being
///      negative. Those guards are absent here because `uint256` makes the
///      condition unrepresentable — not because the check was dropped. The
///      corresponding `InvalidAmount` paths therefore do not appear.
///
///      `checked_mul_div_rem`'s quotient/remainder accumulation is also gone:
///      it existed because `u64::MAX * u64::MAX` overflows `i128` even when the
///      quotient fits (finding #5). `Math.mulDiv` carries a full 512-bit
///      intermediate, so the fast path is always exact and the workaround has
///      no purpose on this chain.
library PayoutMath {
    /// @notice Maximum number of decimals this library will scale by.
    uint256 internal constant MAX_DECIMALS = 18;

    // --- Primitives ----------------------------------------------------------

    /// @notice `floor(a * b / denominator)`.
    /// @dev Every payout goes through this helper so that value paid out always
    ///      rounds down, protecting solvency.
    function mulDivFloor(uint256 a, uint256 b, uint256 denominator) internal pure returns (uint256) {
        if (denominator == 0) revert Errors.DivisionByZero();
        return Math.mulDiv(a, b, denominator, Math.Rounding.Floor);
    }

    /// @notice `ceil(a * b / denominator)`.
    /// @dev Used only where rounding up is the conservative direction —
    ///      currently the effective strike, where rounding up favours the senior
    ///      P claim. Never used for a payout.
    function mulDivCeil(uint256 a, uint256 b, uint256 denominator) internal pure returns (uint256) {
        if (denominator == 0) revert Errors.DivisionByZero();
        return Math.mulDiv(a, b, denominator, Math.Rounding.Ceil);
    }

    /// @notice `10^exp`.
    function pow10(uint256 exp) internal pure returns (uint256) {
        if (exp > MAX_DECIMALS) revert Errors.InvalidDecimals();
        return 10 ** exp;
    }

    /// @notice Re-scale a fixed-point `value` from `fromDecimals` to `toDecimals`.
    /// @dev Scaling up multiplies by a power of ten; scaling down divides and
    ///      floors, which is the safe rounding direction for a settlement price.
    function normalizeDecimals(uint256 value, uint256 fromDecimals, uint256 toDecimals)
        internal
        pure
        returns (uint256)
    {
        if (fromDecimals > MAX_DECIMALS || toDecimals > MAX_DECIMALS) revert Errors.InvalidDecimals();
        if (fromDecimals == toDecimals) return value;
        if (toDecimals > fromDecimals) {
            uint256 factor = pow10(toDecimals - fromDecimals);
            unchecked {
                uint256 scaled = value * factor;
                if (value != 0 && scaled / value != factor) revert Errors.MathOverflow();
                return scaled;
            }
        }
        return value / pow10(fromDecimals - toDecimals);
    }

    // --- The payoff ----------------------------------------------------------

    /// @notice Split `collateral` into the P pool and the N pool.
    ///
    /// ```text
    /// price <= strike: pPool = collateral,                     nPool = 0
    /// price >  strike: pPool = floor(collateral*strike/price), nPool = collateral - pPool
    /// ```
    ///
    /// @dev Callers must pass the *effective* strike (see `StrikeMath`), not the
    ///      strike stored at creation, or a corporate action moves value between
    ///      the two sides.
    ///
    ///      `nPool` is derived by subtraction, never by a second division, so
    ///      `pPool + nPool == collateral` holds exactly for every input. That is
    ///      what lets settlement record a supply mismatch instead of reverting.
    function computePools(uint256 collateral, uint256 strike, uint256 price)
        internal
        pure
        returns (uint256 pPool, uint256 nPool)
    {
        if (strike == 0) revert Errors.InvalidStrike();
        if (price == 0) revert Errors.OraclePriceInvalid();
        if (price <= strike) return (collateral, 0);
        pPool = mulDivFloor(collateral, strike, price);
        // strike < price implies pPool <= collateral, so this cannot underflow.
        nPool = collateral - pPool;
    }

    /// @notice Pro-rata redemption payout: `floor(amount * pool / supply)`.
    /// @dev A zero supply means nothing was ever minted, so nothing is
    ///      redeemable. Returning zero rather than reverting keeps a holder who
    ///      burned their claim outside the protocol from bricking the series.
    function computeRedeem(uint256 amount, uint256 pool, uint256 supply) internal pure returns (uint256) {
        if (supply == 0) return 0;
        return mulDivFloor(amount, pool, supply);
    }

    // --- Shortfall (§7) ------------------------------------------------------

    /// @notice Scale a quoted payout down when the vault holds less than it owes.
    ///
    /// ```text
    /// available = vaultBalance
    /// expected  = (pPool - pRedeemed) + (nPool - nRedeemed)
    /// payout    = floor(quoted * available / expected)   when available < expected
    /// ```
    ///
    /// @dev The issuer can remove collateral from a settled vault. Paying quoted
    ///      amounts until the vault empties would hand everything to whoever
    ///      redeems first; instead every redeemer takes the same proportional
    ///      haircut whenever they show up.
    ///
    ///      `expected` is the *outstanding* obligation rather than the original
    ///      pools, so the ratio stays correct as redemptions proceed: a redeemer
    ///      arriving after a drain sees the same ratio as one arriving
    ///      immediately after it.
    function applyShortfall(uint256 quoted, uint256 available, uint256 expected) internal pure returns (uint256) {
        if (expected == 0) return 0;
        if (available >= expected) return quoted;
        return mulDivFloor(quoted, available, expected);
    }
}
