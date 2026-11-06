// SPDX-License-Identifier: Apache-2.0
pragma solidity 0.8.28;

import {Script} from "forge-std/Script.sol";
import {console2} from "forge-std/console2.sol";

import {CoinbaseFeedStatus} from "../src/oracle/CoinbaseFeedStatus.sol";
import {ICoinbaseOracleRegistry} from "../src/oracle/ICoinbaseOracleRegistry.sol";

/// @notice Deploys one immutable Coinbase token-to-feed status binding.
contract DeployCoinbaseFeedStatus is Script {
    function run() external returns (CoinbaseFeedStatus status) {
        require(block.chainid == 8453, "Base mainnet only");
        uint256 pk = vm.envUint("PRIVATE_KEY");
        address registry = vm.envAddress("COINBASE_ORACLE_REGISTRY");
        address token = vm.envAddress("B20_TOKEN");
        bytes32 feedId = vm.envBytes32("CHAINLINK_FEED_ID");

        require(registry.code.length > 0, "COINBASE_ORACLE_REGISTRY has no code");
        require(token.code.length > 0, "B20_TOKEN has no code");

        vm.startBroadcast(pk);
        status = new CoinbaseFeedStatus(ICoinbaseOracleRegistry(registry), token, feedId);
        vm.stopBroadcast();

        console2.log("CoinbaseFeedStatus", address(status));
    }
}
