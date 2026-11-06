// SPDX-License-Identifier: Apache-2.0
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {IB20} from "base-std/interfaces/IB20.sol";
import {IB20Asset} from "base-std/interfaces/IB20Asset.sol";

import {DeployPilot} from "../../script/DeployPilot.s.sol";
import {MockB20Asset} from "../harness/MockB20Asset.sol";
import {MockPythUnique} from "../harness/MockPythUnique.sol";

contract PilotDeploymentTest is Test {
    uint256 private constant DEPLOYER_KEY = 0xD3F10;

    function test_deploysTheCompletePilotAndGrantsNarrowRoles() public {
        vm.chainId(84532);
        address deployer = vm.addr(DEPLOYER_KEY);

        vm.prank(deployer);
        MockB20Asset stock = new MockB20Asset("Apple test stock", "tAAPLc", 8, false);
        MockPythUnique pyth = new MockPythUnique(60, 1);

        vm.setEnv("PRIVATE_KEY", vm.toString(DEPLOYER_KEY));
        vm.setEnv("PYTH_ADDRESS", vm.toString(address(pyth)));
        vm.setEnv("BASE_COLLATERAL", vm.toString(address(stock)));
        vm.setEnv("FACTORY_ADMIN", vm.toString(deployer));
        vm.setEnv("FAUCET_STOCK_AMOUNT", "500000000");
        vm.setEnv("FAUCET_QUOTE_AMOUNT", "500000000");
        vm.setEnv("FAUCET_COOLDOWN", "86400");

        DeployPilot.Deployment memory d = new DeployPilot().run();

        assertEq(address(d.factory.vault()), address(d.vault));
        assertEq(d.factory.admin(), deployer);
        assertTrue(stock.hasRole(stock.MINT_ROLE(), address(d.faucet)));
        assertTrue(stock.hasRole(stock.OPERATOR_ROLE(), address(d.issuerControls)));
        assertTrue(stock.hasRole(stock.PAUSE_ROLE(), address(d.issuerControls)));
        assertTrue(stock.hasRole(stock.UNPAUSE_ROLE(), address(d.issuerControls)));

        address seller = address(0x5E11E4);
        vm.prank(seller);
        d.faucet.claim();
        assertEq(stock.balanceOf(seller), 5e8);
        assertEq(d.quote.balanceOf(seller), 500e6);

        d.issuerControls.simulateSplit(2, 1);
        assertEq(IB20Asset(address(stock)).multiplier(), 2e18);
        assertFalse(IB20(address(stock)).isPaused(IB20.PausableFeature.TRANSFER));
    }
}
