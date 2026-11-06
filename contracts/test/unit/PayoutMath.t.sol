// SPDX-License-Identifier: Apache-2.0
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {PayoutMath} from "../../src/libraries/PayoutMath.sol";
import {Errors} from "../../src/libraries/Errors.sol";
import {MathHarness} from "../harness/MathHarness.sol";

/// @notice Ported case-for-case from the `mod tests` block in
///         `common/src/math.rs`. Same fixtures, same assertions, same names, so
///         a behavioural divergence between the two chains shows up as a test
///         failure rather than as a judgement call.
///
/// @dev Fixtures are equity-shaped: USD prices with 8 decimals, matching Pyth's
///      typical -8 exponent. Collateral decimals are held separately — B20
///      Asset allows 6..18 and the spec urges 18 for equities.
contract PayoutMathTest is Test {
    uint256 constant USD = 1e8; // 1.00 with 8 decimals
    uint256 constant STRIKE_500 = 500 * USD;
    uint256 constant ONE_TOKEN = 1e8; // one whole collateral unit, 8 decimals

    MathHarness harness;

    function setUp() public {
        harness = new MathHarness();
    }

    /// @dev Dollar value, in 8-decimal USD, of `raw` collateral units quoted at
    ///      `price` while the token carries `multiplier` (WAD).
    function usdValue(uint256 raw, uint256 price, uint256 multiplier) internal pure returns (uint256) {
        return (raw * multiplier / 1e18) * price / ONE_TOKEN;
    }

    /// @dev Value of a single raw collateral unit at `price`.
    function oneUnitOfValue(uint256 price) internal pure returns (uint256) {
        return price / ONE_TOKEN;
    }

    // --- Primitives ----------------------------------------------------------

    function test_mulDivFloors() public pure {
        assertEq(PayoutMath.mulDivFloor(10, 3, 4), 7); // 7.5 -> 7
        assertEq(PayoutMath.mulDivFloor(1, 1, 3), 0);
        assertEq(PayoutMath.mulDivFloor(0, 5, 3), 0);
    }

    function test_mulDivCeils() public pure {
        assertEq(PayoutMath.mulDivCeil(10, 3, 4), 8); // 7.5 -> 8
        assertEq(PayoutMath.mulDivCeil(1, 1, 3), 1);
        assertEq(PayoutMath.mulDivCeil(9, 1, 3), 3); // exact, no bump
    }

    /// @notice Finding #5, which does not exist on this chain.
    /// @dev The Rust needed quotient/remainder accumulation because
    ///      `u64::MAX * u64::MAX` overflows the `i128` intermediate even when
    ///      the quotient fits in `u64`. `Math.mulDiv` carries 512 bits, so the
    ///      same shape is exact with no workaround. Asserted rather than assumed.
    function test_mulDivHandlesLargeButRepresentableResults() public pure {
        uint256 big = type(uint128).max;
        assertEq(PayoutMath.mulDivFloor(big, big, big), big);
        assertEq(PayoutMath.mulDivFloor(type(uint256).max, 1, 1), type(uint256).max);
        // The full-width case the i128 intermediate could not express.
        assertEq(PayoutMath.mulDivFloor(type(uint256).max, big, type(uint256).max), big);
    }

    function test_mulDivStillRejectsAResultThatDoesNotFit() public {
        vm.expectRevert();
        harness.mulDivFloor(type(uint256).max, 2, 1);
    }

    function test_mulDivRejectsZeroDenominator() public {
        vm.expectRevert(Errors.DivisionByZero.selector);
        harness.mulDivFloor(1, 1, 0);
        vm.expectRevert(Errors.DivisionByZero.selector);
        harness.mulDivCeil(1, 1, 0);
    }

    function test_normalizeUpAndDown() public pure {
        assertEq(PayoutMath.normalizeDecimals(5, 0, 2), 500);
        assertEq(PayoutMath.normalizeDecimals(500, 2, 0), 5);
        assertEq(PayoutMath.normalizeDecimals(505, 2, 0), 5); // floors
        assertEq(PayoutMath.normalizeDecimals(42, 6, 6), 42);
    }

    function test_normalizeRejectsOutOfRangeDecimals() public {
        vm.expectRevert(Errors.InvalidDecimals.selector);
        harness.normalizeDecimals(1, 19, 8);
        vm.expectRevert(Errors.InvalidDecimals.selector);
        harness.normalizeDecimals(1, 8, 19);
    }

    // --- The payoff ----------------------------------------------------------

    function test_poolsBelowAtAboveStrike() public pure {
        uint256 collateral = USD;
        (uint256 p, uint256 n) = PayoutMath.computePools(collateral, STRIKE_500, 250 * USD);
        assertEq(p, collateral);
        assertEq(n, 0);

        (p, n) = PayoutMath.computePools(collateral, STRIKE_500, STRIKE_500);
        assertEq(p, collateral);
        assertEq(n, 0);

        (p, n) = PayoutMath.computePools(collateral, STRIKE_500, 1000 * USD);
        assertEq(p, collateral / 2);
        assertEq(n, collateral / 2);
    }

    /// @notice The README table: 1 token locked, $500 strike, stock at $600.
    function test_poolsMatchTheWorkedExample() public pure {
        uint256 collateral = ONE_TOKEN;
        uint256 price = 600 * USD;
        (uint256 p, uint256 n) = PayoutMath.computePools(collateral, STRIKE_500, price);

        assertEq(p, collateral * 500 / 600);
        assertEq(p + n, collateral);

        // P's dollar value is the $500 cap, short by at most the flooring of a
        // single raw unit. Never above it: the cap is what P is owed at most.
        uint256 pValue = usdValue(p, price, 1e18);
        assertLe(pValue, 500 * USD, "P must never be paid above the cap");
        assertLe(500 * USD - pValue, oneUnitOfValue(price), "cap missed by more than one unit");

        // And N holds the rest: $100 of a $600 stock capped at $500.
        uint256 nValue = usdValue(n, price, 1e18);
        assertApproxEqAbs(nValue, 100 * USD, oneUnitOfValue(price));
    }

    /// @notice The whole README table in one assertion set.
    function test_readmeTableReproduces() public pure {
        uint256 collateral = ONE_TOKEN;
        // price -> (P dollars, N dollars), within one raw unit of value.
        uint256[4] memory prices = [uint256(250 * USD), 400 * USD, 600 * USD, 1000 * USD];
        uint256[4] memory pExpected = [uint256(250 * USD), 400 * USD, 500 * USD, 500 * USD];
        uint256[4] memory nExpected = [uint256(0), 0, 100 * USD, 500 * USD];

        for (uint256 i = 0; i < prices.length; i++) {
            (uint256 p, uint256 n) = PayoutMath.computePools(collateral, STRIKE_500, prices[i]);
            assertEq(p + n, collateral, "pools must partition collateral");
            uint256 tol = oneUnitOfValue(prices[i]) + 1;
            assertApproxEqAbs(usdValue(p, prices[i], 1e18), pExpected[i], tol, "P row");
            assertApproxEqAbs(usdValue(n, prices[i], 1e18), nExpected[i], tol, "N row");
        }
    }

    function test_poolsAlwaysSumToCollateral() public pure {
        uint256 collateral = 1_000_000_000;
        uint256[7] memory prices =
            [uint256(1), 250 * USD, STRIKE_500, STRIKE_500 + 1, 999 * USD, 1000 * USD, 9999 * USD];
        for (uint256 i = 0; i < prices.length; i++) {
            (uint256 p, uint256 n) = PayoutMath.computePools(collateral, STRIKE_500, prices[i]);
            assertEq(p + n, collateral);
            assertLe(p, collateral);
            assertLe(n, collateral);
        }
    }

    function test_poolsRejectBadInput() public {
        vm.expectRevert(Errors.InvalidStrike.selector);
        harness.computePools(ONE_TOKEN, 0, 600 * USD);
        vm.expectRevert(Errors.OraclePriceInvalid.selector);
        harness.computePools(ONE_TOKEN, STRIKE_500, 0);
    }

    function test_computeRedeemOnZeroSupplyPaysNothing() public pure {
        assertEq(PayoutMath.computeRedeem(100, 500, 0), 0);
    }

    // --- Shortfall (§7) ------------------------------------------------------

    function test_shortfallIsANoopWhenTheVaultIsWhole() public pure {
        assertEq(PayoutMath.applyShortfall(100, 1000, 1000), 100);
        assertEq(PayoutMath.applyShortfall(100, 2000, 1000), 100);
    }

    function test_shortfallHaircutsProportionally() public pure {
        assertEq(PayoutMath.applyShortfall(100, 80, 100), 80);
        assertEq(PayoutMath.applyShortfall(50, 80, 100), 40);
        assertEq(PayoutMath.applyShortfall(1, 80, 100), 0); // floors
        assertEq(PayoutMath.applyShortfall(100, 0, 100), 0); // drained, no revert
        assertEq(PayoutMath.applyShortfall(100, 50, 0), 0); // nothing owed
    }

    function _runShortfall(uint256[3] memory order) internal pure returns (uint256[3] memory paid) {
        uint256 available = 60;
        uint256 expected = 100;
        for (uint256 i = 0; i < 3; i++) {
            uint256 payout = PayoutMath.applyShortfall(order[i], available, expected);
            available -= payout;
            expected -= order[i];
            paid[i] = payout;
        }
    }

    /// @notice Three redeemers owed 50/30/20 against a vault holding 60 of 100.
    ///         Every order gives each the same 60% share, because `expected`
    ///         tracks the outstanding obligation rather than the original pools.
    function test_shortfallIsIndependentOfRedemptionOrder() public pure {
        uint256[3] memory forwards = _runShortfall([uint256(50), 30, 20]);
        uint256[3] memory backwards = _runShortfall([uint256(20), 30, 50]);

        assertEq(forwards[0], 30);
        assertEq(forwards[1], 18);
        assertEq(forwards[2], 12);
        assertEq(backwards[0], 12);
        assertEq(backwards[1], 18);
        assertEq(backwards[2], 30);

        assertEq(forwards[0] + forwards[1] + forwards[2], 60);
        assertEq(backwards[0] + backwards[1] + backwards[2], 60);
    }

    /// @notice For any drain level and any split of the obligation, the total
    ///         paid never exceeds what the vault holds.
    function test_shortfallNeverOverpaysTheVault() public pure {
        uint256[7] memory drains = [uint256(0), 1, 7, 33, 60, 99, 100];
        for (uint256 d = 0; d < drains.length; d++) {
            uint256[4][4] memory cutSets = [
                [uint256(100), 0, 0, 0],
                [uint256(50), 50, 0, 0],
                [uint256(33), 33, 34, 0],
                [uint256(1), 99, 0, 0]
            ];
            for (uint256 c = 0; c < 4; c++) {
                uint256 left = drains[d];
                uint256 expected = 100;
                uint256 total = 0;
                for (uint256 i = 0; i < 4; i++) {
                    uint256 quoted = cutSets[c][i];
                    if (quoted == 0) continue;
                    uint256 payout = PayoutMath.applyShortfall(quoted, left, expected);
                    total += payout;
                    left -= payout;
                    expected -= quoted;
                }
                assertLe(total, drains[d], "paid more than the vault held");
            }
        }
    }
}
