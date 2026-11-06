// SPDX-License-Identifier: Apache-2.0
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {MarketRipPut} from "../../src/MarketRipPut.sol";
import {TestQuoteToken} from "../../src/periphery/TestQuoteToken.sol";
import {MockB20Asset} from "../harness/MockB20Asset.sol";
import {MockOracleAdapter} from "../harness/MockOracleAdapter.sol";
import {SettlementModel} from "../../src/oracle/SettlementModel.sol";

contract MarketRipPutTest is Test {
    MarketRipPut put;
    TestQuoteToken usdc;
    MockB20Asset stock;
    MockOracleAdapter oracle;
    address buyer = address(0xB0B);
    uint256 id;
    uint64 maturity;

    function setUp() public {
        vm.warp(1_800_000_000);
        usdc = new TestQuoteToken();
        stock = new MockB20Asset("Stock", "STK", 8, false);
        oracle = new MockOracleAdapter(SettlementModel.TOTAL_RETURN);
        put = new MarketRipPut(usdc, address(this));
        usdc.mint(address(this), 1_000e6);
        usdc.approve(address(put), type(uint256).max);
        maturity = uint64(block.timestamp + 30 days);
        id = put.createSeries(
            address(stock), address(oracle), address(0), bytes32("STK/USD"), bytes32(0),
            95e8, maturity, 60, 120, 0, 0, 8
        );
    }

    function test_fullyCollateralizedDownsideAndFractionalRedemption() public {
        put.fundAndMint(id, 2e8);
        MarketRipPut.Series memory s = put.series(id);
        assertEq(s.collateralSupplied, 190e6);
        assertEq(usdc.balanceOf(address(put)), 190e6);

        put.transfer(buyer, id, 5e7);
        vm.warp(maturity + 60);
        oracle.setPrice(80e8, 8, maturity + 60);
        put.settle(id, new bytes[](0));

        vm.prank(buyer);
        assertEq(put.redeem(id, 5e7), 7_500_000);
        assertEq(usdc.balanceOf(buyer), 7_500_000);
        assertEq(put.withdrawSurplus(id), 160e6);
        assertEq(usdc.balanceOf(address(put)), 22_500_000);
        assertEq(put.redeem(id, 15e7), 22_500_000);
        assertEq(usdc.balanceOf(address(put)), 0);
    }

    function test_expiresWorthlessAboveStrike() public {
        put.fundAndMint(id, 1e8);
        vm.warp(maturity + 60);
        oracle.setPrice(120e8, 8, maturity + 60);
        put.settle(id, new bytes[](0));
        assertEq(put.redeem(id, 1e8), 0);
        assertEq(put.withdrawSurplus(id), 95e6);
    }

    function test_cannotMintUnfundedOrAfterMaturity() public {
        usdc.approve(address(put), 0);
        vm.expectRevert();
        put.fundAndMint(id, 1e8);
        vm.warp(maturity);
        vm.expectRevert(MarketRipPut.TooLate.selector);
        put.fundAndMint(id, 1e8);
    }

    function test_requiresTotalReturnOracle() public {
        MockOracleAdapter raw = new MockOracleAdapter(SettlementModel.RAW_SHARE);
        vm.expectRevert(MarketRipPut.InvalidTerms.selector);
        put.createSeries(address(stock), address(raw), address(0), bytes32("STK/USD"), bytes32(0),
            95e8, maturity, 60, 120, 0, 0, 8);
    }

    function test_mainnetRejectsNonCanonicalUsdc() public {
        vm.chainId(8453);
        vm.expectRevert(MarketRipPut.InvalidTerms.selector);
        new MarketRipPut(usdc, address(this));
    }

    function testFuzz_fractionalClaimsStaySolvent(uint96 firstSeed, uint96 secondSeed, uint96 priceSeed) public {
        uint256 first = bound(uint256(firstSeed), 1, 1e8);
        uint256 second = bound(uint256(secondSeed), 1, 1e8);
        uint256 price = bound(uint256(priceSeed), 1, 200e8);
        put.fundAndMint(id, first + second);
        put.transfer(buyer, id, first);
        vm.warp(maturity + 60);
        oracle.setPrice(price, 8, maturity + 60);
        put.settle(id, new bytes[](0));
        put.withdrawSurplus(id);
        vm.prank(buyer);
        put.redeem(id, first);
        put.redeem(id, second);
        put.withdrawSurplus(id);
        assertEq(usdc.balanceOf(address(put)), 0);
    }
}
