// SPDX-License-Identifier: Apache-2.0
pragma solidity 0.8.28;

import {Script} from "forge-std/Script.sol";
import {ErodoroIntent} from "../src/ErodoroIntent.sol";

/// @notice Deploys the permissionless intent settlement contract.
///
///     BASE_SEPOLIA_RPC_URL=... DEPLOYER_KEY=... forge script script/DeployIntent.s.sol \
///       --rpc-url $BASE_SEPOLIA_RPC_URL --broadcast
///
/// No constructor args, no admin, no owner: settlement rules are immutable.
/// After broadcast, record the address in deployments/base-sepolia.json,
/// app/lib/deployment.ts (BASE_SEPOLIA intent), wrangler.jsonc INTENT_ADDRESS
/// and .env.example. The intent contract holds no funds, so a misdeployment
/// strands nothing — but intents signed against the wrong address will not
/// verify, so update every surface together.
contract DeployIntent is Script {
    function run() external returns (ErodoroIntent) {
        vm.startBroadcast();
        ErodoroIntent intent = new ErodoroIntent();
        vm.stopBroadcast();
        return intent;
    }
}
