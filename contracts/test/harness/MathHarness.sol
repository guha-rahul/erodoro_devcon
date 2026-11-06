// SPDX-License-Identifier: Apache-2.0
pragma solidity 0.8.28;

import {PayoutMath} from "../../src/libraries/PayoutMath.sol";
import {StrikeMath} from "../../src/libraries/StrikeMath.sol";

/// @notice External wrappers around the internal math libraries.
/// @dev Internal library functions are inlined as jumps, so a revert inside one
///      happens at the same call depth as `vm.expectRevert` and the cheatcode
///      cannot see it. Every negative-path assertion goes through this harness.
contract MathHarness {
    function mulDivFloor(uint256 a, uint256 b, uint256 d) external pure returns (uint256) {
        return PayoutMath.mulDivFloor(a, b, d);
    }

    function mulDivCeil(uint256 a, uint256 b, uint256 d) external pure returns (uint256) {
        return PayoutMath.mulDivCeil(a, b, d);
    }

    function normalizeDecimals(uint256 v, uint256 from, uint256 to) external pure returns (uint256) {
        return PayoutMath.normalizeDecimals(v, from, to);
    }

    function computePools(uint256 collateral, uint256 strike, uint256 price)
        external
        pure
        returns (uint256, uint256)
    {
        return PayoutMath.computePools(collateral, strike, price);
    }

    function effectiveStrike(uint256 strike, uint256 mCreation, uint256 mSettlement)
        external
        pure
        returns (uint256)
    {
        return StrikeMath.effectiveStrike(strike, mCreation, mSettlement);
    }

    function resolveMultiplier(uint256 current, uint256 effectiveAt, uint256 priceTs, uint256 nowTs)
        external
        pure
        returns (uint256)
    {
        return StrikeMath.resolveMultiplier(current, effectiveAt, priceTs, nowTs);
    }

    function requireNoScheduledChange(uint256 effectiveAt, uint256 nowTs, uint256 horizonTs) external pure {
        StrikeMath.requireNoScheduledChange(effectiveAt, nowTs, horizonTs);
    }

    function validateMultiplier(uint256 m) external pure {
        StrikeMath.validateMultiplier(m);
    }
}
