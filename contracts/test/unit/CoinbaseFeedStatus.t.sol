// SPDX-License-Identifier: Apache-2.0
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";

import {CoinbaseFeedStatus} from "../../src/oracle/CoinbaseFeedStatus.sol";
import {MockCoinbaseOracleRegistry} from "../harness/MockCoinbaseOracleRegistry.sol";

contract CoinbaseFeedStatusTest is Test {
    bytes32 constant FEED_ID = keccak256("Coinbase AAPL total return");
    address constant TOKEN = address(0xA4A1);

    MockCoinbaseOracleRegistry registry;
    CoinbaseFeedStatus status;

    function setUp() public {
        registry = new MockCoinbaseOracleRegistry();
        status = new CoinbaseFeedStatus(registry, TOKEN, FEED_ID);
        registry.setParams(TOKEN, 1e18, false);
    }

    function test_reportsAnUnpausedConfiguredFeedAsOperational() public view {
        assertTrue(status.isOperational(FEED_ID));
        (uint256 multiplier, bool paused) = status.oracleParams();
        assertEq(multiplier, 1e18);
        assertFalse(paused);
    }

    function test_failsClosedForWrongFeed() public view {
        assertFalse(status.isOperational(keccak256("another feed")));
    }

    function test_failsClosedWhenPaused() public {
        registry.setParams(TOKEN, 1e18, true);
        assertFalse(status.isOperational(FEED_ID));
    }

    function test_failsClosedForZeroMultiplier() public {
        registry.setParams(TOKEN, 0, false);
        assertFalse(status.isOperational(FEED_ID));
    }

    function test_failsClosedWhenRegistryReverts() public {
        registry.setShouldRevert(true);
        assertFalse(status.isOperational(FEED_ID));
    }
}
