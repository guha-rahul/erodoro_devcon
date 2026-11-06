// SPDX-License-Identifier: Apache-2.0
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {PayoutMath} from "../../src/libraries/PayoutMath.sol";
import {StrikeMath} from "../../src/libraries/StrikeMath.sol";

/// @notice The property suite, ported from `common/src/proptests.rs`.
///
/// @dev Bounds are carried over unchanged so the two suites explore the same
///      space, even though `uint256` would permit far wider ranges than `i128`
///      did. Sign guards are gone because `uint256` makes negativity
///      unrepresentable, not because the property weakened.
contract PayoutPropertiesTest is Test {
    uint256 constant BIG = 1e18;
    uint256 constant PRICE_MAX = 1e12;
    uint256 constant COLLATERAL_MAX = 1e17;
    uint256 constant WAD = 1e18;

    function absDiff(uint256 a, uint256 b) internal pure returns (uint256) {
        return a > b ? a - b : b - a;
    }

    /// @notice `mulDivFloor` returns the exact floor of `a*b/d`.
    function testFuzz_mulDivIsExactFloor(uint256 a, uint256 b, uint256 d) public pure {
        a = bound(a, 0, BIG);
        b = bound(b, 0, BIG);
        d = bound(d, 1, BIG);

        uint256 r = PayoutMath.mulDivFloor(a, b, d);
        uint256 prod = a * b; // <= 1e36, inside uint256
        assertLe(r * d, prod, "floor below");
        assertLt(prod, (r + 1) * d, "floor tight");
    }

    /// @notice Pools always partition the collateral, stay within bounds, and P
    ///         is non-increasing in price.
    function testFuzz_poolsPartitionAndAreMonotonic(uint256 collateral, uint256 strike, uint256 price)
        public
        pure
    {
        collateral = bound(collateral, 0, COLLATERAL_MAX);
        strike = bound(strike, 1, PRICE_MAX);
        price = bound(price, 1, PRICE_MAX);

        (uint256 p, uint256 n) = PayoutMath.computePools(collateral, strike, price);
        assertEq(p + n, collateral);
        assertLe(p, collateral);
        assertLe(n, collateral);
        if (price <= strike) {
            assertEq(p, collateral);
            assertEq(n, 0);
        }
        // Raising the price never increases the P pool.
        (uint256 pHigher,) = PayoutMath.computePools(collateral, strike, price + 1);
        assertLe(pHigher, p);
    }

    /// @notice The core solvency property: redeeming any partition of the supply
    ///         pays out at most the pool. Each side is an independent instance.
    function testFuzz_redeemingAPartitionNeverOverdraws(uint256 supply, uint256 pool, uint256[] memory cuts)
        public
        pure
    {
        supply = bound(supply, 1, BIG);
        pool = bound(pool, 0, supply);
        if (cuts.length > 8) {
            assembly {
                mstore(cuts, 8)
            }
        }

        // Turn the random cut points into contiguous parts summing to `supply`.
        uint256[] memory points = new uint256[](cuts.length + 2);
        for (uint256 i = 0; i < cuts.length; i++) {
            points[i] = bound(cuts[i], 0, supply);
        }
        points[cuts.length] = 0;
        points[cuts.length + 1] = supply;

        // Insertion sort; the array is at most 10 long.
        for (uint256 i = 1; i < points.length; i++) {
            uint256 key = points[i];
            uint256 j = i;
            while (j > 0 && points[j - 1] > key) {
                points[j] = points[j - 1];
                j--;
            }
            points[j] = key;
        }

        uint256 totalPaid;
        for (uint256 i = 1; i < points.length; i++) {
            totalPaid += PayoutMath.computeRedeem(points[i] - points[i - 1], pool, supply);
        }
        assertLe(totalPaid, pool, "overdrew pool");
    }

    /// @notice Scaling up to more decimals is lossless and exactly reversible.
    function testFuzz_normalizeUpThenDownRoundtrips(uint256 value, uint256 from, uint256 delta) public pure {
        value = bound(value, 0, BIG);
        from = bound(from, 0, 9);
        delta = bound(delta, 0, 9);
        uint256 to = from + delta;

        uint256 up = PayoutMath.normalizeDecimals(value, from, to);
        assertEq(PayoutMath.normalizeDecimals(up, to, from), value);

        // Scaling down then back up can only lose precision, never gain value.
        uint256 down = PayoutMath.normalizeDecimals(value, to, from);
        assertLe(PayoutMath.normalizeDecimals(down, from, to), value);
    }

    /// @notice §6 as a property rather than as two worked examples.
    ///
    /// @dev A corporate action moves the price and the multiplier together.
    ///      Adjusting the strike by the same ratio leaves both pools where they
    ///      were, to within the slack the flooring steps allow.
    ///
    ///      Only ratios WAD represents exactly are in scope. That is not a
    ///      dodge: real corporate actions are 2:1, 1:2, 3:2, 20:1 and the like,
    ///      all exact here. A ratio like 1:3 is inherently approximated by the
    ///      fixed-point scale, and the residual is the multiplier's documented
    ///      resolution rather than anything `effectiveStrike` can fix.
    function testFuzz_corporateActionPreservesThePools(
        uint256 collateral,
        uint256 strike,
        uint256 price,
        uint256 ratioNum,
        uint256 ratioDen
    ) public pure {
        collateral = bound(collateral, 1, COLLATERAL_MAX);
        strike = bound(strike, 1, PRICE_MAX);
        price = bound(price, 1, PRICE_MAX);
        ratioNum = bound(ratioNum, 1, 20);
        ratioDen = bound(ratioDen, 1, 20);
        vm.assume((WAD * ratioNum) % ratioDen == 0);

        (uint256 pBefore,) = PayoutMath.computePools(collateral, strike, price);

        uint256 mSettlement = WAD * ratioNum / ratioDen;
        vm.assume(mSettlement > 0);
        uint256 newPrice = price * ratioDen / ratioNum;
        vm.assume(newPrice > 0);

        uint256 adjusted = StrikeMath.effectiveStrike(strike, WAD, mSettlement);
        (uint256 pAfter, uint256 nAfter) = PayoutMath.computePools(collateral, adjusted, newPrice);

        // Pools still partition the collateral, whatever the action was.
        assertEq(pAfter + nAfter, collateral);

        // And P lands where it was, within the rounding three integer steps
        // allow: the ceiling in `effectiveStrike` moves the strike by at most 1
        // (worth `collateral / newPrice` of p), the floored synthetic price move
        // drops `newPrice` by at most 1 (worth another `collateral / newPrice`),
        // and the two floors in `computePools` contribute 1 each.
        uint256 slack = 2 * (collateral / newPrice) + 2;
        assertLe(absDiff(pAfter, pBefore), slack, "p moved further than the rounding allows");
    }

    /// @notice However a settled vault is drained, and in whatever order
    ///         redeemers arrive, the haircut never pays out more than the vault
    ///         holds and each claim gets the same share.
    function testFuzz_shortfallIsOrderIndependentAndSolvent(uint256 available, uint256[] memory claims)
        public
        pure
    {
        vm.assume(claims.length >= 1);
        if (claims.length > 5) {
            assembly {
                mstore(claims, 5)
            }
        }
        available = bound(available, 0, BIG);

        uint256 expected;
        for (uint256 i = 0; i < claims.length; i++) {
            claims[i] = bound(claims[i], 1, BIG);
            expected += claims[i];
        }

        uint256[] memory reversed = new uint256[](claims.length);
        for (uint256 i = 0; i < claims.length; i++) {
            reversed[i] = claims[claims.length - 1 - i];
        }

        (uint256 totalForward, uint256[] memory forward) = _settle(claims, available, expected);
        (uint256 totalReverse, uint256[] memory reverseRun) = _settle(reversed, available, expected);

        uint256 cap = available < expected ? available : expected;
        assertLe(totalForward, cap, "forward paid more than the vault held");
        assertLe(totalReverse, cap, "reverse paid more than the vault held");

        // Each claim gets the same payout regardless of when it is presented.
        //
        // Not bit-identical: each payout floors, so the vault keeps a sub-unit
        // remainder that very slightly improves the ratio for whoever redeems
        // next. Over `n` claims that drift accumulates to at most `n` units,
        // plus one for the claim's own flooring. That is the difference between
        // "the same haircut" and "first-come-first-served", which is what §7 is
        // actually about.
        uint256 tolerance = claims.length + 1;
        for (uint256 i = 0; i < claims.length; i++) {
            uint256 mirrored = reverseRun[claims.length - 1 - i];
            assertLe(absDiff(forward[i], mirrored), tolerance, "order changed a payout");
        }
    }

    function _settle(uint256[] memory order, uint256 available, uint256 expected)
        internal
        pure
        returns (uint256 total, uint256[] memory paid)
    {
        uint256 left = available < expected ? available : expected;
        uint256 owed = expected;
        paid = new uint256[](order.length);
        for (uint256 i = 0; i < order.length; i++) {
            uint256 payout = PayoutMath.applyShortfall(order[i], left, owed);
            left -= payout;
            owed -= order[i];
            paid[i] = payout;
            total += payout;
        }
    }
}
