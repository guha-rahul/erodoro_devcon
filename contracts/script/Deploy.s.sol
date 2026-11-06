// SPDX-License-Identifier: Apache-2.0
pragma solidity 0.8.28;

import {Script} from "forge-std/Script.sol";
import {console2} from "forge-std/console2.sol";
import {ErodoroVault} from "../src/ErodoroVault.sol";
import {PythAdapter} from "../src/oracle/PythAdapter.sol";
import {IPythUnique} from "../src/oracle/IPythUnique.sol";
import {Factory} from "../src/Factory.sol";
import {RequireSafe} from "./RequireSafe.sol";

/// @title Deploy
/// @notice Deploys the vault, the oracle adapter and the factory, in that order.
///
/// @dev Order matters: the factory takes the vault in its constructor, and the
///      adapter's `IPyth` address is immutable, so a wrong value here is a
///      redeploy rather than a setter call.
///
///      **The admin.** Without `FACTORY_ADMIN` this script hands the factory
///      admin to the deployer, which is correct for a testnet only. On Base
///      mainnet it refuses to run unless `FACTORY_ADMIN` is a Safe that needs
///      at least two signatures (`RequireSafe`).
///
///      Nothing here activates a settlement configuration. Listing is a
///      separate, deliberate act.
contract Deploy is Script {
    function run() external {
        uint256 pk = vm.envUint("PRIVATE_KEY");
        address pyth = vm.envAddress("PYTH_ADDRESS");
        address admin = vm.envOr("FACTORY_ADMIN", vm.addr(pk));
        RequireSafe.check(admin, "FACTORY_ADMIN");

        console2.log("chain id  ", block.chainid);
        console2.log("deployer  ", vm.addr(pk));
        console2.log("pyth      ", pyth);
        console2.log("factory admin", admin);

        // Fail before spending gas rather than after.
        require(pyth.code.length > 0, "PYTH_ADDRESS has no code on this chain");

        vm.startBroadcast(pk);

        ErodoroVault vault = new ErodoroVault();
        PythAdapter adapter = new PythAdapter(IPythUnique(pyth));

        // Bounds a canonical series must satisfy. Deliberately conservative:
        // a series can always be stricter than the ceiling, never laxer.
        Factory.Bounds memory bounds = Factory.Bounds({
            minHorizon: 7 days,
            maxHorizon: 365 days,
            minSettlementDelay: 60,
            maxSettlementDelay: 1 days,
            minPriceLag: 1,
            maxPriceLag: 25 hours,
            maxConfBps: 500,
            maxFeeBps: 100,
            priceDecimals: 8
        });
        Factory factory = new Factory(vault, admin, bounds);

        vm.stopBroadcast();

        console2.log("");
        console2.log("=== deployed ===");
        console2.log("ErodoroVault", address(vault));
        console2.log("PythAdapter ", address(adapter));
        console2.log("Factory     ", address(factory));
        console2.log("");
        console2.log("Next: activate one complete settlement configuration,");
        console2.log("then list a series. Nothing is canonical until you do.");
    }
}
