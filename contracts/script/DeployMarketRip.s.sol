// SPDX-License-Identifier: Apache-2.0
pragma solidity 0.8.28;

import {Script} from "forge-std/Script.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {ErodoroVault} from "../src/ErodoroVault.sol";
import {Factory} from "../src/Factory.sol";
import {MarketRipPut} from "../src/MarketRipPut.sol";
import {MarketRipPool} from "../src/MarketRipPool.sol";
import {RequireSafe} from "./RequireSafe.sol";

/// @notice Deploy the isolated Market Rip contracts after the canonical vault
///         and Factory exist. No batch is created or funded by deployment.
contract DeployMarketRip is Script {
    function run() external returns (MarketRipPut put, MarketRipPool pool) {
        uint256 deployerKey = vm.envUint("DEPLOYER_PRIVATE_KEY");
        address quote = vm.envAddress("USDC_ADDRESS");
        ErodoroVault vault = ErodoroVault(vm.envAddress("VAULT_ADDRESS"));
        Factory factory = Factory(vm.envAddress("FACTORY_ADDRESS"));
        address erodoro = vm.envAddress("ERODORO_OPERATOR_ADDRESS");
        // The operator is immutable in both contracts: on mainnet it must be a Safe.
        RequireSafe.check(erodoro, "ERODORO_OPERATOR_ADDRESS");

        vm.startBroadcast(deployerKey);
        put = new MarketRipPut(IERC20(quote), erodoro);
        pool = new MarketRipPool(IERC20(quote), vault, factory, put, erodoro);
        vm.stopBroadcast();
    }
}
