// SPDX-License-Identifier: Apache-2.0
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {IB20Asset} from "base-std/interfaces/IB20Asset.sol";
import {TestIssuerControls} from "../../src/periphery/TestIssuerControls.sol";
import {PayoutMath} from "../../src/libraries/PayoutMath.sol";
import {StrikeMath} from "../../src/libraries/StrikeMath.sol";
import {MockB20Asset} from "../harness/MockB20Asset.sol";

contract TestIssuerControlsTest is Test {
    MockB20Asset token;
    TestIssuerControls controls;

    uint256 constant WAD = 1e18;
    uint256 constant USD = 1e8;

    function setUp() public {
        vm.chainId(84532);
        token = new MockB20Asset("Apple (test)", "tAAPLc", 8, false);
        controls = new TestIssuerControls(IB20Asset(address(token)));
    }

    function test_simulatesAForwardSplit() public {
        controls.simulateSplit(2, 1);
        assertEq(token.multiplier(), 2 * WAD);
    }

    function test_simulatesAReverseSplit() public {
        controls.simulateSplit(1, 2);
        assertEq(token.multiplier(), WAD / 2);
    }

    /// @notice The reason this exists: a tester can fire the exact event the
    ///         strike adjustment defends against, and check it holds.
    function test_aSimulatedSplitIsWhatTheStrikeAdjustmentAnswers() public {
        uint256 collateral = 1e8;
        uint256 strike = 500 * USD;
        (uint256 pBefore, uint256 nBefore) = PayoutMath.computePools(collateral, strike, 600 * USD);
        assertGt(nBefore, 0);

        controls.simulateSplit(2, 1);

        // Price halves with the split; the strike must halve with it.
        uint256 effective = StrikeMath.effectiveStrike(strike, WAD, token.multiplier());
        (uint256 pAfter, uint256 nAfter) = PayoutMath.computePools(collateral, effective, 300 * USD);
        assertEq(pAfter, pBefore, "a pure split must move no value");
        assertEq(nAfter, nBefore, "and must not wipe the upside");
    }

    function test_pauseAndResume() public {
        vm.expectRevert(
            abi.encodeWithSelector(
                MockB20Asset.AccessControlUnauthorizedAccount.selector, address(controls), token.PAUSE_ROLE()
            )
        );
        controls.setTransfersPaused(true);

        token.grantRole(token.PAUSE_ROLE(), address(controls));
        controls.setTransfersPaused(true);
        (, bool paused) = controls.state();
        assertTrue(paused);

        vm.expectRevert(
            abi.encodeWithSelector(
                MockB20Asset.AccessControlUnauthorizedAccount.selector, address(controls), token.UNPAUSE_ROLE()
            )
        );
        controls.setTransfersPaused(false);

        token.grantRole(token.UNPAUSE_ROLE(), address(controls));
        controls.setTransfersPaused(false);
        (, paused) = controls.state();
        assertFalse(paused);
    }

    function test_resetPutsTheMultiplierBack() public {
        controls.simulateSplit(3, 1);
        assertEq(token.multiplier(), 3 * WAD);
        controls.resetMultiplier();
        assertEq(token.multiplier(), WAD);
    }

    function test_rejectsAbsurdRatios() public {
        vm.expectRevert(TestIssuerControls.RatioOutOfRange.selector);
        controls.simulateSplit(0, 1);
        vm.expectRevert(TestIssuerControls.RatioOutOfRange.selector);
        controls.simulateSplit(1, 0);
        vm.expectRevert(TestIssuerControls.RatioOutOfRange.selector);
        controls.simulateSplit(101, 1);
    }

    function test_refusesToDeployOnMainnet() public {
        vm.chainId(8453);
        vm.expectRevert(TestIssuerControls.NotForMainnet.selector);
        new TestIssuerControls(IB20Asset(address(token)));
    }
}
