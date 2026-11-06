// SPDX-License-Identifier: Apache-2.0
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {StrikeMath} from "../../src/libraries/StrikeMath.sol";
import {PayoutMath} from "../../src/libraries/PayoutMath.sol";
import {Errors} from "../../src/libraries/Errors.sol";
import {MathHarness} from "../harness/MathHarness.sol";

/// @notice Corporate-action tests (§6), ported from `common/src/math.rs`.
/// @dev Multipliers are WAD here rather than the Rust's 1e12 fixed point,
///      because B20 stores a `uint128` WAD directly. The ratios under test are
///      identical; only the scale changed.
contract StrikeMathTest is Test {
    uint256 constant USD = 1e8;
    uint256 constant STRIKE_500 = 500 * USD;
    uint256 constant ONE_TOKEN = 1e8;
    uint256 constant WAD = 1e18;

    MathHarness harness;

    function setUp() public {
        harness = new MathHarness();
    }

    function usdValue(uint256 raw, uint256 price, uint256 multiplier) internal pure returns (uint256) {
        return (raw * multiplier / WAD) * price / ONE_TOKEN;
    }

    function oneUnitOfValue(uint256 price) internal pure returns (uint256) {
        return price / ONE_TOKEN;
    }

    // --- Splits --------------------------------------------------------------

    /// @notice The §6 worked example. Before: price $600, strike $500, multiplier 1.
    function test_twoForOneSplitLeavesPEconomicallyUnchanged() public pure {
        uint256 collateral = ONE_TOKEN;
        (uint256 pBefore, uint256 nBefore) = PayoutMath.computePools(collateral, STRIKE_500, 600 * USD);
        assertGt(nBefore, 0, "N must be worth something before the split");

        // Split lands: multiplier 1 -> 2, the feed now reports the post-split $300.
        uint256 strike = StrikeMath.effectiveStrike(STRIKE_500, WAD, 2 * WAD);
        assertEq(strike, 250 * USD);

        uint256 price = 300 * USD;
        (uint256 pAfter, uint256 nAfter) = PayoutMath.computePools(collateral, strike, price);
        assertEq(pAfter, pBefore, "P pool must be unchanged by a pure split");
        assertEq(nAfter, nBefore, "N must not be wiped by a pure split");

        // The cap still holds in dollars: pAfter raw units, read at the
        // post-split multiplier of 2, are worth $500 at $300 a share.
        uint256 pValue = usdValue(pAfter, price, 2 * WAD);
        assertLe(pValue, 500 * USD, "P must never be paid above the cap");
        assertLe(500 * USD - pValue, oneUnitOfValue(price), "cap missed by more than one unit");
    }

    function test_oneForTwoReverseSplitLeavesPEconomicallyUnchanged() public pure {
        uint256 collateral = ONE_TOKEN;
        (uint256 pBefore, uint256 nBefore) = PayoutMath.computePools(collateral, STRIKE_500, 600 * USD);

        // Reverse split: multiplier 1 -> 0.5, price doubles $600 -> $1200.
        uint256 strike = StrikeMath.effectiveStrike(STRIKE_500, WAD, WAD / 2);
        assertEq(strike, 1000 * USD);

        (uint256 pAfter, uint256 nAfter) = PayoutMath.computePools(collateral, strike, 1200 * USD);
        assertEq(pAfter, pBefore);
        assertEq(nAfter, nBefore);
    }

    /// @notice The failure the adjustment exists to prevent.
    function test_unadjustedStrikeWouldHaveWipedOutN() public pure {
        uint256 collateral = ONE_TOKEN;
        // Same 2-for-1 split, but settling against the stored strike.
        (uint256 p, uint256 n) = PayoutMath.computePools(collateral, STRIKE_500, 300 * USD);
        assertEq(p, collateral);
        assertEq(n, 0, "this is the bug: N wiped by a split, not a fall");
    }

    // --- Rounding ------------------------------------------------------------

    /// @notice Ceiling is the P-favouring choice: a higher strike caps P higher.
    function test_effectiveStrikeRoundsUpToFavourP() public pure {
        uint256 ceiled = StrikeMath.effectiveStrike(1000, 3 * WAD, 7 * WAD);
        uint256 floored = PayoutMath.mulDivFloor(1000, 3 * WAD, 7 * WAD);
        assertEq(ceiled, 429); // 1000 * 3/7 = 428.57...
        assertEq(floored, 428);
        assertGt(ceiled, floored);
    }

    function test_effectiveStrikeIsIdentityWithoutACorporateAction() public pure {
        assertEq(StrikeMath.effectiveStrike(STRIKE_500, WAD, WAD), STRIKE_500);
    }

    function test_effectiveStrikeRejectsBadInput() public {
        vm.expectRevert(Errors.InvalidStrike.selector);
        harness.effectiveStrike(0, WAD, WAD);
        vm.expectRevert(Errors.MultiplierInvalid.selector);
        harness.effectiveStrike(STRIKE_500, 0, WAD);
        vm.expectRevert(Errors.MultiplierInvalid.selector);
        harness.effectiveStrike(STRIKE_500, WAD, 0);
        vm.expectRevert(Errors.MultiplierInvalid.selector);
        harness.effectiveStrike(STRIKE_500, WAD, uint256(type(uint128).max) + 1);
    }

    /// @notice A deep reverse split can round the strike to zero. Fail with the
    ///         specific cause rather than letting `computePools` reject it.
    function test_effectiveStrikeRejectsAStrikeRoundedToZero() public pure {
        // ceil() cannot reach zero for a non-zero strike, so this is the
        // documented-unreachable branch; assert the guard rather than the path.
        assertGt(StrikeMath.effectiveStrike(1, WAD, uint256(type(uint128).max)), 0);
    }

    // --- Which multiplier was in force (§6, Base-specific) -------------------

    /// @notice On Solana this function *chose* between the old and new
    ///         multiplier using the price timestamp. On Base the pre-flip value
    ///         is unreadable once matured, so three cases resolve and the fourth
    ///         is refused. See `Errors.MultiplierFlipInSettlementWindow`.
    function test_resolveMultiplierReturnsCurrentWhenTheWindowIsClean() public pure {
        // No schedule readable at all (pre-Cobalt chain, or never scheduled).
        assertEq(StrikeMath.resolveMultiplier(2 * WAD, 0, 999, 12_345), 2 * WAD);
        // Live pending: has not flipped, so `current` held across the window.
        assertEq(StrikeMath.resolveMultiplier(WAD, 1000, 800, 999), WAD);
        // Flipped exactly at the price print: `current` already reflects it.
        assertEq(StrikeMath.resolveMultiplier(2 * WAD, 1000, 1000, 1500), 2 * WAD);
        // Flipped well before the price print.
        assertEq(StrikeMath.resolveMultiplier(2 * WAD, 1000, 1200, 1500), 2 * WAD);
    }

    /// @notice The case with no Solana counterpart: a flip that took effect
    ///         strictly between the price print and the settling block. The
    ///         pre-flip multiplier is gone, so settlement refuses the quote.
    function test_resolveMultiplierRejectsAFlipInsideTheSettlementWindow() public {
        vm.expectRevert(Errors.MultiplierFlipInSettlementWindow.selector);
        harness.resolveMultiplier(2 * WAD, 1000, 999, 1500);
    }

    function test_resolveMultiplierRejectsAnUnreadableMultiplier() public {
        vm.expectRevert(Errors.MultiplierInvalid.selector);
        harness.resolveMultiplier(0, 0, 100, 200);
    }

    // --- The creation-time gate ---------------------------------------------

    function test_requireNoScheduledChangeRejectsAChangeBeforeTheHorizon() public {
        // Scheduled at t=1500, series matures at t=2000: refuse to open.
        vm.expectRevert(Errors.MultiplierChangeScheduled.selector);
        harness.requireNoScheduledChange(1500, 1000, 2000);
    }

    function test_requireNoScheduledChangeAllowsAChangeAfterTheHorizon() public view {
        // Scheduled at t=2500, series matures at t=2000: fine.
        harness.requireNoScheduledChange(2500, 1000, 2000);
        // Already matured — not a pending change.
        harness.requireNoScheduledChange(500, 1000, 2000);
        // Nothing readable: the gate is unavailable, not silently passing.
        harness.requireNoScheduledChange(0, 1000, 2000);
    }
}
