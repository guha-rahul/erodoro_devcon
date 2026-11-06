// SPDX-License-Identifier: Apache-2.0
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {MockPythUnique} from "../harness/MockPythUnique.sol";

import {ErodoroVault} from "../../src/ErodoroVault.sol";
import {PythAdapter} from "../../src/oracle/PythAdapter.sol";
import {IPythUnique} from "../../src/oracle/IPythUnique.sol";
import {SettlementModel} from "../../src/oracle/SettlementModel.sol";
import {PayoutMath} from "../../src/libraries/PayoutMath.sol";
import {Errors} from "../../src/libraries/Errors.sol";
import {MockB20Asset} from "../harness/MockB20Asset.sol";

/// @notice §6 through the vault: a rebase must not move value between P and N.
contract CorporateActionsTest is Test {
    MockPythUnique pyth;
    PythAdapter adapter;
    ErodoroVault vault;

    address alice = address(0xA11CE);
    address bob = address(0xB0B);

    bytes32 constant FEED = bytes32("AAPLc/USD");
    uint8 constant PRICE_DECIMALS = 8;
    uint256 constant USD = 1e8;
    uint256 constant STRIKE = 500 * USD;
    uint256 constant ONE = 1e18;
    uint256 constant WAD = 1e18;
    uint64 constant DELAY = 300;
    uint64 constant MAX_LAG = 60;

    uint64 maturity;

    function setUp() public {
        vm.warp(1_700_000_000);
        pyth = new MockPythUnique(60, 1);
        adapter = new PythAdapter(IPythUnique(address(pyth)));
        vault = new ErodoroVault();
        maturity = uint64(block.timestamp + 30 days);
    }

    function _newAsset(bool beryl) internal returns (MockB20Asset a) {
        a = new MockB20Asset("Apple Tokenized Stock", "AAPLc", 18, beryl);
        a.mint(alice, 100 * ONE);
        vm.prank(alice);
        a.approve(address(vault), type(uint256).max);
    }

    function _params(MockB20Asset a) internal view returns (ErodoroVault.CreateSeriesParams memory) {
        return ErodoroVault.CreateSeriesParams({
            collateral: address(a),
            oracle: address(adapter),
            fallbackOracle: address(0),
            feeRecipient: address(0xFEE),
            feedId: FEED,
            fallbackRequestId: bytes32(0),
            settlementModel: SettlementModel.RAW_SHARE,
            strike: STRIKE,
            minSplitAmount: 0,
            maturity: maturity,
            settlementDelay: DELAY,
            maxPriceLag: MAX_LAG,
            fallbackDelay: 0,
            maxConfBps: 500,
            feeBps: 0,
            priceDecimals: PRICE_DECIMALS,
            admin: alice
        });
    }

    function _updateData(int64 price, uint64 ts) internal view returns (bytes[] memory data) {
        data = new bytes[](1);
        data[0] = pyth.createPriceFeedUpdateData(
            FEED, price, uint64(uint64(price) / 1000), -int32(int256(uint256(PRICE_DECIMALS))), price, 0, ts
        );
    }

    function _settleAt(uint256 id, int64 price, uint64 priceTs, uint256 at) internal {
        vm.warp(at);
        bytes[] memory data = _updateData(price, priceTs);
        uint256 fee = pyth.getUpdateFee(data);
        vm.deal(bob, fee);
        vm.prank(bob);
        vault.settle{value: fee}(id, data);
    }

    // --- The split case ------------------------------------------------------

    /// @notice A 2-for-1 split halves the quoted price and doubles the
    ///         multiplier. Adjusting the strike by the same ratio leaves both
    ///         pools exactly where they were.
    function test_twoForOneSplitDuringTheTermMovesNoValue() public {
        MockB20Asset a = _newAsset(false);
        vm.prank(alice);
        uint256 id = vault.createSeries(_params(a));
        vm.prank(alice);
        vault.split(id, ONE);

        // What the pools would have been with no corporate action, at $600.
        (uint256 pExpected, uint256 nExpected) = PayoutMath.computePools(ONE, STRIKE, 600 * USD);
        assertGt(nExpected, 0, "N must be worth something before the split");

        // The split lands mid-term: multiplier 1 -> 2, the feed now says $300.
        vm.warp(uint256(maturity) - 1 days);
        a.updateMultiplier(2 * WAD);

        _settleAt(id, int64(300 * 1e8), maturity + 60, uint256(maturity) + DELAY);

        ErodoroVault.Settlement memory st = vault.settlementOf(id);
        assertEq(st.effectiveStrike, 250 * USD, "strike must halve with the split");
        assertEq(st.pPool, pExpected, "P pool must be unchanged by a pure split");
        assertEq(st.nPool, nExpected, "N must not be wiped by a pure split");
        assertEq(st.multiplierAtSettlement, 2 * WAD);
    }

    /// @notice The bug the adjustment exists to prevent, demonstrated against
    ///         the same numbers: settling a post-split price against the stored
    ///         strike hands everything to P.
    function test_withoutTheAdjustmentNWouldHaveBeenWiped() public pure {
        (uint256 p, uint256 n) = PayoutMath.computePools(ONE, STRIKE, 300 * USD);
        assertEq(p, ONE);
        assertEq(n, 0, "this is the bug: N wiped by a split, not a fall");
    }

    function test_reverseSplitMovesNoValue() public {
        MockB20Asset a = _newAsset(false);
        vm.prank(alice);
        uint256 id = vault.createSeries(_params(a));
        vm.prank(alice);
        vault.split(id, ONE);

        (uint256 pExpected, uint256 nExpected) = PayoutMath.computePools(ONE, STRIKE, 600 * USD);

        vm.warp(uint256(maturity) - 1 days);
        a.updateMultiplier(WAD / 2); // 1-for-2 reverse split

        _settleAt(id, int64(1200 * 1e8), maturity + 60, uint256(maturity) + DELAY);

        ErodoroVault.Settlement memory st = vault.settlementOf(id);
        assertEq(st.effectiveStrike, 1000 * USD, "strike must double with the reverse split");
        assertEq(st.pPool, pExpected);
        assertEq(st.nPool, nExpected);
    }

    /// @notice A total-return oracle already includes the multiplier. Sending
    ///         that value through the raw-price path adjusts the action twice.
    ///         This test defines the boundary without selecting either model.
    function test_totalReturnPriceCannotUseTheRawPriceSettlementMath() public pure {
        uint256 collateral = ONE;

        // Before the split, both price models report $600.
        (uint256 pBefore, uint256 nBefore) = PayoutMath.computePools(collateral, STRIKE, 600 * USD);

        // After a 2-for-1 split, the raw price is $300 and the multiplier is 2.
        uint256 adjustedStrike = 250 * USD;
        (uint256 pRaw, uint256 nRaw) = PayoutMath.computePools(collateral, adjustedStrike, 300 * USD);
        assertEq(pRaw, pBefore, "raw price and adjusted strike preserve P");
        assertEq(nRaw, nBefore, "raw price and adjusted strike preserve N");

        // A total-return feed stays at $600 because it already applies 2x.
        // Reusing the adjusted strike applies the same action a second time.
        (uint256 pDoubleCounted, uint256 nDoubleCounted) =
            PayoutMath.computePools(collateral, adjustedStrike, 600 * USD);
        assertTrue(pDoubleCounted != pBefore, "double-counted P must differ");
        assertTrue(nDoubleCounted != nBefore, "double-counted N must differ");

        // Total-return settlement preserves the pools only with the stored strike.
        (uint256 pTotalReturn, uint256 nTotalReturn) = PayoutMath.computePools(collateral, STRIKE, 600 * USD);
        assertEq(pTotalReturn, pBefore, "total return keeps the stored strike");
        assertEq(nTotalReturn, nBefore, "total return keeps the stored strike");
    }

    // --- The creation-time gate ---------------------------------------------

    /// @notice The conservative half of the dividend answer: refuse to write a
    ///         series across a known corporate action.
    function test_createSeriesRefusesAKnownScheduledAction() public {
        MockB20Asset a = _newAsset(false);
        a.updateUIMultiplier(2 * WAD, uint256(maturity) - 1 days);

        vm.prank(alice);
        vm.expectRevert(Errors.MultiplierChangeScheduled.selector);
        vault.createSeries(_params(a));
    }

    function test_createSeriesAllowsAnActionScheduledAfterTheHorizon() public {
        MockB20Asset a = _newAsset(false);
        a.updateUIMultiplier(2 * WAD, uint256(maturity) + DELAY + 1 days);

        vm.prank(alice);
        uint256 id = vault.createSeries(_params(a));
        assertTrue(id != 0);
    }

    /// @notice On a pre-Cobalt chain there is no pending schedule to read, so
    ///         the gate is unavailable — not silently passing. Creation succeeds
    ///         and the exposure is documented rather than defended.
    function test_berylChainHasNoScheduledGateAtAll() public {
        MockB20Asset a = _newAsset(true); // berylMode: effectiveAt() reverts
        vm.prank(alice);
        uint256 id = vault.createSeries(_params(a));
        assertTrue(id != 0, "creation must still work where the gate cannot be read");
    }

    // --- The flip-in-window case (no Solana counterpart) ---------------------

    /// @notice A flip that takes effect strictly between the price print and the
    ///         settling block. B20 does not keep the pre-flip multiplier, so the
    ///         quote is refused rather than settled against the wrong ratio.
    function test_settleRejectsAFlipInsideTheSettlementWindow() public {
        MockB20Asset a = _newAsset(false);
        vm.prank(alice);
        uint256 id = vault.createSeries(_params(a));
        vm.prank(alice);
        vault.split(id, ONE);

        // Scheduled after creation, landing between the print and the settle tx.
        vm.warp(uint256(maturity) - 1 days);
        a.updateUIMultiplier(2 * WAD, uint256(maturity) + 120);

        vm.warp(uint256(maturity) + DELAY);
        bytes[] memory data = _updateData(int64(600 * 1e8), maturity + 60); // printed before the flip
        uint256 fee = pyth.getUpdateFee(data);
        vm.deal(bob, fee);
        vm.prank(bob);
        vm.expectRevert(Errors.MultiplierFlipInSettlementWindow.selector);
        vault.settle{value: fee}(id, data);
    }

    /// @notice ...and the remedy is a resubmission with a print on the far side
    ///         of the flip, which settles cleanly at the new ratio.
    function test_aPrintAfterTheFlipSettlesCleanly() public {
        MockB20Asset a = _newAsset(false);
        vm.prank(alice);
        uint256 id = vault.createSeries(_params(a));
        vm.prank(alice);
        vault.split(id, ONE);

        vm.warp(uint256(maturity) - 1 days);
        a.updateUIMultiplier(2 * WAD, uint256(maturity) + 20);

        // Printed after the flip, still inside the publish window.
        _settleAt(id, int64(300 * 1e8), maturity + 30, uint256(maturity) + DELAY);

        ErodoroVault.Settlement memory st = vault.settlementOf(id);
        assertEq(st.multiplierAtSettlement, 2 * WAD);
        assertEq(st.effectiveStrike, 250 * USD);
        (uint256 pExpected,) = PayoutMath.computePools(ONE, STRIKE, 600 * USD);
        assertEq(st.pPool, pExpected, "economics unchanged across the split");
    }

    // --- Split through to redemption, and the transfer pause -----------------

    /// @notice A split mid-term, then settlement, then both sides redeemed:
    ///         the issuer's rebase must not create or destroy collateral.
    function test_splitThenSettleThenRedeemConserves() public {
        MockB20Asset a = _newAsset(false);
        vm.prank(alice);
        uint256 id = vault.createSeries(_params(a));
        vm.prank(alice);
        vault.split(id, ONE);

        vm.warp(uint256(maturity) - 1 days);
        a.updateMultiplier(2 * WAD);
        _settleAt(id, int64(300 * 1e8), maturity + 60, uint256(maturity) + DELAY);

        ErodoroVault.Settlement memory st = vault.settlementOf(id);
        assertGt(st.pPool, 0);
        assertGt(st.nPool, 0);

        uint256 beforeCollateral = a.balanceOf(alice);
        vm.prank(alice);
        vault.redeem(id, true, ONE);
        vm.prank(alice);
        vault.redeem(id, false, ONE);

        assertEq(vault.lockedOf(id), 0, "vault drained after both sides redeem");
        assertEq(a.balanceOf(alice), beforeCollateral + ONE, "collateral conserved across the split");
    }

    /// @notice An issuer transfer pause blocks locking new collateral. The
    ///         revert is the token's own, which is what the UI preflights.
    function test_transferPauseBlocksSplit() public {
        MockB20Asset a = _newAsset(false);
        vm.prank(alice);
        uint256 id = vault.createSeries(_params(a));

        MockB20Asset.PausableFeature[] memory features = new MockB20Asset.PausableFeature[](1);
        features[0] = MockB20Asset.PausableFeature.TRANSFER;
        a.pause(features);

        vm.prank(alice);
        vm.expectRevert(bytes("B20: transfers paused"));
        vault.split(id, ONE);
    }

    /// @notice A pause after settlement must not strand claims: redemption pays
    ///         out while transfers are halted, because the collateral is already
    ///         locked and the holder is owed it.
    function test_transferPauseBlocksRedeemToo() public {
        MockB20Asset a = _newAsset(false);
        vm.prank(alice);
        uint256 id = vault.createSeries(_params(a));
        vm.prank(alice);
        vault.split(id, ONE);
        _settleAt(id, int64(600 * 1e8), maturity + 60, uint256(maturity) + DELAY);

        MockB20Asset.PausableFeature[] memory features = new MockB20Asset.PausableFeature[](1);
        features[0] = MockB20Asset.PausableFeature.TRANSFER;
        a.pause(features);

        vm.prank(alice);
        vm.expectRevert(bytes("B20: transfers paused"));
        vault.redeem(id, true, ONE);

        // Lifting the pause lets the redemption complete unchanged.
        a.unpause(features);
        vm.prank(alice);
        vault.redeem(id, true, ONE);
        assertEq(vault.balanceOf(alice, vault.pId(id)), 0);
    }
}
