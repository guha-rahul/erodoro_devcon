// SPDX-License-Identifier: Apache-2.0
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {IB20} from "base-std/interfaces/IB20.sol";

import {ErodoroVault} from "../../src/ErodoroVault.sol";
import {ErodoroRFQ} from "../../src/ErodoroRFQ.sol";
import {Factory} from "../../src/Factory.sol";
import {PythAdapter} from "../../src/oracle/PythAdapter.sol";
import {IPythUnique} from "../../src/oracle/IPythUnique.sol";
import {SettlementModel} from "../../src/oracle/SettlementModel.sol";
import {TestFaucet} from "../../src/periphery/TestFaucet.sol";
import {TestQuoteToken} from "../../src/periphery/TestQuoteToken.sol";
import {MockB20Asset} from "../harness/MockB20Asset.sol";
import {MockPythUnique} from "../harness/MockPythUnique.sol";

/// @notice The complete local pilot with the seller, maker and settlement
///         caller kept as separate accounts.
contract PilotLifecycleTest is Test {
    uint256 private constant MAKER_KEY = 0xB0B5;
    address private seller = address(0x5E11E4);
    address private maker;
    address private settler = address(0x5E771E);
    address private governor = address(0x60A);

    // The literal is shorter than 32 bytes, so this conversion cannot truncate.
    // forge-lint: disable-next-line(unsafe-typecast)
    bytes32 private constant FEED = bytes32("AAPLc/USD");
    uint256 private constant TEN_SHARES = 10e8;
    uint256 private constant PREMIUM = 61_500_000;
    uint64 private constant SETTLEMENT_DELAY = 300;
    uint64 private constant MAX_LAG = 60;

    MockB20Asset private stock;
    TestQuoteToken private quoteToken;
    MockPythUnique private pyth;
    ErodoroVault private vault;
    ErodoroRFQ private rfq;
    Factory private factory;
    TestFaucet private faucet;
    uint64 private maturity;
    uint256 private seriesId;

    function setUp() public {
        vm.chainId(84532);
        vm.warp(1_700_000_000);
        maker = vm.addr(MAKER_KEY);

        stock = new MockB20Asset("Apple test stock", "tAAPLc", 8, false);
        quoteToken = new TestQuoteToken();
        pyth = new MockPythUnique(60, 1);
        PythAdapter adapter = new PythAdapter(IPythUnique(address(pyth)));
        vault = new ErodoroVault();
        rfq = new ErodoroRFQ();
        faucet = new TestFaucet(IB20(address(stock)), quoteToken, 20e8, 100_000e6, 1 days);
        factory = new Factory(
            vault,
            governor,
            Factory.Bounds({
                minHorizon: 0,
                maxHorizon: 365 days,
                minSettlementDelay: SETTLEMENT_DELAY,
                maxSettlementDelay: 1 days,
                minPriceLag: 1,
                maxPriceLag: 25 hours,
                maxConfBps: 500,
                maxFeeBps: 100,
                priceDecimals: 8
            })
        );

        vm.prank(governor);
        factory.setSettlementConfiguration(
            Factory.SettlementConfigurationParams({
                collateral: address(stock),
                oracle: address(adapter),
                fallbackOracle: address(0),
                feedId: FEED,
                settlementModel: SettlementModel.RAW_SHARE,
                fallbackDelay: 0,
                priceDecimals: 8
            })
        );

        maturity = uint64(block.timestamp + 1 days);
        vm.prank(seller);
        faucet.claim();
        vm.prank(maker);
        faucet.claim();

        vm.prank(seller);
        seriesId = factory.createSeries(
            ErodoroVault.CreateSeriesParams({
                collateral: address(stock),
                oracle: address(adapter),
                fallbackOracle: address(0),
                feeRecipient: seller,
                feedId: FEED,
                fallbackRequestId: bytes32(0),
                settlementModel: SettlementModel.RAW_SHARE,
                strike: 340e8,
                minSplitAmount: 0,
                maturity: maturity,
                settlementDelay: SETTLEMENT_DELAY,
                maxPriceLag: MAX_LAG,
                fallbackDelay: 0,
                maxConfBps: 500,
                feeBps: 0,
                priceDecimals: 8,
                admin: seller
            }),
            seller
        );
    }

    function test_faucetTradeFailuresSettlementAndSeparateRedemption() public {
        vm.startPrank(seller);
        stock.approve(address(vault), TEN_SHARES);
        vault.split(seriesId, TEN_SHARES);
        vault.setOperator(address(rfq), true);
        vm.stopPrank();

        vm.prank(maker);
        quoteToken.approve(address(rfq), type(uint256).max);
        ErodoroRFQ.Quote memory q = _quote(1, block.timestamp + 120);
        bytes memory signature = _sign(q);
        vm.prank(seller);
        rfq.fill(q, signature);

        assertEq(quoteToken.balanceOf(seller), 100_000e6 + PREMIUM);
        assertEq(vault.balanceOf(seller, vault.pId(seriesId)), TEN_SHARES);
        assertEq(vault.balanceOf(maker, vault.nId(seriesId)), TEN_SHARES);

        // A 2-for-1 split changes the raw share price from $400 to $200. The
        // adjusted strike preserves the same economics.
        stock.updateMultiplier(2e18);
        vm.warp(uint256(maturity) + SETTLEMENT_DELAY);

        bytes[] memory stale = _update(200e8, maturity - 1, 1e6);
        vm.deal(settler, 3);
        vm.prank(settler);
        vm.expectRevert();
        vault.settle{value: 1}(seriesId, stale);

        bytes[] memory wide = _update(200e8, maturity + 30, 20e8);
        vm.prank(settler);
        vm.expectRevert();
        vault.settle{value: 1}(seriesId, wide);

        bytes[] memory valid = _update(200e8, maturity + 30, 1e6);
        vm.prank(settler);
        vault.settle{value: 1}(seriesId, valid);
        assertTrue(vault.settlementOf(seriesId).settled);

        MockB20Asset.PausableFeature[] memory features = new MockB20Asset.PausableFeature[](1);
        features[0] = MockB20Asset.PausableFeature.TRANSFER;
        stock.pause(features);
        vm.prank(seller);
        vm.expectRevert(bytes("B20: transfers paused"));
        vault.redeem(seriesId, true, TEN_SHARES);
        stock.unpause(features);

        stock.setDenied(seller, true);
        vm.prank(seller);
        vm.expectRevert(bytes("B20: policy denied"));
        vault.redeem(seriesId, true, TEN_SHARES);
        stock.setDenied(seller, false);

        uint256 sellerBefore = stock.balanceOf(seller);
        vm.prank(seller);
        vault.redeem(seriesId, true, TEN_SHARES);
        assertGt(stock.balanceOf(seller), sellerBefore, "seller separately redeemed P");
        assertEq(vault.lockedOf(seriesId), vault.settlementOf(seriesId).nPool);

        uint256 makerBefore = stock.balanceOf(maker);
        vm.prank(maker);
        vault.redeem(seriesId, false, TEN_SHARES);
        assertGt(stock.balanceOf(maker), makerBefore, "maker separately redeemed N");
        assertEq(vault.lockedOf(seriesId), 0, "the complete pilot drained its collateral");
    }

    function test_expiredAndUnfundedQuotesAreRejected() public {
        vm.startPrank(seller);
        stock.approve(address(vault), TEN_SHARES);
        vault.split(seriesId, TEN_SHARES);
        vault.setOperator(address(rfq), true);
        vm.stopPrank();
        vm.prank(maker);
        quoteToken.approve(address(rfq), type(uint256).max);

        ErodoroRFQ.Quote memory expired = _quote(1, block.timestamp + 10);
        bytes memory expiredSignature = _sign(expired);
        vm.warp(block.timestamp + 11);
        vm.prank(seller);
        vm.expectRevert(abi.encodeWithSelector(ErodoroRFQ.QuoteExpired.selector, expired.expiry));
        rfq.fill(expired, expiredSignature);

        ErodoroRFQ.Quote memory unfunded = _quote(2, block.timestamp + 120);
        uint256 balance = quoteToken.balanceOf(maker);
        vm.prank(maker);
        assertTrue(quoteToken.transfer(address(0xDEAD), balance));
        (bool ok, string memory reason) = rfq.checkQuote(unfunded, _sign(unfunded), seller);
        assertFalse(ok);
        assertEq(reason, "Market maker is short of the quote token");
    }

    function _quote(uint256 nonce, uint256 expiry) private view returns (ErodoroRFQ.Quote memory) {
        return ErodoroRFQ.Quote({
            maker: maker,
            taker: seller,
            claims: address(vault),
            claimId: vault.nId(seriesId),
            claimAmount: TEN_SHARES,
            quoteToken: address(quoteToken),
            quoteAmount: PREMIUM,
            expiry: expiry,
            nonce: nonce
        });
    }

    function _sign(ErodoroRFQ.Quote memory q) private view returns (bytes memory) {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(MAKER_KEY, rfq.hashQuote(q));
        return abi.encodePacked(r, s, v);
    }

    function _update(int64 price, uint64 timestamp, uint64 confidence) private view returns (bytes[] memory data) {
        data = new bytes[](1);
        data[0] = pyth.createPriceFeedUpdateData(FEED, price, confidence, -8, price, confidence, timestamp);
    }
}
