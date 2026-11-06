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
import {MockOracleAdapter} from "../harness/MockOracleAdapter.sol";
import {MockMutableOracleAdapter} from "../harness/MockMutableOracleAdapter.sol";
import {MockFallbackSettlementOracle} from "../harness/MockFallbackSettlementOracle.sol";

/// @notice Full-lifecycle tests on base-std-shaped mocks. No RPC, no precompiles.
/// @dev These prove the math and the state machine. They do NOT prove anything
///      about the real issuer's roles, policies or decimals — that is what the
///      fork suite is for, and it is the gate that actually means something.
contract ErodoroVaultTest is Test {
    MockB20Asset collateral;
    MockPythUnique pyth;
    PythAdapter adapter;
    ErodoroVault vault;

    address alice = address(0xA11CE);
    address bob = address(0xB0B);
    address feeSink = address(0xFEE);

    bytes32 constant FEED = bytes32("AAPLc/USD");
    uint8 constant PRICE_DECIMALS = 8;
    uint256 constant USD = 1e8;
    uint256 constant STRIKE = 500 * USD;
    uint256 constant ONE = 1e18; // collateral is 18-decimal, per the B20 spec's advice
    uint64 constant DELAY = 300;
    uint64 constant MAX_LAG = 60;

    uint64 maturity;

    function setUp() public {
        vm.warp(1_700_000_000);
        collateral = new MockB20Asset("Apple Tokenized Stock", "AAPLc", 18, false);
        pyth = new MockPythUnique(60, 1);
        adapter = new PythAdapter(IPythUnique(address(pyth)));
        vault = new ErodoroVault();

        maturity = uint64(block.timestamp + 30 days);

        collateral.mint(alice, 100 * ONE);
        collateral.mint(bob, 100 * ONE);
        vm.prank(alice);
        collateral.approve(address(vault), type(uint256).max);
        vm.prank(bob);
        collateral.approve(address(vault), type(uint256).max);
    }

    // --- helpers -------------------------------------------------------------

    function _params() internal view returns (ErodoroVault.CreateSeriesParams memory) {
        return ErodoroVault.CreateSeriesParams({
            collateral: address(collateral),
            oracle: address(adapter),
            fallbackOracle: address(0),
            feeRecipient: feeSink,
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

    function _create(address creator) internal returns (uint256 id) {
        vm.prank(creator);
        id = vault.createSeries(_params());
    }

    function _update(int64 price, uint64 ts) internal view returns (bytes[] memory data) {
        data = new bytes[](1);
        data[0] = pyth.createPriceFeedUpdateData(
            FEED, price, uint64(uint64(price) / 1000), -int32(int256(uint256(PRICE_DECIMALS))), price, 0, ts
        );
    }

    function _settle(uint256 id, int64 price) internal {
        vm.warp(uint256(maturity) + DELAY);
        bytes[] memory data = _update(price, maturity + 60);
        uint256 fee = pyth.getUpdateFee(data);
        vm.deal(bob, fee);
        vm.prank(bob); // settlement is permissionless
        vault.settle{value: fee}(id, data);
    }

    // --- The payoff ----------------------------------------------------------

    /// @notice The README table, driven through the real contract rather than
    ///         through the math library.
    function test_readmeTableThroughTheVault() public {
        int64[4] memory prices = [int64(250 * 1e8), int64(400 * 1e8), int64(600 * 1e8), int64(1000 * 1e8)];

        for (uint256 i = 0; i < prices.length; i++) {
            // A fresh series per row: settlement is once-only.
            maturity = uint64(block.timestamp + 30 days);
            uint256 id = _create(alice);

            vm.prank(alice);
            vault.split(id, ONE);
            assertEq(vault.balanceOf(alice, vault.pId(id)), ONE);
            assertEq(vault.balanceOf(alice, vault.nId(id)), ONE);

            _settle(id, prices[i]);

            ErodoroVault.Settlement memory st = vault.settlementOf(id);
            (uint256 expectedP, uint256 expectedN) = PayoutMath.computePools(ONE, STRIKE, uint256(uint64(prices[i])));
            assertEq(st.pPool, expectedP, "P pool");
            assertEq(st.nPool, expectedN, "N pool");
            assertEq(st.pPool + st.nPool, ONE, "pools must partition collateral");

            uint256 beforeBal = collateral.balanceOf(alice);
            vm.startPrank(alice);
            uint256 paidP = vault.redeem(id, true, ONE);
            uint256 paidN = vault.redeem(id, false, ONE);
            vm.stopPrank();

            assertEq(paidP, expectedP, "P payout");
            assertEq(paidN, expectedN, "N payout");
            assertEq(collateral.balanceOf(alice) - beforeBal, ONE, "collateral conserved");

            // Below strike, N is worthless. That is the product, not a bug.
            if (uint256(uint64(prices[i])) <= STRIKE) assertEq(paidN, 0, "N expires worthless below strike");
        }
    }

    function test_splitAndMergeRoundTrip() public {
        uint256 id = _create(alice);
        vm.startPrank(alice);
        vault.split(id, 2 * ONE);
        vault.merge(id, 2 * ONE);
        vm.stopPrank();
        assertEq(collateral.balanceOf(alice), 100 * ONE);
        assertEq(vault.balanceOf(alice, vault.pId(id)), 0);
        assertEq(vault.lockedOf(id), 0);
    }

    // --- Admin surface -------------------------------------------------------

    /// @notice A pause must never trap collateral behind existing claims.
    function test_mergeWorksWhileSplitsArePaused() public {
        uint256 id = _create(alice);
        vm.prank(alice);
        vault.split(id, ONE);

        vm.prank(alice);
        vault.pauseSplits(id);

        vm.prank(alice);
        vm.expectRevert(Errors.SeriesPaused.selector);
        vault.split(id, ONE);

        // ...but merge still works.
        vm.prank(alice);
        vault.merge(id, ONE);
        assertEq(vault.lockedOf(id), 0);
    }

    function test_renounceAdminIsPermanent() public {
        uint256 id = _create(alice);
        vm.prank(alice);
        vault.renounceAdmin(id);

        vm.prank(alice);
        vm.expectRevert(Errors.Unauthorized.selector);
        vault.pauseSplits(id);
    }

    function test_nonAdminCannotPause() public {
        uint256 id = _create(alice);
        vm.prank(bob);
        vm.expectRevert(Errors.Unauthorized.selector);
        vault.pauseSplits(id);
    }

    function test_sweepDustRequiresBothSuppliesZero() public {
        uint256 id = _create(alice);
        vm.prank(alice);
        vault.split(id, ONE);

        vm.prank(alice);
        vm.expectRevert(Errors.DustSweepTooEarly.selector);
        vault.sweepDust(id);
    }

    // --- Identity ------------------------------------------------------------

    /// @notice Finding #2: the creator is in the id preimage, so one creator
    ///         cannot occupy the address another would have used.
    function test_seriesIdIsScopedToTheCreator() public {
        uint256 aliceId = _create(alice);
        uint256 bobId = _create(bob);
        assertTrue(aliceId != bobId, "same params must not collide across creators");

        vm.prank(alice);
        vm.expectRevert(Errors.SeriesExists.selector);
        vault.createSeries(_params());
    }

    function test_claimIdsAreDerivableAndDistinct() public {
        uint256 id = _create(alice);
        assertEq(vault.pId(id), id);
        assertEq(vault.nId(id), id | 1);
        assertTrue(vault.pId(id) != vault.nId(id));
        assertEq(id & 1, 0, "seriesId must have its low bit clear");
    }

    // --- Settlement ----------------------------------------------------------

    function test_settleIsOnceOnly() public {
        uint256 id = _create(alice);
        vm.prank(alice);
        vault.split(id, ONE);
        _settle(id, int64(600 * 1e8));

        bytes[] memory data = _update(int64(600 * 1e8), maturity + 60);
        uint256 fee = pyth.getUpdateFee(data);
        vm.deal(bob, fee);
        vm.prank(bob);
        vm.expectRevert(Errors.AlreadySettled.selector);
        vault.settle{value: fee}(id, data);
    }

    function test_settleRejectsBeforeTheDelayElapses() public {
        uint256 id = _create(alice);
        vm.prank(alice);
        vault.split(id, ONE);

        vm.warp(uint256(maturity) + DELAY - 1);
        bytes[] memory data = _update(int64(600 * 1e8), maturity + 60);
        uint256 fee = pyth.getUpdateFee(data);
        vm.deal(bob, fee);
        vm.prank(bob);
        vm.expectRevert(Errors.SettlementTooEarly.selector);
        vault.settle{value: fee}(id, data);
    }

    /// @notice A settlement caller cannot select a later, more favorable print.
    function test_settleUsesTheFirstPrintAfterMaturity() public {
        uint256 id = _create(alice);
        vm.prank(alice);
        vault.split(id, ONE);

        vm.warp(uint256(maturity) + DELAY);
        bytes[] memory data = new bytes[](2);
        data[0] = _update(int64(900 * 1e8), maturity + 50)[0];
        data[1] = _update(int64(600 * 1e8), maturity + 10)[0];

        uint256 fee = pyth.getUpdateFee(data);
        vm.deal(bob, fee);
        vm.prank(bob);
        vault.settle{value: fee}(id, data);

        ErodoroVault.Settlement memory st = vault.settlementOf(id);
        assertEq(st.price, 600 * USD);
        assertEq(st.priceTs, maturity + 10);
    }

    function test_createRejectsAnAdapterWithTheWrongSettlementModel() public {
        MockOracleAdapter totalReturn = new MockOracleAdapter(SettlementModel.TOTAL_RETURN);
        ErodoroVault.CreateSeriesParams memory p = _params();
        p.oracle = address(totalReturn);

        vm.prank(alice);
        vm.expectRevert(Errors.OraclePairInvalid.selector);
        vault.createSeries(p);
    }

    function test_totalReturnSettlementDoesNotAdjustTheStrike() public {
        MockOracleAdapter totalReturn = new MockOracleAdapter(SettlementModel.TOTAL_RETURN);
        ErodoroVault.CreateSeriesParams memory p = _params();
        p.oracle = address(totalReturn);
        p.settlementModel = SettlementModel.TOTAL_RETURN;

        vm.prank(alice);
        uint256 id = vault.createSeries(p);
        vm.prank(alice);
        vault.split(id, ONE);

        collateral.updateMultiplier(2e18);
        totalReturn.setPrice(600 * USD, PRICE_DECIMALS, maturity + 10);
        vm.warp(uint256(maturity) + DELAY);
        vm.prank(bob);
        vault.settle(id, new bytes[](0));

        ErodoroVault.Settlement memory st = vault.settlementOf(id);
        assertEq(st.effectiveStrike, STRIKE);
        assertEq(st.multiplierAtSettlement, 2e18);
        (uint256 expectedP, uint256 expectedN) = PayoutMath.computePools(ONE, STRIKE, 600 * USD);
        assertEq(st.pPool, expectedP);
        assertEq(st.nPool, expectedN);
    }

    /// @notice The two explicit oracle modes exist so a corporate action is
    ///         counted once. A total-return price keeps the stored strike; a raw
    ///         price scales it. Same print, same split, different pools.
    function test_theTwoModesApplyTheMultiplierExactlyOnce() public {
        // Raw mode: multiplier 2 moves the strike to 250, price 300 -> pools at
        // the pre-split equivalence of a $600 print against the $500 strike.
        (uint256 rawP, uint256 rawN) = PayoutMath.computePools(ONE, 250 * USD, 300 * USD);
        (uint256 beforeP, uint256 beforeN) = PayoutMath.computePools(ONE, STRIKE, 600 * USD);
        assertEq(rawP, beforeP, "raw mode: adjusted strike preserves P");
        assertEq(rawN, beforeN, "raw mode: adjusted strike preserves N");

        // Total-return mode: the price already includes the multiplier, so the
        // stored strike is kept and the same $600 print preserves the pools.
        (uint256 totalP, uint256 totalN) = PayoutMath.computePools(ONE, STRIKE, 600 * USD);
        assertEq(totalP, beforeP, "total-return mode keeps the stored strike");
        assertEq(totalN, beforeN, "total-return mode keeps the stored strike");

        // Applying the adjusted strike to the total-return price double-counts.
        (uint256 doubleP, uint256 doubleN) = PayoutMath.computePools(ONE, 250 * USD, 600 * USD);
        assertTrue(doubleP != beforeP || doubleN != beforeN, "double adjustment must differ");
    }

    /// @notice If an oracle's declared model ever disagrees with the series, the
    ///         vault refuses to settle rather than pick an adjustment path.
    function test_settleRejectsAModelMismatch() public {
        MockMutableOracleAdapter mutableOracle = new MockMutableOracleAdapter(SettlementModel.RAW_SHARE);
        ErodoroVault.CreateSeriesParams memory p = _params();
        p.oracle = address(mutableOracle);

        vm.prank(alice);
        uint256 id = vault.createSeries(p);
        vm.prank(alice);
        vault.split(id, ONE);

        mutableOracle.setPrice(600 * USD, PRICE_DECIMALS, maturity + 10);
        mutableOracle.setSettlementModel(SettlementModel.TOTAL_RETURN);

        vm.warp(uint256(maturity) + DELAY);
        vm.prank(bob);
        vm.expectRevert(Errors.OraclePairInvalid.selector);
        vault.settle(id, new bytes[](0));
    }

    function test_frozenAdapterCannotSettle() public {        MockOracleAdapter totalReturn = new MockOracleAdapter(SettlementModel.TOTAL_RETURN);
        ErodoroVault.CreateSeriesParams memory p = _params();
        p.oracle = address(totalReturn);
        p.settlementModel = SettlementModel.TOTAL_RETURN;

        vm.prank(alice);
        uint256 id = vault.createSeries(p);
        vm.prank(alice);
        vault.split(id, ONE);

        totalReturn.setPrice(600 * USD, PRICE_DECIMALS, maturity + 10);
        totalReturn.setFrozen(true);
        vm.warp(uint256(maturity) + DELAY);
        vm.prank(bob);
        vm.expectRevert(Errors.MarketClosed.selector);
        vault.settle(id, new bytes[](0));
    }

    function test_fallbackCannotSettleBeforeItsDelay() public {
        MockFallbackSettlementOracle fallbackOracle = new MockFallbackSettlementOracle(SettlementModel.RAW_SHARE, FEED);
        ErodoroVault.CreateSeriesParams memory p = _params();
        p.fallbackOracle = address(fallbackOracle);
        p.fallbackRequestId = keccak256("AAPL expiry fallback");
        p.fallbackDelay = 1 days;

        vm.prank(alice);
        uint256 id = vault.createSeries(p);
        fallbackOracle.setResult(600 * USD, PRICE_DECIMALS, maturity, true);

        vm.warp(uint256(maturity) + DELAY + 1 days - 1);
        vm.expectRevert(Errors.SettlementTooEarly.selector);
        vault.settleFallback(id, "");
    }

    function test_fallbackRequiresAFinalResult() public {
        MockFallbackSettlementOracle fallbackOracle = new MockFallbackSettlementOracle(SettlementModel.RAW_SHARE, FEED);
        ErodoroVault.CreateSeriesParams memory p = _params();
        p.fallbackOracle = address(fallbackOracle);
        p.fallbackRequestId = keccak256("AAPL expiry fallback");
        p.fallbackDelay = 1 days;

        vm.prank(alice);
        uint256 id = vault.createSeries(p);
        fallbackOracle.setResult(600 * USD, PRICE_DECIMALS, maturity, false);

        vm.warp(uint256(maturity) + DELAY + 1 days);
        vm.expectRevert(Errors.NotSettled.selector);
        vault.settleFallback(id, "");
    }

    function test_finalFallbackPriceSettlesAndUnlocksRedemption() public {
        MockFallbackSettlementOracle fallbackOracle = new MockFallbackSettlementOracle(SettlementModel.RAW_SHARE, FEED);
        ErodoroVault.CreateSeriesParams memory p = _params();
        p.fallbackOracle = address(fallbackOracle);
        p.fallbackRequestId = keccak256("AAPL expiry fallback");
        p.fallbackDelay = 1 days;

        vm.prank(alice);
        uint256 id = vault.createSeries(p);
        vm.prank(alice);
        vault.split(id, ONE);
        fallbackOracle.setResult(600 * USD, PRICE_DECIMALS, maturity, true);

        vm.warp(uint256(maturity) + DELAY + 1 days);
        vm.prank(bob);
        vault.settleFallback(id, "");

        ErodoroVault.Settlement memory st = vault.settlementOf(id);
        assertTrue(st.settled);
        assertTrue(st.fallbackUsed);
        assertEq(st.price, 600 * USD);

        vm.prank(alice);
        assertGt(vault.redeem(id, true, ONE), 0);
    }

    /// @notice §8: a print from outside the window cannot settle the series.
    ///         With maturity at a real market close, this is what stops a series
    ///         settling against a 03:00 Sunday print on a thin book.
    function test_settleRejectsAPrintOutsideTheWindow() public {
        uint256 id = _create(alice);
        vm.prank(alice);
        vault.split(id, ONE);

        vm.warp(uint256(maturity) + DELAY + MAX_LAG + 1);
        // Printed after the window closes.
        bytes[] memory data = _update(int64(600 * 1e8), maturity + MAX_LAG + 1);
        uint256 fee = pyth.getUpdateFee(data);
        vm.deal(bob, fee);
        vm.prank(bob);
        vm.expectRevert();
        vault.settle{value: fee}(id, data);
    }

    /// @notice A print before maturity is stale for this series, even when the
    ///         caller submits it after settlement opens.
    function test_settleRejectsAPrintBeforeMaturity() public {
        uint256 id = _create(alice);
        vm.prank(alice);
        vault.split(id, ONE);

        vm.warp(uint256(maturity) + DELAY);
        bytes[] memory data = _update(int64(600 * 1e8), maturity - 1);
        uint256 fee = pyth.getUpdateFee(data);
        vm.deal(bob, fee);
        vm.prank(bob);
        vm.expectRevert();
        vault.settle{value: fee}(id, data);
    }

    /// @notice A wide confidence band is what a closed market looks like on-chain.
    function test_settleRejectsAWideConfidenceBand() public {
        uint256 id = _create(alice);
        vm.prank(alice);
        vault.split(id, ONE);

        vm.warp(uint256(maturity) + DELAY);
        bytes[] memory data = new bytes[](1);
        int64 price = int64(600 * 1e8);
        // conf = 20% of price, against a 5% policy.
        data[0] = pyth.createPriceFeedUpdateData(
            FEED, price, uint64(uint64(price) / 5), -int32(int256(uint256(PRICE_DECIMALS))), price, 0, maturity + 60
        );
        uint256 fee = pyth.getUpdateFee(data);
        vm.deal(bob, fee);
        vm.prank(bob);
        vm.expectRevert(Errors.MarketClosed.selector);
        vault.settle{value: fee}(id, data);
    }

    function test_redeemBeforeSettlementReverts() public {
        uint256 id = _create(alice);
        vm.prank(alice);
        vault.split(id, ONE);
        vm.prank(alice);
        vm.expectRevert(Errors.NotSettled.selector);
        vault.redeem(id, true, ONE);
    }
}
