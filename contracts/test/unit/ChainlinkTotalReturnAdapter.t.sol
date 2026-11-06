// SPDX-License-Identifier: Apache-2.0
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";

import {ChainlinkTotalReturnAdapter} from "../../src/oracle/ChainlinkTotalReturnAdapter.sol";
import {CoinbaseFeedStatus} from "../../src/oracle/CoinbaseFeedStatus.sol";
import {SettlementModel} from "../../src/oracle/SettlementModel.sol";
import {Errors} from "../../src/libraries/Errors.sol";
import {MockAggregatorV3} from "../harness/MockAggregatorV3.sol";
import {MockCoinbaseOracleRegistry} from "../harness/MockCoinbaseOracleRegistry.sol";
import {MockFeedStatus} from "../harness/MockFeedStatus.sol";

contract ChainlinkTotalReturnAdapterTest is Test {
    bytes32 constant FEED_ID = keccak256("Coinbase AAPL total return");
    uint64 constant MATURITY = 1_700_000_000;
    address constant AAPLC = address(0xA4A1);

    MockAggregatorV3 feed;
    MockFeedStatus status;
    ChainlinkTotalReturnAdapter adapter;

    function setUp() public {
        feed = new MockAggregatorV3(8);
        status = new MockFeedStatus();
        adapter = new ChainlinkTotalReturnAdapter(feed, status, FEED_ID);
        status.setOperational(FEED_ID, true);
        feed.setRound(10, 599e8, MATURITY - 1, 10);
        feed.setRound(11, 600e8, MATURITY + 10, 11);
        feed.setRound(12, 900e8, MATURITY + 30, 12);
    }

    function _data(uint80 roundId) internal pure returns (bytes[] memory data) {
        data = new bytes[](1);
        data[0] = abi.encode(roundId);
    }

    function test_reportsTotalReturnModel() public view {
        assertEq(uint8(adapter.settlementModel()), uint8(SettlementModel.TOTAL_RETURN));
    }

    function test_acceptsTheFirstRoundAfterMaturity() public {
        (uint256 price, uint8 decimals, uint64 publishTime) =
            adapter.settlementPrice(FEED_ID, MATURITY, MATURITY + 60, 0, _data(11));
        assertEq(price, 600e8);
        assertEq(decimals, 8);
        assertEq(publishTime, MATURITY + 10);
    }

    /// @notice The caller selects a round; the adapter proves it is the first
    ///         one after maturity by checking the round before it printed
    ///         strictly before the window opened. The returned `updatedAt` is
    ///         what the vault stores as the price timestamp.
    function test_theSelectedRoundMustBeTheFirstAfterMaturity() public {
        // Round 10 printed before maturity; round 11 is the first inside the
        // window. Selecting 11 returns its own `updatedAt` as the window stamp.
        (,, uint64 publishTime) = adapter.settlementPrice(FEED_ID, MATURITY, MATURITY + 60, 0, _data(11));
        assertEq(publishTime, MATURITY + 10, "updatedAt becomes the price timestamp");

        // A round whose predecessor already printed after maturity is not the
        // first, and is refused.
        feed.setRound(11, 600e8, MATURITY + 5, 11);
        feed.setRound(12, 610e8, MATURITY + 10, 12);
        vm.expectRevert(Errors.OraclePriceInvalid.selector);
        adapter.settlementPrice(FEED_ID, MATURITY, MATURITY + 60, 0, _data(12));
    }

    /// @notice A first round of a new Chainlink phase cannot prove its
    ///         predecessor, so it is refused rather than guessed at.
    function test_firstRoundOfAPhaseIsRefused() public {
        vm.expectRevert(Errors.OraclePriceInvalid.selector);
        adapter.settlementPrice(FEED_ID, MATURITY, MATURITY + 60, 0, _data(1));
    }

    function test_rejectsALaterSelectableRound() public {
        vm.expectRevert(Errors.OraclePriceInvalid.selector);
        adapter.settlementPrice(FEED_ID, MATURITY, MATURITY + 60, 0, _data(12));
    }

    function test_rejectsFrozenFeed() public {
        status.setOperational(FEED_ID, false);
        vm.expectRevert(Errors.MarketClosed.selector);
        adapter.settlementPrice(FEED_ID, MATURITY, MATURITY + 60, 0, _data(11));
    }

    function test_resumesOnlyAfterCoinbasePublishesSynchronizedCorporateActionState() public {
        MockAggregatorV3 corporateActionFeed = new MockAggregatorV3(8);
        MockCoinbaseOracleRegistry registry = new MockCoinbaseOracleRegistry();
        CoinbaseFeedStatus coinbaseStatus = new CoinbaseFeedStatus(registry, AAPLC, FEED_ID);
        ChainlinkTotalReturnAdapter corporateActionAdapter =
            new ChainlinkTotalReturnAdapter(corporateActionFeed, coinbaseStatus, FEED_ID);

        corporateActionFeed.setRound(20, 300e8, MATURITY - 1, 20);
        corporateActionFeed.setRound(21, 600e8, MATURITY + 10, 21);

        // Coinbase has published the post-action 2x multiplier and matching
        // total-return round, but keeps the oracle paused during synchronization.
        registry.setParams(AAPLC, 2e18, true);
        vm.expectRevert(Errors.OraclePausedForCorporateAction.selector);
        corporateActionAdapter.settlementPrice(FEED_ID, MATURITY, MATURITY + 60, 0, _data(21));

        // Unpause is the authenticated signal that the multiplier and feed now
        // describe the same corporate-action state.
        registry.setParams(AAPLC, 2e18, false);
        (uint256 price,, uint64 publishTime) =
            corporateActionAdapter.settlementPrice(FEED_ID, MATURITY, MATURITY + 60, 0, _data(21));
        assertEq(price, 600e8);
        assertEq(publishTime, MATURITY + 10);
    }

    /// @notice The adapter exposes the registry's pause flag so a UI can say
    ///         "oracle paused for corporate action" instead of a generic failure.
    function test_oracleParamsSurfacesThePauseFlag() public {
        MockCoinbaseOracleRegistry registry = new MockCoinbaseOracleRegistry();
        CoinbaseFeedStatus coinbaseStatus = new CoinbaseFeedStatus(registry, AAPLC, FEED_ID);
        ChainlinkTotalReturnAdapter corporateActionAdapter =
            new ChainlinkTotalReturnAdapter(feed, coinbaseStatus, FEED_ID);

        registry.setParams(AAPLC, 2e18, true);
        (uint256 multiplier, bool paused) = corporateActionAdapter.oracleParams();
        assertEq(multiplier, 2e18);
        assertTrue(paused);

        registry.setParams(AAPLC, 2e18, false);
        (, paused) = corporateActionAdapter.oracleParams();
        assertFalse(paused);
    }

    /// @notice A status that does not expose `oracleParams()` falls back to the
    ///         generic closed-market error rather than guessing a cause.
    function test_plainStatusFallsBackToMarketClosed() public {
        status.setOperational(FEED_ID, false);
        (uint256 multiplier, bool paused) = adapter.oracleParams();
        assertEq(multiplier, 0);
        assertFalse(paused);
        vm.expectRevert(Errors.MarketClosed.selector);
        adapter.settlementPrice(FEED_ID, MATURITY, MATURITY + 60, 0, _data(11));
    }

    function test_rejectsStaleRound() public {
        feed.setRound(11, 600e8, MATURITY + 61, 11);
        vm.expectRevert(Errors.OraclePriceStale.selector);
        adapter.settlementPrice(FEED_ID, MATURITY, MATURITY + 60, 0, _data(11));
    }

    function test_rejectsPythConfidenceRule() public {
        vm.expectRevert(Errors.InvalidParams.selector);
        adapter.settlementPrice(FEED_ID, MATURITY, MATURITY + 60, 1, _data(11));
    }
}
