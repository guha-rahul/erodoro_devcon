// SPDX-License-Identifier: Apache-2.0
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {MockPythUnique} from "../harness/MockPythUnique.sol";

import {ErodoroVault} from "../../src/ErodoroVault.sol";
import {ErodoroIntent} from "../../src/ErodoroIntent.sol";
import {PythAdapter} from "../../src/oracle/PythAdapter.sol";
import {IPythUnique} from "../../src/oracle/IPythUnique.sol";
import {SettlementModel} from "../../src/oracle/SettlementModel.sol";
import {TestQuoteToken} from "../../src/periphery/TestQuoteToken.sol";
import {Errors} from "../../src/libraries/Errors.sol";
import {MockB20Asset} from "../harness/MockB20Asset.sol";

contract ErodoroIntentTest is Test {
    MockB20Asset collateral;
    TestQuoteToken usdc;
    MockPythUnique pyth;
    PythAdapter adapter;
    ErodoroVault vault;
    ErodoroIntent intent;

    uint256 sellerKey = 0x5E11E4;
    address seller;
    address buyer = address(0xB0B);
    address other = address(0xBEEF);

    uint256 constant TEN = 10e8;
    uint256 constant FLOOR = 50_000_000; // 50 USDC floor for 10 N
    uint256 id;
    uint256 nid;
    uint256 strike = 340 * 1e8;
    uint64 maturity;

    function setUp() public {
        vm.chainId(84532);
        vm.warp(1_700_000_000);
        seller = vm.addr(sellerKey);

        collateral = new MockB20Asset("Apple", "AAPLc", 8, false);
        usdc = new TestQuoteToken();
        pyth = new MockPythUnique(60, 1);
        adapter = new PythAdapter(IPythUnique(address(pyth)));
        vault = new ErodoroVault();
        intent = new ErodoroIntent();

        maturity = uint64(block.timestamp + 30 days);
        collateral.mint(seller, 100e8);
        usdc.mint(buyer, 100_000e6);

        vm.prank(buyer);
        usdc.approve(address(intent), type(uint256).max);

        vm.startPrank(seller);
        collateral.approve(address(vault), type(uint256).max);
        id = vault.createSeries(
            ErodoroVault.CreateSeriesParams({
                collateral: address(collateral),
                oracle: address(adapter),
                fallbackOracle: address(0),
                feeRecipient: seller,
                feedId: bytes32("AAPLc/USD"),
                fallbackRequestId: bytes32(0),
                settlementModel: SettlementModel.RAW_SHARE,
                strike: strike,
                minSplitAmount: 0,
                maturity: maturity,
                settlementDelay: 300,
                maxPriceLag: 60,
                fallbackDelay: 0,
                maxConfBps: 500,
                feeBps: 0,
                priceDecimals: 8,
                admin: seller
            })
        );
        vault.split(id, TEN);
        vault.setOperator(address(intent), true);
        vm.stopPrank();
        nid = vault.nId(id);
    }

    function _intent(uint256 nonce) internal view returns (ErodoroIntent.SellIntent memory) {
        return ErodoroIntent.SellIntent({
            seller: seller,
            claims: address(vault),
            claimId: nid,
            collateral: address(collateral),
            strike: strike,
            maturity: maturity,
            claimAmount: TEN,
            quoteToken: address(usdc),
            minPremium: FLOOR,
            nonce: nonce,
            validFrom: block.timestamp - 1,
            validUntil: block.timestamp + 3600,
            allowPartial: false,
            allowRollover: false
        });
    }

    function _sign(ErodoroIntent.SellIntent memory i) internal view returns (bytes memory) {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(sellerKey, intent.hashIntent(i));
        return abi.encodePacked(r, s, v);
    }

    /// FLOW A — immediate full fill: buyer pays floor, gets N, seller keeps P.
    function test_fullFillMovesNAndPremium() public {
        ErodoroIntent.SellIntent memory i = _intent(1);
        bytes memory sig = _sign(i);
        (bool ok, string memory why) = intent.checkIntent(i, sig, TEN, FLOOR, buyer);
        assertTrue(ok, why);

        vm.prank(buyer);
        intent.fillIntent(i, sig, TEN, FLOOR);

        assertEq(usdc.balanceOf(seller), FLOOR, "seller paid floor");
        assertEq(vault.balanceOf(buyer, nid), TEN, "buyer holds upside");
        assertEq(vault.balanceOf(seller, nid), 0, "seller gave up upside");
        assertEq(vault.balanceOf(seller, vault.pId(id)), TEN, "seller keeps P");
        assertEq(usdc.balanceOf(address(intent)), 0, "conduit holds nothing");
    }

    /// FLOW E — malicious low bid below floor cannot settle.
    function test_lowBidReverts() public {
        ErodoroIntent.SellIntent memory i = _intent(1);
        bytes memory sig = _sign(i);
        (bool ok,) = intent.checkIntent(i, sig, TEN, FLOOR - 1, buyer);
        assertFalse(ok, "below-floor must fail check");
        vm.prank(buyer);
        vm.expectRevert(
            abi.encodeWithSelector(ErodoroIntent.PremiumBelowFloor.selector, FLOOR - 1, FLOOR)
        );
        intent.fillIntent(i, sig, TEN, FLOOR - 1);
    }

    /// FLOW F — replay: same intent cannot settle twice.
    function test_replayReverts() public {
        ErodoroIntent.SellIntent memory i = _intent(1);
        bytes memory sig = _sign(i);
        vm.prank(buyer);
        intent.fillIntent(i, sig, TEN, FLOOR);
        vm.prank(buyer);
        vm.expectRevert(abi.encodeWithSelector(ErodoroIntent.IntentAlreadyUsed.selector, uint256(1)));
        intent.fillIntent(i, sig, TEN, FLOOR);
    }

    /// FLOW D — cancelled intent cannot settle.
    function test_cancelledIntentCannotSettle() public {
        ErodoroIntent.SellIntent memory i = _intent(1);
        bytes memory sig = _sign(i);
        vm.prank(seller);
        intent.cancelIntent(i);
        (bool ok,) = intent.checkIntent(i, sig, TEN, FLOOR, buyer);
        assertFalse(ok);
        vm.prank(buyer);
        vm.expectRevert(abi.encodeWithSelector(ErodoroIntent.IntentAlreadyUsed.selector, uint256(1)));
        intent.fillIntent(i, sig, TEN, FLOOR);
    }

    function test_unauthorizedCancelReverts() public {
        ErodoroIntent.SellIntent memory i = _intent(1);
        vm.prank(other);
        vm.expectRevert(ErodoroIntent.UnauthorizedCancel.selector);
        intent.cancelIntent(i);
    }

    function test_expiredIntentReverts() public {
        ErodoroIntent.SellIntent memory i = _intent(1);
        i.validUntil = block.timestamp + 60;
        bytes memory sig = _sign(i);
        vm.warp(block.timestamp + 61);
        vm.prank(buyer);
        vm.expectRevert(abi.encodeWithSelector(ErodoroIntent.IntentExpired.selector, i.validUntil));
        intent.fillIntent(i, sig, TEN, FLOOR);
    }

    function test_notYetActiveReverts() public {
        ErodoroIntent.SellIntent memory i = _intent(1);
        i.validFrom = block.timestamp + 60;
        bytes memory sig = _sign(i);
        vm.prank(buyer);
        vm.expectRevert(abi.encodeWithSelector(ErodoroIntent.IntentNotActive.selector, i.validFrom));
        intent.fillIntent(i, sig, TEN, FLOOR);
    }

    /// Tampering with the floor breaks the seller signature.
    function test_tamperedFloorRejected() public {
        ErodoroIntent.SellIntent memory i = _intent(1);
        bytes memory sig = _sign(i);
        i.minPremium = FLOOR * 2;
        vm.prank(buyer);
        vm.expectRevert(ErodoroIntent.BadSignature.selector);
        intent.fillIntent(i, sig, TEN, FLOOR * 2);
    }

    /// Terms bound to the series: wrong strike cannot settle.
    function test_wrongStrikeRejected() public {
        ErodoroIntent.SellIntent memory i = _intent(1);
        i.strike = strike + 1;
        bytes memory sig = _sign(i);
        vm.prank(buyer);
        vm.expectRevert(ErodoroIntent.SeriesMismatch.selector);
        intent.fillIntent(i, sig, TEN, FLOOR);
    }

    /// Only N claims may be listed.
    function test_pClaimRejected() public {
        ErodoroIntent.SellIntent memory i = _intent(1);
        i.claimId = vault.pId(id);
        bytes memory sig = _sign(i);
        vm.prank(buyer);
        vm.expectRevert(abi.encodeWithSelector(ErodoroIntent.NotNClaim.selector, vault.pId(id)));
        intent.fillIntent(i, sig, TEN, FLOOR);
    }

    /// Fill-or-kill by default: partial amount reverts.
    function test_partialFillRequiresFlag() public {
        ErodoroIntent.SellIntent memory i = _intent(1);
        bytes memory sig = _sign(i);
        vm.prank(buyer);
        vm.expectRevert(ErodoroIntent.PartialNotAllowed.selector);
        intent.fillIntent(i, sig, TEN / 2, FLOOR / 2);
    }

    /// Partial fills pro-rate the floor with ceiling division.
    function test_partialFillProratesFloorUp() public {
        ErodoroIntent.SellIntent memory i = _intent(1);
        i.allowPartial = true;
        bytes memory sig = _sign(i);
        // 1/3 of size against a floor of 50_000_000 needs ceil -> 16_666_667.
        uint256 amt = 333333333; // not an even split of 1e9
        uint256 required = (FLOOR * amt + TEN - 1) / TEN;
        assertEq(required, 16666667, "ceiling division");
        vm.prank(buyer);
        vm.expectRevert(
            abi.encodeWithSelector(ErodoroIntent.PremiumBelowFloor.selector, required - 1, required)
        );
        intent.fillIntent(i, sig, amt, required - 1);

        vm.prank(buyer);
        intent.fillIntent(i, sig, amt, required);
        assertEq(vault.balanceOf(buyer, nid), amt);
        // Remainder still fillable; nonce burns only on completion.
        uint256 rest = TEN - amt;
        uint256 requiredRest = (FLOOR * rest + TEN - 1) / TEN;
        vm.prank(buyer);
        intent.fillIntent(i, sig, rest, requiredRest);
        assertEq(usdc.balanceOf(seller), required + requiredRest, "seller got >= floor total");
        assertGe(usdc.balanceOf(seller), FLOOR, "partials never shave the floor");
    }

    function test_overfillReverts() public {
        ErodoroIntent.SellIntent memory i = _intent(1);
        i.allowPartial = true;
        bytes memory sig = _sign(i);
        vm.prank(buyer);
        vm.expectRevert(
            abi.encodeWithSelector(ErodoroIntent.Overfill.selector, TEN + 1, TEN)
        );
        intent.fillIntent(i, sig, TEN + 1, FLOOR + 1);
    }

    function test_zeroAmountsRevert() public {
        ErodoroIntent.SellIntent memory i = _intent(1);
        bytes memory sig = _sign(i);
        vm.prank(buyer);
        vm.expectRevert(Errors.InvalidAmount.selector);
        intent.fillIntent(i, sig, 0, FLOOR);
    }
}
