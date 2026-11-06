// SPDX-License-Identifier: Apache-2.0
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {MarketRipPool} from "../../src/MarketRipPool.sol";
import {MarketRipPut} from "../../src/MarketRipPut.sol";
import {ErodoroVault} from "../../src/ErodoroVault.sol";
import {Factory} from "../../src/Factory.sol";
import {TestQuoteToken} from "../../src/periphery/TestQuoteToken.sol";
import {MockB20Asset} from "../harness/MockB20Asset.sol";
import {MockOracleAdapter} from "../harness/MockOracleAdapter.sol";
import {SettlementModel} from "../../src/oracle/SettlementModel.sol";
import {HumanRegistry} from "../../src/identity/HumanRegistry.sol";

contract MarketRipPoolTest is Test {
    MarketRipPool pool;
    MarketRipPut put;
    ErodoroVault vault;
    Factory factory;
    TestQuoteToken usdc;
    MockB20Asset stock;
    MockOracleAdapter oracle;
    address buyer = address(0xB0B);
    uint256 batchId;
    uint64 expiry;

    function setUp() public {
        vm.warp(1_800_000_000);
        usdc = new TestQuoteToken();
        stock = new MockB20Asset("Stock", "STK", 8, false);
        oracle = new MockOracleAdapter(SettlementModel.TOTAL_RETURN);
        vault = new ErodoroVault();
        factory = new Factory(vault, address(this), Factory.Bounds({
            minHorizon: 7 days, maxHorizon: 365 days, minSettlementDelay: 60,
            maxSettlementDelay: 1 days, minPriceLag: 1, maxPriceLag: 25 hours,
            maxConfBps: 500, maxFeeBps: 100, priceDecimals: 8
        }));
        factory.setSettlementConfiguration(Factory.SettlementConfigurationParams({
            collateral: address(stock), oracle: address(oracle), fallbackOracle: address(0),
            feedId: bytes32("STK/USD"), settlementModel: SettlementModel.TOTAL_RETURN,
            fallbackDelay: 0, priceDecimals: 8
        }));
        put = new MarketRipPut(usdc, address(this));
        pool = new MarketRipPool(usdc, vault, factory, put, address(this));
        stock.mint(address(this), 100e8);
        stock.approve(address(vault), type(uint256).max);
        usdc.mint(address(this), 5_000e6);
        usdc.mint(buyer, 20e6);
        usdc.approve(address(put), type(uint256).max);
        vm.prank(buyer);
        usdc.approve(address(pool), type(uint256).max);
        vault.setOperator(address(pool), true);
        put.setOperator(address(pool), true);
        batchId = pool.createBatch(uint64(block.timestamp + 30 days));
        expiry = pool.batchExpiry(batchId);
    }

    function _addUp() internal returns (uint256 positionId, uint256 seriesId) {
        ErodoroVault.CreateSeriesParams memory params = ErodoroVault.CreateSeriesParams({
            collateral: address(stock), oracle: address(oracle), fallbackOracle: address(0),
            feeRecipient: address(this), feedId: bytes32("STK/USD"), fallbackRequestId: bytes32(0),
            settlementModel: SettlementModel.TOTAL_RETURN, strike: 105e8, minSplitAmount: 0,
            maturity: expiry, settlementDelay: 60, maxPriceLag: 120, fallbackDelay: 0,
            maxConfBps: 0, feeBps: 0, priceDecimals: 8, admin: address(this)
        });
        seriesId = factory.createSeries(params, address(this));
        vault.split(seriesId, 5e8);
        positionId = pool.addPosition(MarketRipPool.AddPositionParams({
            batchId: batchId, stock: address(stock), direction: MarketRipPool.Direction.UP,
            claimId: vault.nId(seriesId), spotAtCreation: 100e8, unitsPerRip: 1e8,
            quoteValidUntil: uint64(block.timestamp + 5 minutes), quoteRef: bytes32("up-quote")
        }));
    }

    function _addDown() internal returns (uint256 positionId, uint256 putId) {
        putId = put.createSeries(address(stock), address(oracle), address(0), bytes32("STK/USD"),
            bytes32(0), 95e8, expiry, 60, 120, 0, 0, 8);
        put.fundAndMint(putId, 5e8);
        positionId = pool.addPosition(MarketRipPool.AddPositionParams({
            batchId: batchId, stock: address(stock), direction: MarketRipPool.Direction.DOWN,
            claimId: putId, spotAtCreation: 100e8, unitsPerRip: 1e8,
            quoteValidUntil: uint64(block.timestamp + 5 minutes), quoteRef: bytes32("down-quote")
        }));
    }

    function _fillOtherNine() internal {
        for (uint256 i; i < 9; ++i) {
            MockB20Asset other = new MockB20Asset("Other", "OTH", 8, false);
            uint256 putId = put.createSeries(address(other), address(oracle), address(0), bytes32("STK/USD"),
                bytes32(0), 95e8, expiry, 60, 120, 0, 0, 8);
            put.fundAndMint(putId, 5e8);
            pool.addPosition(MarketRipPool.AddPositionParams({
                batchId: batchId, stock: address(other), direction: MarketRipPool.Direction.DOWN,
                claimId: putId, spotAtCreation: 100e8, unitsPerRip: 1e8,
                quoteValidUntil: uint64(block.timestamp + 1), quoteRef: bytes32("other-quote")
            }));
        }
        pool.activateBatch(batchId);
        vm.warp(block.timestamp + 2);
    }

    function test_oneDollarAtomicPurchaseOfRealUpClaim() public {
        (uint256 positionId, uint256 seriesId) = _addUp();
        _fillOtherNine();
        assertEq(pool.remainingInventoryValue(positionId), 5e6);
        assertEq(pool.position(positionId).collateralSupplied, 5e8);
        vm.prank(buyer);
        (uint256 picked, uint256 units) = pool.rip();
        assertEq(picked, positionId);
        assertEq(units, 1e8);
        assertEq(usdc.balanceOf(buyer), 19e6);
        assertEq(vault.balanceOf(buyer, vault.nId(seriesId)), 1e8);
        assertEq(pool.remainingInventoryValue(positionId), 4e6);
        assertEq(pool.position(positionId).amountSold, 1e6);
    }

    function test_buyerCanRedeemPurchasedUpClaimAfterSettlement() public {
        (, uint256 seriesId) = _addUp();
        _fillOtherNine();
        vm.prank(buyer);
        pool.rip();
        vm.warp(expiry + 60);
        oracle.setPrice(120e8, 8, expiry + 60);
        vault.settle(seriesId, new bytes[](0));
        vm.prank(buyer);
        assertEq(vault.redeem(seriesId, false, 1e8), 12_500_000);
        assertEq(stock.balanceOf(buyer), 12_500_000);
    }

    function test_fiveRipsCannotOversellFundedPut() public {
        (uint256 positionId, uint256 putId) = _addDown();
        _fillOtherNine();
        assertEq(pool.position(positionId).collateralSupplied, 475e6);
        vm.startPrank(buyer);
        for (uint256 i; i < 5; ++i) pool.rip();
        vm.expectRevert(MarketRipPool.NoInventory.selector);
        pool.rip();
        vm.stopPrank();
        assertEq(put.balanceOf(buyer, putId), 5e8);
        assertEq(usdc.balanceOf(buyer), 15e6);
        assertEq(pool.position(positionId).buyerCount, 1);
        assertEq(pool.buyerPositions(buyer).length, 1);
        assertEq(pool.purchasedValue(buyer, positionId), 5e6);
        assertEq(pool.purchasedUnits(buyer, positionId), 5e8);
        assertEq(pool.remainingInventoryValue(positionId), 0);
    }

    function test_buyerCanRedeemPurchasedDownClaimAfterSettlement() public {
        (, uint256 putId) = _addDown();
        _fillOtherNine();
        vm.prank(buyer);
        pool.rip();
        vm.warp(expiry + 60);
        oracle.setPrice(80e8, 8, expiry + 60);
        put.settle(putId, new bytes[](0));
        vm.prank(buyer);
        assertEq(put.redeem(putId, 1e8), 15e6);
        assertEq(usdc.balanceOf(buyer), 34e6); // 20 - 1 RIP + 15 settlement
    }

    function test_rejectsUnbackedPutInventory() public {
        uint256 putId = put.createSeries(address(stock), address(oracle), address(0), bytes32("STK/USD"),
            bytes32(0), 95e8, expiry, 60, 120, 0, 0, 8);
        vm.expectRevert(MarketRipPool.InvalidTerms.selector);
        pool.addPosition(MarketRipPool.AddPositionParams({
            batchId: batchId, stock: address(stock), direction: MarketRipPool.Direction.DOWN,
            claimId: putId, spotAtCreation: 100e8, unitsPerRip: 1e8,
            quoteValidUntil: uint64(block.timestamp + 5 minutes), quoteRef: bytes32("down-quote")
        }));
    }

    function test_batchNeedsTenPositionsBeforeActivation() public {
        _addUp();
        vm.expectRevert(MarketRipPool.InvalidBatch.selector);
        pool.activateBatch(batchId);
        vm.prank(buyer);
        vm.expectRevert(MarketRipPool.NoInventory.selector);
        pool.rip();
    }

    function test_unsoldClaimReturnsToHouseAfterExpiry() public {
        (uint256 positionId, uint256 putId) = _addDown();
        vm.warp(expiry);
        assertEq(pool.returnExpiredInventory(positionId), 5e8);
        assertEq(put.balanceOf(address(this), putId), 5e8);
        assertEq(pool.position(positionId).remainingUnits, 0);
    }

    function test_repricedInventoryStillCannotOversell() public {
        (uint256 positionId,) = _addDown();
        _fillOtherNine();
        pool.setQuote(positionId, 2e8, uint64(block.timestamp + 5 minutes), bytes32("new-quote"));
        assertEq(pool.remainingInventoryValue(positionId), 2_500_000);
        vm.startPrank(buyer);
        pool.rip();
        pool.rip();
        vm.expectRevert(MarketRipPool.NoInventory.selector);
        pool.rip();
        vm.stopPrank();
        assertEq(pool.position(positionId).remainingUnits, 1e8);
        assertEq(pool.position(positionId).amountSold, 2e6);
    }

    // --- Seller listings ---------------------------------------------------

    address seller = address(0x5E11);

    function _listing(uint256 collateral, uint256 unitsPerRip) internal returns (uint256 templateId, uint256 seriesId, uint256 id) {
        (templateId, seriesId) = _addUp();
        _fillOtherNine();
        // A house quote of 4e7 per $1 puts the minimum listing at 2e8 units.
        pool.setQuote(templateId, 4e7, uint64(block.timestamp + 5 minutes), bytes32("house-4e7"));
        stock.mint(seller, collateral);
        vm.startPrank(seller);
        stock.approve(address(pool), collateral);
        (id,) = pool.lockAndList(templateId, collateral, unitsPerRip);
        vm.stopPrank();
    }

    function test_sellerLocksStockKeepsPAndIsPaidDirectly() public {
        (uint256 templateId, uint256 seriesId, uint256 id) = _listing(2e8, 5e7);
        MarketRipPool.Position memory p = pool.position(id);
        assertEq(p.seller, seller);
        assertEq(p.claimId, pool.position(templateId).claimId);
        assertEq(p.strike, pool.position(templateId).strike);
        assertEq(p.remainingUnits, 2e8);
        assertEq(vault.balanceOf(seller, vault.pId(seriesId)), 2e8);
        assertEq(stock.balanceOf(seller), 0);
        assertEq(pool.sellerPositions(seller)[0], id);

        uint256 houseBefore = usdc.balanceOf(address(this));
        vm.prank(buyer);
        uint256 units = pool.buyPosition(id, 2, p.unitsPerRip, p.quoteRef);
        assertEq(units, 1e8);
        assertEq(usdc.balanceOf(seller), 2e6);
        assertEq(usdc.balanceOf(address(this)), houseBefore);
        assertEq(vault.balanceOf(buyer, vault.nId(seriesId)), 1e8);
        assertEq(pool.position(id).amountSold, 2e6);
        assertEq(pool.purchasedValue(buyer, id), 2e6);
    }

    function test_sellerPriceStandsUntilChangedAndRepricingBindsBuyers() public {
        (,, uint256 id) = _listing(2e8, 5e7);
        MarketRipPool.Position memory p = pool.position(id);
        assertEq(p.quoteValidUntil, expiry);
        vm.warp(block.timestamp + 10 days);
        vm.prank(seller);
        pool.setListingPrice(id, 4e7);
        vm.prank(buyer);
        vm.expectRevert(MarketRipPool.QuoteChanged.selector);
        pool.buyPosition(id, 1, p.unitsPerRip, p.quoteRef);
        MarketRipPool.Position memory q = pool.position(id);
        vm.prank(buyer);
        assertEq(pool.buyPosition(id, 1, q.unitsPerRip, q.quoteRef), 4e7);
        assertEq(usdc.balanceOf(seller), 1e6);
    }

    function test_sellerWithdrawsUnsoldAndMergesBackToStock() public {
        (, uint256 seriesId, uint256 id) = _listing(2e8, 5e7);
        vm.startPrank(seller);
        pool.withdrawListing(id, 2e8);
        vault.merge(seriesId, 2e8);
        vm.stopPrank();
        assertEq(stock.balanceOf(seller), 2e8);
        assertEq(pool.position(id).remainingUnits, 0);
        bytes32 ref = pool.position(id).quoteRef;
        vm.prank(buyer);
        vm.expectRevert(MarketRipPool.NoInventory.selector);
        pool.buyPosition(id, 1, 5e7, ref);
    }

    function test_onlySellerControlsTheirListing() public {
        (,, uint256 id) = _listing(2e8, 5e7);
        vm.expectRevert(MarketRipPool.Unauthorized.selector);
        pool.setQuote(id, 1e7, uint64(block.timestamp + 1 minutes), bytes32("house"));
        vm.startPrank(buyer);
        vm.expectRevert(MarketRipPool.Unauthorized.selector);
        pool.setListingPrice(id, 1);
        vm.expectRevert(MarketRipPool.Unauthorized.selector);
        pool.withdrawListing(id, 1);
        vm.expectRevert(MarketRipPool.Unauthorized.selector);
        pool.returnExpiredInventory(id);
        vm.stopPrank();
    }

    function test_expiredListingReturnsToSellerNotHouse() public {
        (, uint256 seriesId, uint256 id) = _listing(2e8, 5e7);
        vm.warp(expiry);
        assertEq(pool.returnExpiredInventory(id), 2e8);
        assertEq(vault.balanceOf(seller, vault.nId(seriesId)), 2e8);
        assertEq(vault.balanceOf(address(this), vault.nId(seriesId)), 0);
    }

    function test_listingNeedsActiveHouseUpTemplate() public {
        (uint256 templateId,) = _addUp();
        stock.mint(seller, 1e8);
        vm.startPrank(seller);
        stock.approve(address(pool), type(uint256).max);
        vm.expectRevert(MarketRipPool.InvalidPosition.selector);
        pool.lockAndList(templateId, 1e8, 1e7);
        vm.stopPrank();
        _fillOtherNine();
        pool.setQuote(templateId, 1e7, uint64(block.timestamp + 5 minutes), bytes32("house-1e7"));
        vm.startPrank(seller);
        (uint256 listing,) = pool.lockAndList(templateId, 5e7, 1e7);
        vm.expectRevert(MarketRipPool.InvalidPosition.selector);
        pool.lockAndList(listing, 5e7, 1e7);
        vm.expectRevert(MarketRipPool.InvalidTerms.selector);
        pool.lockAndList(templateId, 1e7, 2e7);
        vm.stopPrank();
    }

    function test_sellerRipNeverPullsTheirOwnListing() public {
        (uint256 templateId,, uint256 own) = _listing(2e8, 5e7);
        usdc.mint(seller, 20e6);
        vm.prank(seller);
        usdc.approve(address(pool), type(uint256).max);
        // Only the house template and the seller's own listing are eligible UP
        // positions, so every pull must land on the template.
        for (uint256 i; i < 3; ++i) {
            vm.roll(block.number + 1);
            bytes32 hash = pool.upInventoryHash();
            vm.prank(seller);
            (uint256 picked,) = pool.ripUp(hash);
            assertEq(picked, templateId);
        }
        assertEq(pool.position(own).amountSold, 0);
        MarketRipPool.Position memory p = pool.position(own);
        vm.prank(seller);
        vm.expectRevert(MarketRipPool.OwnListing.selector);
        pool.buyPosition(own, 1, p.unitsPerRip, p.quoteRef);
    }

    // --- $1 packs across ten stocks ----------------------------------------

    MockB20Asset[] packStocks;
    uint256[] packMarkets;

    /// @dev Ten house UP markets, one per distinct stock, each quoting 1e8 units per $1.
    function _tenUpMarkets() internal {
        for (uint256 i; i < 10; ++i) {
            MockB20Asset s = new MockB20Asset("Stock", "STK", 8, false);
            factory.setSettlementConfiguration(Factory.SettlementConfigurationParams({
                collateral: address(s), oracle: address(oracle), fallbackOracle: address(0),
                feedId: bytes32("STK/USD"), settlementModel: SettlementModel.TOTAL_RETURN,
                fallbackDelay: 0, priceDecimals: 8
            }));
            s.mint(address(this), 5e8);
            s.approve(address(vault), type(uint256).max);
            uint256 seriesId = factory.createSeries(ErodoroVault.CreateSeriesParams({
                collateral: address(s), oracle: address(oracle), fallbackOracle: address(0),
                feeRecipient: address(this), feedId: bytes32("STK/USD"), fallbackRequestId: bytes32(0),
                settlementModel: SettlementModel.TOTAL_RETURN, strike: 105e8, minSplitAmount: 0,
                maturity: expiry, settlementDelay: 60, maxPriceLag: 120, fallbackDelay: 0,
                maxConfBps: 0, feeBps: 0, priceDecimals: 8, admin: address(this)
            }), address(this));
            vault.split(seriesId, 5e8);
            packStocks.push(s);
            packMarkets.push(pool.addPosition(MarketRipPool.AddPositionParams({
                batchId: batchId, stock: address(s), direction: MarketRipPool.Direction.UP,
                claimId: vault.nId(seriesId), spotAtCreation: 100e8, unitsPerRip: 1e8,
                quoteValidUntil: uint64(block.timestamp + 5 minutes), quoteRef: bytes32("up-quote")
            })));
        }
        pool.activateBatch(batchId);
    }

    function test_packBuysATenthOnEachOfTenStocks() public {
        _tenUpMarkets();
        uint256 houseBefore = usdc.balanceOf(address(this));
        bytes32 hash = pool.upInventoryHash();
        vm.prank(buyer);
        (uint256[] memory ids, uint256[] memory units) = pool.ripPack(hash);
        assertEq(ids.length, 10);
        assertEq(usdc.balanceOf(buyer), 19e6);
        assertEq(usdc.balanceOf(address(this)), houseBefore + 1e6);
        for (uint256 i; i < 10; ++i) {
            assertEq(units[i], 1e7);
            MarketRipPool.Position memory p = pool.position(ids[i]);
            assertEq(p.amountSold, 1e5);
            assertEq(pool.purchasedValue(buyer, ids[i]), 1e5);
            assertEq(vault.balanceOf(buyer, p.claimId), 1e7);
            for (uint256 j; j < i; ++j) assertTrue(pool.position(ids[j]).stock != p.stock, "pack repeats a stock");
        }
        assertEq(pool.buyerPositions(buyer).length, 10);
        assertEq(pool.packNonce(), 1);
    }

    function test_ripPacksBuysEachPackInOneCall() public {
        _tenUpMarkets();
        bytes32 hash = pool.upInventoryHash();
        vm.prank(buyer);
        (uint256[] memory ids, uint256[] memory units) = pool.ripPacks(hash, 3);
        assertEq(ids.length, 30);
        assertEq(usdc.balanceOf(buyer), 17e6);
        assertEq(pool.packNonce(), 3);
        for (uint256 r; r < 3; ++r) {
            for (uint256 i; i < 10; ++i) {
                assertEq(units[r * 10 + i], 1e7);
                for (uint256 j; j < i; ++j) assertTrue(pool.position(ids[r * 10 + j]).stock != pool.position(ids[r * 10 + i]).stock, "pack repeats a stock");
            }
        }
    }

    function test_ripPacksAtTheCapStaysWithinOneTransactionsGas() public {
        _tenUpMarkets();
        bytes32 hash = pool.upInventoryHash();
        uint256 count = pool.MAX_PACKS();
        vm.prank(buyer);
        uint256 before = gasleft();
        pool.ripPacks(hash, count);
        // Under the 16,777,216 per-transaction gas cap (EIP-7825) with room to spare.
        assertLt(before - gasleft(), 12_000_000);
        assertEq(usdc.balanceOf(buyer), 20e6 - count * 1e6);
    }

    function test_ripPacksRejectsZeroAndMoreThanTheCap() public {
        _tenUpMarkets();
        bytes32 hash = pool.upInventoryHash();
        uint256 over = pool.MAX_PACKS() + 1;
        vm.startPrank(buyer);
        vm.expectRevert(MarketRipPool.InvalidTerms.selector);
        pool.ripPacks(hash, 0);
        vm.expectRevert(MarketRipPool.InvalidTerms.selector);
        pool.ripPacks(hash, over);
        vm.stopPrank();
    }

    function test_ripPacksIsAllOrNothingWhenStockRunsOut() public {
        _tenUpMarkets();
        // Every pack takes a slice of all ten stocks. After 39 packs each holds
        // $1.10: two more packs fit, a third would drop them below $1.
        address drainer = address(0xD12A);
        usdc.mint(drainer, 39e6);
        vm.startPrank(drainer);
        usdc.approve(address(pool), type(uint256).max);
        for (uint256 k; k < 39; ++k) pool.ripPack(pool.upInventoryHash());
        vm.stopPrank();
        bytes32 hash = pool.upInventoryHash();
        uint256 paid = usdc.balanceOf(buyer);
        vm.prank(buyer);
        vm.expectRevert(MarketRipPool.NoInventory.selector);
        pool.ripPacks(hash, 3);
        assertEq(usdc.balanceOf(buyer), paid, "nothing charged");
    }

    function test_packNeedsTenStocksAndChargesNothingOtherwise() public {
        _addUp();
        _fillOtherNine(); // one UP stock; the other nine are puts
        bytes32 hash = pool.upInventoryHash();
        vm.prank(buyer);
        vm.expectRevert(MarketRipPool.NoInventory.selector);
        pool.ripPack(hash);
        assertEq(usdc.balanceOf(buyer), 20e6);
    }

    function test_packIsBoundToTheReviewedInventory() public {
        _tenUpMarkets();
        bytes32 hash = pool.upInventoryHash();
        pool.setQuote(packMarkets[3], 2e8, uint64(block.timestamp + 5 minutes), bytes32("moved"));
        vm.prank(buyer);
        vm.expectRevert(MarketRipPool.QuoteChanged.selector);
        pool.ripPack(hash);
    }

    function test_packNeverPullsTheBuyersOwnListingAndPaysSellersDirectly() public {
        _tenUpMarkets();
        // The seller lists stock 0 at a better price; buyers' packs may pull it.
        packStocks[0].mint(seller, 5e8);
        vm.startPrank(seller);
        packStocks[0].approve(address(pool), 5e8);
        (uint256 own,) = pool.lockAndList(packMarkets[0], 5e8, 2e8);
        vm.stopPrank();
        usdc.mint(seller, 5e6);
        vm.prank(seller);
        usdc.approve(address(pool), type(uint256).max);
        for (uint256 r; r < 3; ++r) {
            vm.roll(block.number + 1);
            bytes32 hash = pool.upInventoryHash();
            vm.prank(seller);
            (uint256[] memory ids,) = pool.ripPack(hash);
            for (uint256 i; i < 10; ++i) assertTrue(ids[i] != own, "seller pulled their own listing");
        }
        assertEq(pool.position(own).amountSold, 0);
        // A third party's pack pays whichever seller supplied each slice.
        uint256 sellerBefore = usdc.balanceOf(seller);
        uint256 houseBefore = usdc.balanceOf(address(this));
        bytes32 current = pool.upInventoryHash();
        vm.prank(buyer);
        pool.ripPack(current);
        assertEq((usdc.balanceOf(seller) - sellerBefore) + (usdc.balanceOf(address(this)) - houseBefore), 1e6);
    }

    function test_packSkipsAStockWhoseQuoteLapsed() public {
        _tenUpMarkets();
        vm.warp(block.timestamp + 6 minutes); // every house quote lapses
        for (uint256 i; i < 9; ++i) pool.setQuote(packMarkets[i], 1e8, uint64(block.timestamp + 5 minutes), bytes32("fresh"));
        bytes32 hash = pool.upInventoryHash();
        vm.prank(buyer);
        vm.expectRevert(MarketRipPool.NoInventory.selector);
        pool.ripPack(hash); // only nine stocks are quoted
    }

    // --- Mainnet hardening -------------------------------------------------

    function test_listingBelowMinimumSizeIsRejected() public {
        (uint256 templateId,) = _addUp();
        _fillOtherNine();
        stock.mint(seller, 5e8);
        vm.startPrank(seller);
        stock.approve(address(pool), type(uint256).max);
        vm.expectRevert(MarketRipPool.InvalidTerms.selector);
        pool.lockAndList(templateId, 5e8 - 1, 1e8); // house 1e8/$ needs 5e8
        pool.lockAndList(templateId, 5e8, 1e8);
        vm.stopPrank();
    }

    function test_blindBuysSkipSellerListingsPricedBelowTheHouse() public {
        (uint256 templateId,, uint256 own) = _listing(2e8, 3e7); // house gives 4e7 per $1
        for (uint256 i; i < 5; ++i) {
            vm.roll(block.number + 1);
            bytes32 hash = pool.upInventoryHash();
            vm.prank(buyer);
            (uint256 picked,) = pool.ripUp(hash);
            assertEq(picked, templateId);
        }
        assertEq(pool.position(own).amountSold, 0);
        // A buyer who picks it directly still can, at the reviewed price.
        MarketRipPool.Position memory p = pool.position(own);
        vm.prank(buyer);
        assertEq(pool.buyPosition(own, 1, p.unitsPerRip, p.quoteRef), 3e7);
    }

    function test_staleHouseQuotePausesBlindSalesOfThatStock() public {
        _listing(2e8, 5e7);
        vm.warp(block.timestamp + 6 minutes); // house quote lapses, listing price stands
        bytes32 hash = pool.upInventoryHash();
        vm.prank(buyer);
        vm.expectRevert(MarketRipPool.NoInventory.selector);
        pool.ripUp(hash);
    }

    function test_legacyRipNeverReachesSellerListings() public {
        (uint256 templateId,, uint256 own) = _listing(2e8, 1); // a predatory price
        for (uint256 i; i < 5; ++i) {
            vm.roll(block.number + 1);
            vm.prank(buyer);
            (uint256 picked,) = pool.rip();
            assertEq(picked, templateId);
        }
        assertEq(pool.position(own).amountSold, 0);
    }

    function test_createBatchExpiryMustFallInsideBounds() public {
        vm.expectRevert(MarketRipPool.InvalidTerms.selector);
        pool.createBatch(uint64(block.timestamp + 7 days - 1));
        vm.expectRevert(MarketRipPool.InvalidTerms.selector);
        pool.createBatch(uint64(block.timestamp + 45 days + 1));
        uint256 id = pool.createBatch(uint64(block.timestamp + 20 days));
        assertEq(pool.batchExpiry(id), block.timestamp + 20 days);
        vm.prank(buyer);
        vm.expectRevert(MarketRipPool.Unauthorized.selector);
        pool.createBatch(uint64(block.timestamp + 20 days));
    }

    function test_quoterRefreshesAndPausesButOnlyOperatorResumes() public {
        _tenUpMarkets();
        address quoter = address(0x0907E);
        vm.prank(quoter);
        vm.expectRevert(MarketRipPool.Unauthorized.selector);
        pool.setQuote(packMarkets[0], 2e8, uint64(block.timestamp + 5 minutes), bytes32("q"));
        vm.prank(buyer);
        vm.expectRevert(MarketRipPool.Unauthorized.selector);
        pool.setQuoter(buyer);
        pool.setQuoter(quoter);
        vm.startPrank(quoter);
        pool.setQuote(packMarkets[0], 2e8, uint64(block.timestamp + 5 minutes), bytes32("q"));
        pool.setPaused(true);
        vm.expectRevert(MarketRipPool.Unauthorized.selector);
        pool.setPaused(false);
        vm.stopPrank();

        bytes32 hash = pool.upInventoryHash();
        vm.startPrank(buyer);
        vm.expectRevert(MarketRipPool.SalesPaused.selector);
        pool.ripPack(hash);
        vm.expectRevert(MarketRipPool.SalesPaused.selector);
        pool.ripUp(hash);
        vm.expectRevert(MarketRipPool.SalesPaused.selector);
        pool.rip();
        vm.stopPrank();

        pool.setPaused(false);
        vm.prank(buyer);
        pool.ripPack(hash);
    }

    function test_mainnetSeriesNeedsAFallbackOracle() public {
        uint256 seriesId = factory.createSeries(ErodoroVault.CreateSeriesParams({
            collateral: address(stock), oracle: address(oracle), fallbackOracle: address(0),
            feeRecipient: address(this), feedId: bytes32("STK/USD"), fallbackRequestId: bytes32(0),
            settlementModel: SettlementModel.TOTAL_RETURN, strike: 105e8, minSplitAmount: 0,
            maturity: expiry, settlementDelay: 60, maxPriceLag: 120, fallbackDelay: 0,
            maxConfBps: 0, feeBps: 0, priceDecimals: 8, admin: address(this)
        }), address(this));
        vault.split(seriesId, 5e8);
        MarketRipPool.AddPositionParams memory a = MarketRipPool.AddPositionParams({
            batchId: batchId, stock: address(stock), direction: MarketRipPool.Direction.UP,
            claimId: vault.nId(seriesId), spotAtCreation: 100e8, unitsPerRip: 1e8,
            quoteValidUntil: uint64(block.timestamp + 5 minutes), quoteRef: bytes32("up-quote")
        });
        vm.chainId(8453);
        vm.expectRevert(MarketRipPool.InvalidTerms.selector);
        pool.addPosition(a); // this series has no fallback oracle
        vm.chainId(84532);
        pool.addPosition(a);
    }

    function test_rawSharePythSeriesIsRejected() public {
        MockB20Asset s = new MockB20Asset("Pyth stock", "PYS", 8, false);
        MockOracleAdapter pyth = new MockOracleAdapter(SettlementModel.RAW_SHARE);
        factory.setSettlementConfiguration(Factory.SettlementConfigurationParams({
            collateral: address(s), oracle: address(pyth), fallbackOracle: address(0),
            feedId: bytes32("PYS/USD"), settlementModel: SettlementModel.RAW_SHARE,
            fallbackDelay: 0, priceDecimals: 8
        }));
        s.mint(address(this), 5e8);
        s.approve(address(vault), type(uint256).max);
        uint256 seriesId = factory.createSeries(ErodoroVault.CreateSeriesParams({
            collateral: address(s), oracle: address(pyth), fallbackOracle: address(0),
            feeRecipient: address(this), feedId: bytes32("PYS/USD"), fallbackRequestId: bytes32(0),
            settlementModel: SettlementModel.RAW_SHARE, strike: 105e8, minSplitAmount: 0,
            maturity: expiry, settlementDelay: 60, maxPriceLag: 120, fallbackDelay: 0,
            maxConfBps: 100, feeBps: 0, priceDecimals: 8, admin: address(this)
        }), address(this));
        vault.split(seriesId, 5e8);
        uint256 claimId = vault.nId(seriesId);
        vm.expectRevert(MarketRipPool.InvalidTerms.selector);
        pool.addPosition(MarketRipPool.AddPositionParams({
            batchId: batchId, stock: address(s), direction: MarketRipPool.Direction.UP,
            claimId: claimId, spotAtCreation: 100e8, unitsPerRip: 1e8,
            quoteValidUntil: uint64(block.timestamp + 5 minutes), quoteRef: bytes32("pyth-quote")
        }));
    }

    function test_samePriceQuoteRefreshKeepsThePackHash() public {
        _tenUpMarkets();
        bytes32 hash = pool.upInventoryHash();
        vm.warp(block.timestamp + 1 minutes);
        pool.setQuote(packMarkets[0], 1e8, uint64(block.timestamp + 5 minutes), bytes32("refreshed"));
        assertEq(pool.upInventoryHash(), hash);
        vm.prank(buyer);
        pool.ripPack(hash);
    }

    // World ID gate: only verified humans buy, and each human has a cap per batch whichever wallet they use.

    function _gate(uint256 cap) internal returns (HumanRegistry registry) {
        registry = new HumanRegistry(address(this), address(this), address(0), cap);
        registry.setPool(address(pool), true);
        pool.setHumanGate(registry);
    }

    /// @dev The test contract is the registry's forwarder, standing in for the CRE verify-human workflow.
    function _verify(HumanRegistry registry, address wallet, uint256 nullifier) internal {
        registry.onReport("", abi.encode(wallet, nullifier));
    }

    function test_humanGateRejectsUnverifiedBuyer() public {
        _gate(0);
        (uint256 positionId,) = _addUp();
        _fillOtherNine();
        MarketRipPool.Position memory p = pool.position(positionId);
        vm.prank(buyer);
        vm.expectRevert(abi.encodeWithSelector(HumanRegistry.NotVerified.selector, buyer));
        pool.buyPosition(positionId, 1, p.unitsPerRip, p.quoteRef);
    }

    function test_humanCapHoldsAcrossWallets() public {
        HumanRegistry registry = _gate(2e6);
        (uint256 positionId,) = _addUp();
        _fillOtherNine();
        MarketRipPool.Position memory p = pool.position(positionId);
        _verify(registry, buyer, 42);
        vm.prank(buyer);
        pool.buyPosition(positionId, 2, p.unitsPerRip, p.quoteRef);
        assertEq(registry.remainingSpend(buyer, address(pool), batchId), 0);

        // The same human verifies a second wallet: access moves to it, but the cap doesn't reset.
        address second = address(0xB0B2);
        usdc.mint(second, 5e6);
        vm.prank(second);
        usdc.approve(address(pool), type(uint256).max);
        _verify(registry, second, 42);
        assertFalse(registry.isVerified(buyer));
        vm.prank(second);
        vm.expectRevert(abi.encodeWithSelector(HumanRegistry.HumanCapReached.selector, second, 0));
        pool.buyPosition(positionId, 1, p.unitsPerRip, p.quoteRef);

        // A different human still has their own allowance.
        address other = address(0xB0B3);
        usdc.mint(other, 5e6);
        vm.prank(other);
        usdc.approve(address(pool), type(uint256).max);
        _verify(registry, other, 43);
        vm.prank(other);
        pool.buyPosition(positionId, 1, p.unitsPerRip, p.quoteRef);
    }

    function test_humanGateOnlyCountsRegisteredPools() public {
        HumanRegistry registry = _gate(0);
        _verify(registry, buyer, 42);
        vm.expectRevert(abi.encodeWithSelector(HumanRegistry.NotPool.selector, address(this)));
        registry.recordPurchase(buyer, batchId, 1e6);
    }

    function test_bannedHumanCannotVerifyAgain() public {
        HumanRegistry registry = _gate(0);
        _verify(registry, buyer, 7);
        registry.ban(buyer);
        assertFalse(registry.isVerified(buyer));
        vm.expectRevert(abi.encodeWithSelector(HumanRegistry.Banned.selector, 7));
        _verify(registry, address(0xB0B3), 7);
    }

    function test_onlyErodoroSetsHumanGate() public {
        HumanRegistry registry = new HumanRegistry(address(this), address(this), address(0), 0);
        vm.prank(buyer);
        vm.expectRevert(MarketRipPool.Unauthorized.selector);
        pool.setHumanGate(registry);
    }

    function test_shortBatchesOnlyOnBaseSepolia() public {
        vm.expectRevert(MarketRipPool.InvalidTerms.selector);
        pool.createBatch(uint64(block.timestamp + 1 hours));
        vm.chainId(84532);
        pool.createBatch(uint64(block.timestamp + 1 hours));
    }
}
