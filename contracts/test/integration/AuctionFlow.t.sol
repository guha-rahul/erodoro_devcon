// SPDX-License-Identifier: Apache-2.0
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";

import {ErodoroVault} from "../../src/ErodoroVault.sol";
import {ErodoroIntent} from "../../src/ErodoroIntent.sol";
import {PythAdapter} from "../../src/oracle/PythAdapter.sol";
import {IPythUnique} from "../../src/oracle/IPythUnique.sol";
import {SettlementModel} from "../../src/oracle/SettlementModel.sol";
import {TestQuoteToken} from "../../src/periphery/TestQuoteToken.sol";
import {MockB20Asset} from "../harness/MockB20Asset.sol";
import {MockPythUnique} from "../harness/MockPythUnique.sol";

/// @notice End-to-end intent lifecycle: split -> sign -> fill -> mature -> redeem.
///         Flows mirror the product definition (A-J); the auction-timing half
///         (fast/discovery windows, exclusivity failover) is covered in
///         cloudflare/auction*.test.mjs — this file proves the on-chain half.
contract AuctionFlowTest is Test {
    uint256 private constant SELLER_KEY = 0x5E11E4;
    address private seller;
    address private buyer = address(0xB0B);
    address private buyer2 = address(0xB0B2);
    address private settler = address(0x5E771E);

    // forge-lint: disable-next-line(unsafe-typecast)
    bytes32 private constant FEED = bytes32("AAPLc/USD");
    uint256 private constant TEN = 10e8;
    uint256 private constant FLOOR = 50_000_000;
    uint256 private constant STRIKE = 340e8;

    MockB20Asset private stock;
    TestQuoteToken private usdc;
    MockPythUnique private pyth;
    PythAdapter private adapter;
    ErodoroVault private vault;
    ErodoroIntent private intent;
    uint64 private maturity;
    uint256 private seriesId;
    uint256 private nid;

    function setUp() public {
        vm.chainId(84532);
        vm.warp(1_700_000_000);
        seller = vm.addr(SELLER_KEY);

        stock = new MockB20Asset("Apple test stock", "tAAPLc", 8, false);
        usdc = new TestQuoteToken();
        pyth = new MockPythUnique(60, 1);
        adapter = new PythAdapter(IPythUnique(address(pyth)));
        vault = new ErodoroVault();
        intent = new ErodoroIntent();

        maturity = uint64(block.timestamp + 1 days);
        stock.mint(seller, 100e8);
        usdc.mint(buyer, 100_000e6);
        usdc.mint(buyer2, 100_000e6);

        vm.prank(buyer);
        usdc.approve(address(intent), type(uint256).max);
        vm.prank(buyer2);
        usdc.approve(address(intent), type(uint256).max);

        vm.startPrank(seller);
        stock.approve(address(vault), type(uint256).max);
        seriesId = vault.createSeries(
            ErodoroVault.CreateSeriesParams({
                collateral: address(stock),
                oracle: address(adapter),
                fallbackOracle: address(0),
                feeRecipient: seller,
                feedId: FEED,
                fallbackRequestId: bytes32(0),
                settlementModel: SettlementModel.RAW_SHARE,
                strike: STRIKE,
                minSplitAmount: 0,
                maturity: maturity,
                settlementDelay: 300,
                maxPriceLag: 3600,
                fallbackDelay: 0,
                maxConfBps: 500,
                feeBps: 0,
                priceDecimals: 8,
                admin: seller
            })
        );
        vault.split(seriesId, TEN);
        vault.setOperator(address(intent), true);
        vm.stopPrank();
        nid = vault.nId(seriesId);
    }

    function _intent(uint256 nonce, bool allowPartialFill) internal view returns (ErodoroIntent.SellIntent memory) {
        return ErodoroIntent.SellIntent({
            seller: seller,
            claims: address(vault),
            claimId: nid,
            collateral: address(stock),
            strike: STRIKE,
            maturity: maturity,
            claimAmount: TEN,
            quoteToken: address(usdc),
            minPremium: FLOOR,
            nonce: nonce,
            validFrom: block.timestamp - 1,
            validUntil: block.timestamp + 3600,
            allowPartial: allowPartialFill,
            allowRollover: false
        });
    }

    function _sign(ErodoroIntent.SellIntent memory i) internal view returns (bytes memory) {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(SELLER_KEY, intent.hashIntent(i));
        return abi.encodePacked(r, s, v);
    }

    function _update(int64 price, uint64 timestamp) internal view returns (bytes[] memory data) {
        data = new bytes[](1);
        data[0] = pyth.createPriceFeedUpdateData(FEED, price, 1e6, -8, price, 1e6, timestamp);
    }

    /// FLOW A — writer signs, buyer bids floor, settles: N->buyer, USDC->seller, P retained.
    function test_flowA_immediateFill() public {
        ErodoroIntent.SellIntent memory i = _intent(1, false);
        bytes memory sig = _sign(i);
        vm.prank(buyer);
        intent.fillIntent(i, sig, TEN, FLOOR);
        assertEq(usdc.balanceOf(seller), FLOOR);
        assertEq(vault.balanceOf(buyer, nid), TEN);
        assertEq(vault.balanceOf(seller, vault.pId(seriesId)), TEN, "capped claim remains");
    }

    /// FLOW B/J — first buyer takes half then disappears; second buyer takes rest.
    function test_flowBJ_partialThenRemainder() public {
        ErodoroIntent.SellIntent memory i = _intent(1, true);
        bytes memory sig = _sign(i);
        uint256 half = TEN / 2;
        uint256 reqHalf = (FLOOR * half + TEN - 1) / TEN;
        vm.prank(buyer);
        intent.fillIntent(i, sig, half, reqHalf);
        assertEq(vault.balanceOf(buyer, nid), half);
        uint256 rest = TEN - half;
        uint256 reqRest = (FLOOR * rest + TEN - 1) / TEN;
        vm.prank(buyer2);
        intent.fillIntent(i, sig, rest, reqRest);
        assertEq(vault.balanceOf(buyer2, nid), rest);
        assertGe(usdc.balanceOf(seller), FLOOR);
    }

    /// FLOW C — no bids: seller still holds P+N and can merge back. No loss.
    function test_flowC_neverFilledIsRecoverable() public {
        assertEq(vault.balanceOf(seller, nid), TEN);
        assertEq(vault.balanceOf(seller, vault.pId(seriesId)), TEN);
        vm.prank(seller);
        vault.merge(seriesId, TEN);
        assertEq(stock.balanceOf(seller), 100e8, "full collateral recovered");
    }

    /// FLOW D — cancelled intent rejects a stale settlement.
    function test_flowD_cancelBlocksStaleSettlement() public {
        ErodoroIntent.SellIntent memory i = _intent(1, false);
        bytes memory sig = _sign(i);
        vm.prank(seller);
        intent.cancelIntent(i);
        vm.prank(buyer);
        vm.expectRevert(abi.encodeWithSelector(ErodoroIntent.IntentAlreadyUsed.selector, uint256(1)));
        intent.fillIntent(i, sig, TEN, FLOOR);
    }

    /// FLOW E/F — low bid reverts; replay reverts.
    function test_flowEF_lowBidAndReplay() public {
        ErodoroIntent.SellIntent memory i = _intent(1, false);
        bytes memory sig = _sign(i);
        vm.prank(buyer);
        vm.expectRevert(
            abi.encodeWithSelector(ErodoroIntent.PremiumBelowFloor.selector, FLOOR - 1, FLOOR)
        );
        intent.fillIntent(i, sig, TEN, FLOOR - 1);
        vm.prank(buyer);
        intent.fillIntent(i, sig, TEN, FLOOR);
        vm.prank(buyer2);
        vm.expectRevert(abi.encodeWithSelector(ErodoroIntent.IntentAlreadyUsed.selector, uint256(1)));
        intent.fillIntent(i, sig, TEN, FLOOR);
    }

    /// FLOW H — spot below strike: P redeems everything, N nothing.
    function test_flowH_maturityBelowStrike() public {
        _fillAndSettle(250e8);
        (uint256 pPool, uint256 nPool) = _pools();
        assertEq(nPool, 0, "upside expires worthless below strike");
        assertEq(pPool, TEN, "capped side keeps all collateral");
        _redeemAndCheckConservation();
    }

    /// Spot exactly at strike: same as below.
    function test_maturityAtStrike() public {
        _fillAndSettle(340e8);
        (uint256 pPool, uint256 nPool) = _pools();
        assertEq(nPool, 0, "at-the-money upside is worthless");
        assertEq(pPool, TEN);
        _redeemAndCheckConservation();
    }

    /// FLOW I — spot above strike: value splits, conservation holds.
    function test_flowI_maturityAboveStrike() public {
        _fillAndSettle(500e8);
        (uint256 pPool, uint256 nPool) = _pools();
        assertGt(nPool, 0, "upside pays above strike");
        assertLt(pPool, TEN, "capped side gives up the upside");
        assertEq(pPool + nPool, TEN, "conservation of collateral");
        _redeemAndCheckConservation();
    }

    // --- Helpers -----------------------------------------------------------

    function _fillAndSettle(int64 price) internal {
        ErodoroIntent.SellIntent memory i = _intent(1, false);
        bytes memory sig = _sign(i);
        vm.prank(buyer);
        intent.fillIntent(i, sig, TEN, FLOOR);
        vm.warp(uint256(maturity) + 300);
        vm.deal(settler, 3);
        vm.prank(settler);
        vault.settle{value: 1}(seriesId, _update(price, maturity + 30));
        assertTrue(vault.settlementOf(seriesId).settled, "series settled");
    }

    function _pools() internal view returns (uint256 pPool, uint256 nPool) {
        pPool = vault.settlementOf(seriesId).pPool;
        nPool = vault.settlementOf(seriesId).nPool;
    }

    /// Both sides redeem; vault drains; no double redemption.
    function _redeemAndCheckConservation() internal {
        uint256 sellerBefore = stock.balanceOf(seller);
        uint256 buyerBefore = stock.balanceOf(buyer);
        vm.prank(seller);
        vault.redeem(seriesId, true, TEN);
        vm.prank(buyer);
        vault.redeem(seriesId, false, TEN);
        assertGt(stock.balanceOf(seller), sellerBefore);
        assertGe(stock.balanceOf(buyer), buyerBefore);
        assertEq(vault.lockedOf(seriesId), 0, "vault drained");
        vm.prank(seller);
        vm.expectRevert();
        vault.redeem(seriesId, true, 1);
    }
}
