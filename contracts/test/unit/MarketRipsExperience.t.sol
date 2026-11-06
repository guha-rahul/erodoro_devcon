// SPDX-License-Identifier: Apache-2.0
pragma solidity 0.8.28;
import {MarketRipPoolTest} from "./MarketRipPool.t.sol";
import {MarketRipPool} from "../../src/MarketRipPool.sol";

contract MarketRipsExperienceTest is MarketRipPoolTest {
    function test_upsideRipNeverPurchasesDownside() public {
        (uint256 id, uint256 series) = _addUp();
        _fillOtherNine();
        bytes32 commitment = pool.upInventoryHash();
        vm.prank(buyer);
        (uint256 picked, uint256 units) = pool.ripUp(commitment);
        assertEq(picked, id);
        assertEq(units, 1e8);
        assertEq(vault.balanceOf(buyer, vault.nId(series)), 1e8);
        assertEq(pool.purchasedValue(buyer, id), 1e6);
    }
    function test_directedFiveDollarBuyTransfersExactlyReviewedQuantity() public {
        (uint256 id, uint256 series) = _addUp();
        _fillOtherNine();
        vm.prank(buyer);
        assertEq(pool.buyPosition(id, 5, 1e8, bytes32("up-quote")), 5e8);
        assertEq(usdc.balanceOf(buyer), 15e6);
        assertEq(vault.balanceOf(buyer, vault.nId(series)), 5e8);
        assertEq(pool.purchasedValue(buyer, id), 5e6);
        assertEq(pool.purchasedUnits(buyer, id), 5e8);
        assertEq(pool.buyerPositions(buyer).length, 1);
    }
    function test_directedTwentyDollarBuyDoesNotPartiallyFill() public {
        (uint256 id,) = _addUp();
        _fillOtherNine();
        vm.prank(buyer);
        vm.expectRevert(MarketRipPool.NoInventory.selector);
        pool.buyPosition(id, 20, 1e8, bytes32("up-quote"));
        assertEq(usdc.balanceOf(buyer), 20e6);
        assertEq(pool.purchasedValue(buyer, id), 0);
        assertEq(pool.position(id).remainingUnits, 5e8);
    }
    function test_directedTwentyDollarBuyWithEnoughInventory() public {
        (uint256 id, uint256 series) = _addUp();
        _fillOtherNine();
        pool.setQuote(id, 1e7, uint64(block.timestamp + 300), bytes32("twenty-quote"));
        vm.prank(buyer);
        assertEq(pool.buyPosition(id, 20, 1e7, bytes32("twenty-quote")), 2e8);
        assertEq(usdc.balanceOf(buyer), 0);
        assertEq(vault.balanceOf(buyer, vault.nId(series)), 2e8);
        assertEq(pool.purchasedValue(buyer, id), 20e6);
        assertEq(pool.position(id).remainingUnits, 3e8);
    }
    function test_refreshedQuoteRequiresNewReview() public {
        (uint256 id,) = _addUp();
        _fillOtherNine();
        bytes32 commitment = pool.upInventoryHash();
        pool.setQuote(id, 2e8, uint64(block.timestamp + 300), bytes32("repriced"));
        vm.startPrank(buyer);
        vm.expectRevert(MarketRipPool.QuoteChanged.selector);
        pool.buyPosition(id, 1, 1e8, bytes32("up-quote"));
        vm.expectRevert(MarketRipPool.QuoteChanged.selector);
        pool.ripUp(commitment);
        vm.stopPrank();
        assertEq(usdc.balanceOf(buyer), 20e6);
    }
    function test_insufficientFundsRollsBackInventoryAndBuyerIndex() public {
        (uint256 id,) = _addUp();
        _fillOtherNine();
        vm.prank(buyer);
        usdc.transfer(address(0x999), 20e6);
        vm.prank(buyer);
        vm.expectRevert();
        pool.buyPosition(id, 1, 1e8, bytes32("up-quote"));
        assertEq(pool.position(id).remainingUnits, 5e8);
        assertEq(pool.purchasedValue(buyer, id), 0);
        assertEq(pool.buyerPositions(buyer).length, 0);
    }
    function test_expiredQuoteDisablesPurchases() public {
        (uint256 id,) = _addUp();
        _fillOtherNine();
        vm.warp(block.timestamp + 301);
        vm.prank(buyer);
        vm.expectRevert(MarketRipPool.NoInventory.selector);
        pool.buyPosition(id, 1, 1e8, bytes32("up-quote"));
    }
    function test_directedBuyRefusesDownClaimsAndInactiveBatch() public {
        (uint256 id,) = _addDown();
        vm.prank(buyer);
        vm.expectRevert(MarketRipPool.InvalidTerms.selector);
        pool.buyPosition(id, 1, 1e8, bytes32("down-quote"));
        _fillOtherNine();
        vm.prank(buyer);
        vm.expectRevert(MarketRipPool.InvalidTerms.selector);
        pool.buyPosition(id, 1, 1e8, bytes32("down-quote"));
    }
    function test_competingBuyerInvalidatesBlindInventoryReview() public {
        (uint256 id,) = _addUp();
        _fillOtherNine();
        bytes32 commitment = pool.upInventoryHash();
        vm.prank(buyer);
        pool.buyPosition(id, 1, 1e8, bytes32("up-quote"));
        vm.prank(buyer);
        vm.expectRevert(MarketRipPool.QuoteChanged.selector);
        pool.ripUp(commitment);
    }
    function test_claimTransferDoesNotChangeLifetimeCost() public {
        (uint256 id, uint256 series) = _addUp();
        _fillOtherNine();
        vm.startPrank(buyer);
        pool.buyPosition(id, 1, 1e8, bytes32("up-quote"));
        vault.transfer(address(0xCAFE), vault.nId(series), 1e8);
        vm.stopPrank();
        assertEq(vault.balanceOf(buyer, vault.nId(series)), 0);
        assertEq(pool.purchasedValue(buyer, id), 1e6);
        assertEq(pool.purchasedUnits(buyer, id), 1e8);
    }
}
