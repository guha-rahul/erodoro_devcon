// SPDX-License-Identifier: Apache-2.0
pragma solidity 0.8.28;

import {Script} from "forge-std/Script.sol";
import {console2} from "forge-std/console2.sol";

import {IB20} from "base-std/interfaces/IB20.sol";
import {IB20Asset} from "base-std/interfaces/IB20Asset.sol";

import {ErodoroRFQ} from "../src/ErodoroRFQ.sol";
import {ErodoroVault} from "../src/ErodoroVault.sol";
import {Factory} from "../src/Factory.sol";
import {PythAdapter} from "../src/oracle/PythAdapter.sol";
import {IPythUnique} from "../src/oracle/IPythUnique.sol";
import {TestFaucet} from "../src/periphery/TestFaucet.sol";
import {TestIssuerControls} from "../src/periphery/TestIssuerControls.sol";
import {TestQuoteToken} from "../src/periphery/TestQuoteToken.sol";

/// @title DeployPilot
/// @notice Deploys the complete current testnet stack around an existing B20 test asset.
/// @dev The script refuses Base mainnet. The deployer must hold the B20 admin role
///      because the script grants narrow roles to the faucet and issuer sandbox.
contract DeployPilot is Script {
    uint256 private constant BASE_MAINNET = 8453;

    struct Deployment {
        ErodoroVault vault;
        PythAdapter adapter;
        Factory factory;
        ErodoroRFQ rfq;
        TestQuoteToken quote;
        TestFaucet faucet;
        TestIssuerControls issuerControls;
    }

    function run() external returns (Deployment memory deployed) {
        require(block.chainid != BASE_MAINNET, "testnet pilot - not for mainnet");

        uint256 pk = vm.envOr("PRIVATE_KEY", uint256(0));
        address deployer = pk == 0 ? vm.envAddress("DEPLOYER_ADDRESS") : vm.addr(pk);
        address pyth = vm.envAddress("PYTH_ADDRESS");
        IB20 stock = IB20(vm.envAddress("BASE_COLLATERAL"));
        address factoryAdmin = vm.envOr("FACTORY_ADMIN", deployer);

        require(pyth.code.length > 0, "PYTH_ADDRESS has no code");
        require(address(stock).code.length > 0, "BASE_COLLATERAL has no code");
        require(stock.hasRole(stock.DEFAULT_ADMIN_ROLE(), deployer), "deployer is not the B20 admin");

        uint8 stockDecimals = stock.decimals();
        require(stockDecimals >= 6 && stockDecimals <= 18, "unsupported collateral decimals");
        uint256 stockClaim = vm.envOr("FAUCET_STOCK_AMOUNT", uint256(5) * 10 ** uint256(stockDecimals));
        uint256 quoteClaim = vm.envOr("FAUCET_QUOTE_AMOUNT", uint256(500e6));
        uint256 cooldown = vm.envOr("FAUCET_COOLDOWN", uint256(1 days));

        if (pk == 0) vm.startBroadcast();
        else vm.startBroadcast(pk);

        deployed.vault = new ErodoroVault();
        deployed.adapter = new PythAdapter(IPythUnique(pyth));
        deployed.factory = new Factory(deployed.vault, factoryAdmin, _pilotBounds());
        deployed.rfq = new ErodoroRFQ();
        deployed.quote = new TestQuoteToken();
        deployed.faucet = new TestFaucet(stock, deployed.quote, stockClaim, quoteClaim, cooldown);
        deployed.issuerControls = new TestIssuerControls(IB20Asset(address(stock)));

        stock.grantRole(stock.MINT_ROLE(), address(deployed.faucet));
        stock.grantRole(IB20Asset(address(stock)).OPERATOR_ROLE(), address(deployed.issuerControls));
        stock.grantRole(stock.PAUSE_ROLE(), address(deployed.issuerControls));
        stock.grantRole(stock.UNPAUSE_ROLE(), address(deployed.issuerControls));

        vm.stopBroadcast();

        require(stock.hasRole(stock.MINT_ROLE(), address(deployed.faucet)), "faucet mint role missing");
        require(
            stock.hasRole(IB20Asset(address(stock)).OPERATOR_ROLE(), address(deployed.issuerControls)),
            "issuer operator role missing"
        );
        require(stock.hasRole(stock.PAUSE_ROLE(), address(deployed.issuerControls)), "issuer pause role missing");
        require(stock.hasRole(stock.UNPAUSE_ROLE(), address(deployed.issuerControls)), "issuer unpause role missing");

        _report(deployed, address(stock), pyth, factoryAdmin);
    }

    function _pilotBounds() private pure returns (Factory.Bounds memory) {
        return Factory.Bounds({
            minHorizon: 0,
            maxHorizon: 365 days,
            minSettlementDelay: 60,
            maxSettlementDelay: 1 days,
            minPriceLag: 1,
            maxPriceLag: 25 hours,
            maxConfBps: 500,
            maxFeeBps: 100,
            priceDecimals: 8
        });
    }

    function _report(Deployment memory d, address stock, address pyth, address factoryAdmin) private view {
        console2.log("");
        console2.log("=== current pilot deployment ===");
        console2.log("chain id       ", block.chainid);
        console2.log("stock          ", stock);
        console2.log("Pyth           ", pyth);
        console2.log("vault          ", address(d.vault));
        console2.log("Pyth adapter   ", address(d.adapter));
        console2.log("factory        ", address(d.factory));
        console2.log("factory admin  ", factoryAdmin);
        console2.log("RFQ            ", address(d.rfq));
        console2.log("quote token    ", address(d.quote));
        console2.log("faucet         ", address(d.faucet));
        console2.log("issuer controls", address(d.issuerControls));
        console2.log("");
        console2.log("Record these addresses before you list a series.");
    }
}
