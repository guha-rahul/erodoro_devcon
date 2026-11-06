// SPDX-License-Identifier: Apache-2.0
pragma solidity 0.8.28;

import {Script} from "forge-std/Script.sol";
import {console2} from "forge-std/console2.sol";

import {ChainlinkTotalReturnAdapter} from "../src/oracle/ChainlinkTotalReturnAdapter.sol";
import {CoinbaseFeedStatus} from "../src/oracle/CoinbaseFeedStatus.sol";
import {SettlementModel} from "../src/oracle/SettlementModel.sol";
import {IAggregatorV3} from "../src/oracle/IAggregatorV3.sol";

/// @title CheckChainlinkBinding
/// @notice Release gate for a Coinbase total-return stock feed.
///
/// @dev A total-return price already includes the B20 multiplier. If it is ever
///      routed through the raw-share strike adjustment, the same corporate
///      action is counted twice and the pools move for no economic reason. The
///      vault refuses a model mismatch at settlement, but that is a runtime
///      guard against a misconfiguration that should never ship. This script is
///      the deploy-time assertion: it reverts unless the adapter declares
///      `TOTAL_RETURN`, its feed and feed id match the intended binding, and its
///      status provider is bound to the same token and feed.
///
///      Run it in CI before a deployment is considered canonical.
contract CheckChainlinkBinding is Script {
    function run() external view {
        address adapterAddr = vm.envAddress("CHAINLINK_ADAPTER");
        address expectedFeed = vm.envAddress("CHAINLINK_FEED");
        bytes32 expectedFeedId = vm.envBytes32("CHAINLINK_FEED_ID");
        address expectedToken = vm.envAddress("CHAINLINK_TOKEN");

        console2.log("=== chainlink total-return binding gate ===");
        console2.log("adapter:", adapterAddr);
        console2.log("feed:   ", expectedFeed);
        console2.log("token:  ", expectedToken);

        ChainlinkTotalReturnAdapter adapter = ChainlinkTotalReturnAdapter(adapterAddr);

        require(adapter.settlementModel() == SettlementModel.TOTAL_RETURN, "adapter is not TOTAL_RETURN");
        console2.log("  ok    settlement model is TOTAL_RETURN");

        require(address(adapter.feed()) == expectedFeed, "adapter feed does not match");
        console2.log("  ok    feed matches");

        require(adapter.configuredFeedId() == expectedFeedId, "adapter feed id does not match");
        console2.log("  ok    feed id matches");

        require(address(adapter.status()) != address(0), "adapter has no status provider");
        CoinbaseFeedStatus status = CoinbaseFeedStatus(address(adapter.status()));
        require(status.token() == expectedToken, "status token does not match");
        require(status.configuredFeedId() == expectedFeedId, "status feed id does not match");
        console2.log("  ok    status provider bound to the same token and feed");

        uint8 decimals = IAggregatorV3(expectedFeed).decimals();
        console2.log("  feed decimals:", decimals);

        (uint256 multiplier, bool paused) = adapter.oracleParams();
        console2.log("  multiplier:", multiplier);
        console2.log("  paused:    ", paused);
        require(multiplier > 0, "registry reports a zero multiplier - the feed cannot settle");

        console2.log("BINDING OK - safe to treat this adapter as the canonical total-return feed.");
    }
}
