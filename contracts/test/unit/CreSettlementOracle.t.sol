// SPDX-License-Identifier: Apache-2.0
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {CreReceiver} from "../../src/cre/CreReceiver.sol";
import {CreSettlementOracle} from "../../src/oracle/CreSettlementOracle.sol";
import {ErodoroVault} from "../../src/ErodoroVault.sol";
import {Factory} from "../../src/Factory.sol";
import {Errors} from "../../src/libraries/Errors.sol";
import {SettlementModel} from "../../src/oracle/SettlementModel.sol";
import {MockB20Asset} from "../harness/MockB20Asset.sol";

contract CreSettlementOracleTest is Test {
    bytes32 constant AAPL = keccak256("RIPS-REF-test-AAPL");
    address constant FORWARDER = address(0xF0);
    address constant SIM_SENDER = address(0x5E);

    CreSettlementOracle oracle;

    function setUp() public {
        vm.warp(1_800_000_000);
        oracle = new CreSettlementOracle(address(this), FORWARDER, SIM_SENDER);
    }

    function _report(bytes32 feedId, uint256 price, uint64 feedUpdatedAt) internal {
        bytes32[] memory ids = new bytes32[](1);
        uint256[] memory prices = new uint256[](1);
        uint64[] memory times = new uint64[](1);
        (ids[0], prices[0], times[0]) = (feedId, price, feedUpdatedAt);
        vm.prank(FORWARDER, SIM_SENDER);
        oracle.onReport("", abi.encode(ids, prices, times));
    }

    function test_onlyForwarderReports() public {
        vm.expectRevert(abi.encodeWithSelector(CreReceiver.NotForwarder.selector, address(this)));
        oracle.onReport("", "");
    }

    function test_mockForwarderOnlyRelaysThePinnedSimulator() public {
        address someone = address(0xBAD);
        vm.prank(FORWARDER, someone);
        vm.expectRevert(abi.encodeWithSelector(CreReceiver.NotSimulationSender.selector, someone));
        oracle.onReport("", abi.encode(new bytes32[](0), new uint256[](0), new uint64[](0)));
    }

    function test_skipsZeroFutureAndOutOfOrderPrints() public {
        _report(AAPL, 250e8, uint64(block.timestamp - 60));
        _report(AAPL, 0, uint64(block.timestamp));
        _report(AAPL, 251e8, uint64(block.timestamp + 1));
        _report(AAPL, 249e8, uint64(block.timestamp - 120));
        assertEq(oracle.observationCount(AAPL), 1);
        assertEq(oracle.latest(AAPL).price, 250e8);
    }

    function test_settlementPriceIsFirstObservationAtOrAfterMaturity() public {
        uint64 maturity = uint64(block.timestamp + 5 minutes);
        _report(AAPL, 250e8, uint64(block.timestamp));
        vm.warp(block.timestamp + 10 minutes);
        _report(AAPL, 252e8, uint64(block.timestamp - 30));
        vm.warp(block.timestamp + 10 minutes);
        _report(AAPL, 255e8, uint64(block.timestamp));

        (uint256 price, uint8 decimals, uint64 publishTime) =
            oracle.settlementPrice(AAPL, maturity, maturity + 1 hours, 0, new bytes[](0));
        assertEq(price, 252e8);
        assertEq(decimals, 8);
        assertEq(publishTime, maturity + 5 minutes);
    }

    function test_noObservationInWindowReverts() public {
        _report(AAPL, 250e8, uint64(block.timestamp));
        uint64 maturity = uint64(block.timestamp + 1);
        vm.expectRevert(Errors.OraclePriceStale.selector);
        oracle.settlementPrice(AAPL, maturity, maturity + 1 hours, 0, new bytes[](0));

        vm.warp(maturity + 2 hours);
        _report(AAPL, 251e8, uint64(block.timestamp));
        vm.expectRevert(Errors.OraclePriceStale.selector);
        oracle.settlementPrice(AAPL, maturity, maturity + 1 hours, 0, new bytes[](0));
    }

    function test_stoppedFeedCannotSettle() public {
        uint64 maturity = uint64(block.timestamp);
        _report(AAPL, 250e8, uint64(block.timestamp - 5 days));
        vm.expectRevert(Errors.OraclePriceStale.selector);
        oracle.settlementPrice(AAPL, maturity, maturity + 1 hours, 0, new bytes[](0));
    }

    /// A Rips series priced by CRE settles in the real vault, and the upside holder redeems.
    function test_settlesARipsSeriesEndToEnd() public {
        ErodoroVault vault = new ErodoroVault();
        Factory factory = new Factory(vault, address(this), Factory.Bounds({
            minHorizon: 1 hours, maxHorizon: 365 days, minSettlementDelay: 60,
            maxSettlementDelay: 1 days, minPriceLag: 1, maxPriceLag: 25 hours,
            maxConfBps: 500, maxFeeBps: 100, priceDecimals: 8
        }));
        MockB20Asset stock = new MockB20Asset("Apple", "tAAPL", 8, false);
        factory.setSettlementConfiguration(Factory.SettlementConfigurationParams({
            collateral: address(stock), oracle: address(oracle), fallbackOracle: address(0),
            feedId: AAPL, settlementModel: SettlementModel.TOTAL_RETURN, fallbackDelay: 0, priceDecimals: 8
        }));
        uint64 maturity = uint64(block.timestamp + 2 hours);
        uint256 seriesId = factory.createSeries(ErodoroVault.CreateSeriesParams({
            collateral: address(stock), oracle: address(oracle), fallbackOracle: address(0),
            feeRecipient: address(this), feedId: AAPL, fallbackRequestId: bytes32(0),
            settlementModel: SettlementModel.TOTAL_RETURN, strike: 105e8, minSplitAmount: 0,
            maturity: maturity, settlementDelay: 60, maxPriceLag: 1 hours, fallbackDelay: 0,
            maxConfBps: 0, feeBps: 0, priceDecimals: 8, admin: address(this)
        }), address(this));
        stock.mint(address(this), 1e8);
        stock.approve(address(vault), type(uint256).max);
        vault.split(seriesId, 1e8);

        vm.warp(maturity + 60);
        _report(AAPL, 120e8, uint64(block.timestamp - 5 minutes));
        vault.settle(seriesId, new bytes[](0));
        assertEq(vault.redeem(seriesId, false, 1e8), 12_500_000);
    }
}
