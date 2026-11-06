// SPDX-License-Identifier: Apache-2.0
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {IB20} from "base-std/interfaces/IB20.sol";
import {TestFaucet} from "../../src/periphery/TestFaucet.sol";
import {TestQuoteToken} from "../../src/periphery/TestQuoteToken.sol";
import {MockB20Asset} from "../harness/MockB20Asset.sol";

contract TestFaucetTest is Test {
    MockB20Asset stock;
    TestQuoteToken quote;
    TestFaucet faucet;

    address alice = address(0xA11CE);
    uint256 constant STOCK = 5e8; // 5 shares at 8 decimals
    uint256 constant QUOTE = 500e6; // 500 test USD

    function setUp() public {
        vm.chainId(84532);
        vm.warp(1_700_000_000);
        stock = new MockB20Asset("Apple (test)", "tAAPLc", 8, false);
        quote = new TestQuoteToken();
        faucet = new TestFaucet(IB20(address(stock)), quote, STOCK, QUOTE, 1 days);
    }

    function test_claimGivesBothAssets() public {
        vm.prank(alice);
        faucet.claim();
        assertEq(stock.balanceOf(alice), STOCK);
        assertEq(quote.balanceOf(alice), QUOTE);
    }

    function test_theCollateralIsARealB20() public {
        vm.prank(alice);
        faucet.claim();
        // The point of the faucet: what it hands out behaves like the real
        // article, so the multiplier and pause paths get exercised by testers.
        assertEq(stock.multiplier(), 1e18);
        assertEq(stock.scaledBalanceOf(alice), STOCK);
        assertFalse(stock.isPaused(MockB20Asset.PausableFeature.TRANSFER));
    }

    function test_cooldownIsEnforcedAndReportsWhen() public {
        vm.prank(alice);
        faucet.claim();

        uint256 expected = block.timestamp + 1 days;
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(TestFaucet.TooSoon.selector, expected));
        faucet.claim();

        vm.warp(expected);
        vm.prank(alice);
        faucet.claim();
        assertEq(stock.balanceOf(alice), STOCK * 2);
    }

    function test_claimableAtIsZeroForANewAddress() public view {
        assertEq(faucet.claimableAt(alice), 0);
    }

    function test_refusesToDeployOnMainnet() public {
        vm.chainId(8453);
        vm.expectRevert(TestFaucet.NotForMainnet.selector);
        new TestFaucet(IB20(address(stock)), quote, STOCK, QUOTE, 1 days);
    }
}
