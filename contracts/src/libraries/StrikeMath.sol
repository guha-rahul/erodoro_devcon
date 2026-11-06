// SPDX-License-Identifier: Apache-2.0
pragma solidity 0.8.28;

import {PayoutMath} from "./PayoutMath.sol";
import {Errors} from "./Errors.sol";

/// @title StrikeMath
/// @notice Corporate-action handling (§6), ported from `common/src/math.rs`.
///
/// A B20 Asset multiplier rebases what one raw token unit represents without
/// moving any value. Left unadjusted, a 2-for-1 split halves the quoted price
/// against a fixed strike and wipes out the N side in an event where nobody
/// lost a penny.
///
/// @dev Two things the Solana original needed are gone here:
///
///      - `multiplier_to_fixed` and `MULTIPLIER_SCALE = 1e12`. Token-2022 stores
///        the multiplier as an `f64`, so the Rust had to convert a float into
///        fixed point and reject non-finite values. B20 stores a `uint128` in
///        WAD, which is already the representation the math wants. The only
///        float in the protocol, and its whole class of rounding questions, is
///        deleted rather than ported.
///
///      - `MAX_MULTIPLIER`. B20 enforces its own ceiling of `type(uint128).max`
///        at the setter, which is what keeps `balance * multiplier` inside
///        `uint256`. Re-checking it is retained as a cheap invariant, not as the
///        primary guard.
library StrikeMath {
    /// @notice B20's multiplier precision. Mirrors `IB20Asset.WAD_PRECISION()`.
    uint256 internal constant WAD = 1e18;

    /// @notice B20's multiplier ceiling. Mirrors `IB20Asset.MAX_UI_MULTIPLIER()`.
    uint256 internal constant MAX_UI_MULTIPLIER = type(uint128).max;

    /// @notice Reject a multiplier the protocol will not settle against.
    /// @dev B20 reads a stored `0` as `WAD`, so a zero here means the caller
    ///      passed a raw slot rather than the result of `multiplier()`.
    function validateMultiplier(uint256 multiplier) internal pure {
        if (multiplier == 0 || multiplier > MAX_UI_MULTIPLIER) revert Errors.MultiplierInvalid();
    }

    /// @notice Adjust the stored strike for a corporate action that landed
    ///         during the series term.
    ///
    /// ```text
    /// effectiveStrike = ceil(strike * multiplierAtCreation / multiplierAtSettlement)
    /// ```
    ///
    /// @dev Exact for a pure split: balances scale by `k`, the quoted price
    ///      scales by `1/k`, and scaling the strike by `1/k` restores the
    ///      original economics exactly.
    ///
    ///      Rounds **up**, so any sub-tick remainder accrues to the senior P
    ///      claim. This can raise the effective strike to at most one price tick
    ///      above the exact ratio, which at worst moves one tick of value from N
    ///      to P. It can never make the pools fail to sum to collateral, because
    ///      `computePools` derives `nPool` by subtraction.
    function effectiveStrike(uint256 strike, uint256 multiplierAtCreation, uint256 multiplierAtSettlement)
        internal
        pure
        returns (uint256)
    {
        if (strike == 0) revert Errors.InvalidStrike();
        validateMultiplier(multiplierAtCreation);
        validateMultiplier(multiplierAtSettlement);
        if (multiplierAtCreation == multiplierAtSettlement) return strike;

        uint256 adjusted = PayoutMath.mulDivCeil(strike, multiplierAtCreation, multiplierAtSettlement);
        // A deep enough reverse split could round the strike to zero, which
        // `computePools` would reject anyway. Fail with the specific cause.
        if (adjusted == 0) revert Errors.InvalidStrike();
        return adjusted;
    }

    /// @notice Establish which multiplier was in force when the settlement price
    ///         was printed, or refuse to settle.
    ///
    /// @param current     `IB20Asset.multiplier()` as read in the settling block.
    /// @param effectiveAt `IB20Asset.effectiveAt()`, or 0 on a chain whose asset
    ///                    variant does not advertise the ERC-8056 pending
    ///                    extension.
    /// @param priceTs     `publishTime` of the settlement quote.
    /// @param nowTs       `block.timestamp` of the settling transaction.
    ///
    /// @dev **This is where the port diverges from Solana, and it is a downgrade
    ///      forced by the chain rather than a design choice.**
    ///
    ///      Token-2022 keeps the pre-flip multiplier in its own field until it is
    ///      folded, so `resolve_multiplier` on Solana can *choose* between the
    ///      old and new value using the price timestamp. B20 Asset computes the
    ///      flipped value on read once `effectiveAt` passes and never writes the
    ///      old value back; `newUIMultiplier()` then mirrors `multiplier()`.
    ///      Once matured, the pre-flip multiplier is not recoverable through the
    ///      interface at all.
    ///
    ///      So the three resolvable cases return `current`, and the fourth —
    ///      a flip that took effect strictly inside `(priceTs, nowTs]` — reverts.
    ///      Settlement is permissionless and the quote is caller-supplied, so
    ///      rejecting costs a resubmission with a price printed on the far side
    ///      of the flip. Guessing would cost one side its money.
    ///
    ///      On a pre-Cobalt chain there is no pending schedule to read and
    ///      `effectiveAt` is 0, so an instant `updateMultiplier` landing inside
    ///      the window is undetectable here. That exposure is bounded by
    ///      `maxPriceLag` and recorded in docs/known-limitations.md; it is not
    ///      defended against, because it cannot be.
    function resolveMultiplier(uint256 current, uint256 effectiveAt, uint256 priceTs, uint256 nowTs)
        internal
        pure
        returns (uint256)
    {
        validateMultiplier(current);

        // No schedule readable (pre-Cobalt), or none ever set.
        if (effectiveAt == 0) return current;
        // Live pending: has not flipped yet, so `current` held across the window.
        if (effectiveAt > nowTs) return current;
        // Flipped at or before the price print: `current` already reflects it.
        if (effectiveAt <= priceTs) return current;

        // priceTs < effectiveAt <= nowTs — the flip is inside the window.
        revert Errors.MultiplierFlipInSettlementWindow();
    }

    /// @notice Refuse to open a series when a multiplier change is already
    ///         scheduled to land before `horizonTs`.
    ///
    /// @dev The conservative half of the dividend answer: the protocol cannot
    ///      tell a split from a rebased cash dividend, so it declines to write
    ///      one across a known corporate action. Ex-dividend dates are published
    ///      weeks ahead, so in practice this covers every *announced* action.
    ///
    ///      Only reachable on a chain advertising the ERC-8056 pending
    ///      extension. Callers on a pre-Cobalt chain pass `effectiveAt = 0` and
    ///      this is a no-op — the gate is unavailable, not silently passing.
    function requireNoScheduledChange(uint256 effectiveAt, uint256 nowTs, uint256 horizonTs) internal pure {
        if (effectiveAt > nowTs && effectiveAt <= horizonTs) revert Errors.MultiplierChangeScheduled();
    }
}
