// SPDX-License-Identifier: Apache-2.0
pragma solidity 0.8.28;

import {Script} from "forge-std/Script.sol";
import {console2} from "forge-std/console2.sol";
import {SafeCast} from "@openzeppelin/contracts/utils/math/SafeCast.sol";

import {IOptimisticOracleV2} from "../src/oracle/IOptimisticOracleV2.sol";
import {SettlementModel} from "../src/oracle/SettlementModel.sol";
import {UmaFallbackSettlementOracle} from "../src/oracle/UmaFallbackSettlementOracle.sol";

interface IUmaOracleFinder {
    function finder() external view returns (address);
}

interface IUmaFinder {
    function getImplementationAddress(bytes32 interfaceName) external view returns (address);
}

interface IUmaIdentifierWhitelist {
    function isIdentifierSupported(bytes32 identifier) external view returns (bool);
}

interface IUmaAddressWhitelist {
    function isOnWhitelist(address newElement) external view returns (bool);
}

/// @notice Deploys one immutable UMA fallback configuration, for one stock.
contract DeployUmaFallback is Script {
    function run() external returns (UmaFallbackSettlementOracle adapter) {
        require(block.chainid == 84532 || block.chainid == 8453, "Base or Base Sepolia only");
        uint256 pk = vm.envOr("PRIVATE_KEY", uint256(0));
        address oo = vm.envAddress("UMA_OOV2");
        address currency = vm.envAddress("UMA_BOND_CURRENCY");
        bytes32 identifier = vm.envBytes32("UMA_IDENTIFIER");
        uint256 bond = vm.envUint("UMA_BOND");
        uint256 rawLiveness = vm.envUint("UMA_LIVENESS");
        uint256 rawDecimals = vm.envUint("FALLBACK_PRICE_DECIMALS");
        uint64 liveness = SafeCast.toUint64(rawLiveness);
        uint8 decimals = SafeCast.toUint8(rawDecimals);
        SettlementModel model = SettlementModel(vm.envUint("FALLBACK_SETTLEMENT_MODEL"));
        string memory rules = vm.envString("UMA_RESOLUTION_RULES");
        // The one stock (feed) this fallback answers for; the Factory refuses it for any other.
        bytes32 feedId = vm.envBytes32("UMA_FEED_ID");

        require(oo.code.length > 0, "UMA_OOV2 has no code");
        require(currency.code.length > 0, "UMA_BOND_CURRENCY has no code");
        // Ask UMA itself: an unlisted identifier or bond token makes every proposal revert.
        IUmaFinder finder = IUmaFinder(IUmaOracleFinder(oo).finder());
        require(
            IUmaIdentifierWhitelist(finder.getImplementationAddress("IdentifierWhitelist")).isIdentifierSupported(identifier),
            "UMA_IDENTIFIER is not whitelisted on this chain"
        );
        require(
            IUmaAddressWhitelist(finder.getImplementationAddress("CollateralWhitelist")).isOnWhitelist(currency),
            "UMA_BOND_CURRENCY is not an approved UMA bond token"
        );

        if (pk == 0) vm.startBroadcast();
        else vm.startBroadcast(pk);
        adapter = new UmaFallbackSettlementOracle(
            IOptimisticOracleV2(oo), currency, identifier, bond, liveness, decimals, model, feedId, rules
        );
        vm.stopBroadcast();

        console2.log("UmaFallbackSettlementOracle", address(adapter));
    }
}
