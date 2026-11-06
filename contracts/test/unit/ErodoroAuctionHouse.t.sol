// SPDX-License-Identifier: Apache-2.0
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

import {ErodoroVault} from "../../src/ErodoroVault.sol";
import {ErodoroAuctionHouse} from "../../src/ErodoroAuctionHouse.sol";
import {PythAdapter} from "../../src/oracle/PythAdapter.sol";
import {IPythUnique} from "../../src/oracle/IPythUnique.sol";
import {SettlementModel} from "../../src/oracle/SettlementModel.sol";
import {TestQuoteToken} from "../../src/periphery/TestQuoteToken.sol";
import {MockB20Asset} from "../harness/MockB20Asset.sol";
import {MockPythUnique} from "../harness/MockPythUnique.sol";

contract ErodoroAuctionHouseTest is Test {
    MockB20Asset private stock;
    TestQuoteToken private usdc;
    MockPythUnique private pyth;
    PythAdapter private adapter;
    ErodoroVault private vault;
    ErodoroAuctionHouse private house;

    address private seller = address(0x5E11E4);
    address private buyer = address(0xB0B);
    address private buyer2 = address(0xB0B2);
    address private keeper = address(0x5EE9);
    /// @dev The EIP-3009 tests sign for this key; `buyer` is its address.
    uint256 private buyerKey = 0xA11CE;

    uint256 private constant TEN = 10e8;
    uint256 private constant SPLIT = 40e8;
    uint256 private constant FLOOR = 50_000_000; // 50 tUSDC for 10 N
    uint64 private constant DURATION = 600;
    uint16 private constant FEE_BPS = 200; // 2%

    uint256 private seriesId;
    uint256 private nid;
    uint256 private strike = 340e8;
    uint64 private maturity;

    function setUp() public {
        vm.chainId(84532);
        vm.warp(1_700_000_000);
        buyer = vm.addr(buyerKey);

        stock = new MockB20Asset("Apple test stock", "tAAPLc", 8, false);
        usdc = new TestQuoteToken();
        pyth = new MockPythUnique(60, 1);
        adapter = new PythAdapter(IPythUnique(address(pyth)));
        vault = new ErodoroVault();
        house = new ErodoroAuctionHouse(seller, seller, IERC20(address(usdc)), FEE_BPS);

        maturity = uint64(block.timestamp + 30 days);
        stock.mint(seller, 400e8);
        usdc.mint(buyer, 100_000e6);
        usdc.mint(buyer2, 100_000e6);

        vm.prank(buyer);
        usdc.approve(address(house), type(uint256).max);
        vm.prank(buyer2);
        usdc.approve(address(house), type(uint256).max);

        vm.startPrank(seller);
        stock.approve(address(vault), type(uint256).max);
        seriesId = vault.createSeries(
            ErodoroVault.CreateSeriesParams({
                collateral: address(stock),
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
        vault.split(seriesId, SPLIT);
        vault.setOperator(address(house), true);
        vm.stopPrank();
        nid = vault.nId(seriesId);
    }

    function _create(uint256 quantity, uint256 floor, bool allowRollover) internal returns (uint256 id) {
        vm.prank(seller);
        id = house.createAuction(
            ErodoroAuctionHouse.CreateParams({
                claims: address(vault),
                claimId: nid,
                quantity: quantity,
                floor: floor,
                durationSeconds: DURATION,
                allowRollover: allowRollover
            })
        );
    }

    function _bid(address bidder, uint256 id, uint256 amount, uint256 premium) internal {
        vm.prank(bidder);
        house.placeBid(id, amount, premium);
    }

    // --- Creation / escrow ---------------------------------------------------

    function test_createEscrowsNandEnumerates() public {
        uint256 id = _create(TEN, FLOOR, false);
        assertEq(id, 0);
        assertEq(vault.balanceOf(address(house), nid), TEN, "N escrowed in the house");
        assertEq(vault.balanceOf(seller, nid), SPLIT - TEN, "seller gave up N");
        assertEq(house.auctionCount(), 1);

        ErodoroAuctionHouse.Auction memory a = house.getAuction(id);
        assertEq(a.seller, seller);
        assertEq(a.quantity, TEN);
        assertEq(a.floor, FLOOR);
        assertEq(a.startTime, uint64(block.timestamp));
        assertEq(a.endTime, uint64(block.timestamp) + DURATION);
        assertFalse(a.allowRollover);
        assertTrue(house.isLive(id));
        assertTrue(house.isActive(id));
        assertEq(house.auctionsOfSeller(seller).length, 1);
    }

    function test_createRejectsPClaim() public {
        uint256 pid = vault.pId(seriesId);
        vm.prank(seller);
        vm.expectRevert(abi.encodeWithSelector(ErodoroAuctionHouse.NotAnNClaim.selector, pid));
        house.createAuction(
            ErodoroAuctionHouse.CreateParams({
                claims: address(vault),
                claimId: pid,
                quantity: TEN,
                floor: FLOOR,
                durationSeconds: DURATION,
                allowRollover: false
            })
        );
    }

    function test_createRejectsBadDuration() public {
        vm.prank(seller);
        vm.expectRevert(abi.encodeWithSelector(ErodoroAuctionHouse.BadDuration.selector, uint64(10)));
        house.createAuction(
            ErodoroAuctionHouse.CreateParams({
                claims: address(vault),
                claimId: nid,
                quantity: TEN,
                floor: FLOOR,
                durationSeconds: 10,
                allowRollover: false
            })
        );
    }

    function test_createRejectsClosedSeries() public {
        vm.warp(uint256(maturity) + 1);
        vm.prank(seller);
        vm.expectRevert(ErodoroAuctionHouse.SeriesClosed.selector);
        house.createAuction(
            ErodoroAuctionHouse.CreateParams({
                claims: address(vault),
                claimId: nid,
                quantity: TEN,
                floor: FLOOR,
                durationSeconds: DURATION,
                allowRollover: false
            })
        );
    }

    function test_createRejectsUnknownSeries() public {
        vm.prank(seller);
        vm.expectRevert();
        house.createAuction(
            ErodoroAuctionHouse.CreateParams({
                claims: address(0xDEAD),
                claimId: nid,
                quantity: TEN,
                floor: FLOOR,
                durationSeconds: DURATION,
                allowRollover: false
            })
        );
    }

    // --- Bidding -------------------------------------------------------------

    function test_bidBelowFloorReverts() public {
        uint256 id = _create(TEN, FLOOR, false);
        vm.prank(buyer);
        vm.expectRevert(abi.encodeWithSelector(ErodoroAuctionHouse.BidBelowFloor.selector, FLOOR - 1, FLOOR));
        house.placeBid(id, TEN, FLOOR - 1);
    }

    function test_partialBidReverts() public {
        uint256 id = _create(TEN, FLOOR, false);
        vm.prank(buyer);
        vm.expectRevert(abi.encodeWithSelector(ErodoroAuctionHouse.PartialFillNotAllowed.selector, TEN / 2, TEN));
        house.placeBid(id, TEN / 2, FLOOR);
    }

    function test_tiedBidReverts() public {
        uint256 id = _create(TEN, FLOOR, false);
        _bid(buyer, id, TEN, FLOOR);
        vm.prank(buyer2);
        vm.expectRevert(abi.encodeWithSelector(ErodoroAuctionHouse.BidNotBest.selector, FLOOR, FLOOR));
        house.placeBid(id, TEN, FLOOR);
    }

    function test_bidAfterCloseReverts() public {
        uint256 id = _create(TEN, FLOOR, false);
        vm.warp(block.timestamp + DURATION);
        vm.prank(buyer);
        vm.expectRevert(abi.encodeWithSelector(ErodoroAuctionHouse.AuctionClosed.selector, id));
        house.placeBid(id, TEN, FLOOR);
    }

    function test_outbidBecomesRefund() public {
        uint256 id = _create(TEN, FLOOR, false);
        _bid(buyer, id, TEN, FLOOR);
        uint256 higher = FLOOR + 5e6;
        _bid(buyer2, id, TEN, higher);

        assertEq(house.refundableOf(buyer), FLOOR, "displaced premium is withdrawable");
        assertEq(usdc.balanceOf(address(house)), FLOOR + higher, "house holds both premiums");

        uint256 before = usdc.balanceOf(buyer);
        vm.prank(buyer);
        house.withdrawRefund();
        assertEq(usdc.balanceOf(buyer), before + FLOOR, "refund paid");
        assertEq(house.refundableOf(buyer), 0);
    }

    function test_withdrawWithNothingReverts() public {
        vm.prank(buyer);
        vm.expectRevert(ErodoroAuctionHouse.NothingToRefund.selector);
        house.withdrawRefund();
    }

    function test_feeOnTransferQuoteRejected() public {
        FoTQuoteToken fot = new FoTQuoteToken();
        ErodoroAuctionHouse fotHouse = new ErodoroAuctionHouse(seller, seller, IERC20(address(fot)), 0);
        fot.mint(buyer, 1_000e6);
        vm.prank(buyer);
        fot.approve(address(fotHouse), type(uint256).max);
        vm.prank(seller);
        vault.setOperator(address(fotHouse), true);

        vm.prank(seller);
        uint256 id = fotHouse.createAuction(
            ErodoroAuctionHouse.CreateParams({
                claims: address(vault),
                claimId: nid,
                quantity: TEN,
                floor: FLOOR,
                durationSeconds: DURATION,
                allowRollover: false
            })
        );

        vm.prank(buyer);
        vm.expectRevert(
            abi.encodeWithSelector(ErodoroAuctionHouse.QuoteTransferShort.selector, FLOOR, FLOOR - FLOOR / 100)
        );
        fotHouse.placeBid(id, TEN, FLOOR);
    }

    // --- Finalize ------------------------------------------------------------

    function test_finalizeBeforeCloseReverts() public {
        uint256 id = _create(TEN, FLOOR, false);
        _bid(buyer, id, TEN, FLOOR);
        vm.expectRevert(abi.encodeWithSelector(ErodoroAuctionHouse.AuctionStillOpen.selector, id));
        house.finalizeAuction(id);
    }

    function test_finalizeNoBidReverts() public {
        uint256 id = _create(TEN, FLOOR, false);
        vm.warp(block.timestamp + DURATION);
        vm.expectRevert(abi.encodeWithSelector(ErodoroAuctionHouse.NoBid.selector, id));
        house.finalizeAuction(id);
    }

    function test_finalizeMovesNAndSplitsFee() public {
        uint256 id = _create(TEN, FLOOR, false);
        uint256 premium = 100e6;
        _bid(buyer, id, TEN, premium);
        vm.warp(block.timestamp + DURATION);

        uint256 sellerBefore = usdc.balanceOf(seller);
        // A stranger completes it: finalize is permissionless.
        vm.prank(keeper);
        house.finalizeAuction(id);

        uint256 fee = (premium * FEE_BPS + 9_999) / 10_000;
        uint256 proceeds = premium - fee;
        assertEq(vault.balanceOf(buyer, nid), TEN, "winner receives N");
        assertEq(vault.balanceOf(address(house), nid), 0, "house released escrow");
        // feeRecipient == seller in setUp, so the seller receives the full premium.
        assertEq(usdc.balanceOf(seller), sellerBefore + proceeds + fee, "seller and recipient paid");
        assertEq(usdc.balanceOf(address(house)), 0, "house holds no quote");
        assertTrue(house.getAuction(id).finalized);
        assertFalse(house.isActive(id));
    }

    function test_finalizeCannotRunTwice() public {
        uint256 id = _create(TEN, FLOOR, false);
        _bid(buyer, id, TEN, FLOOR);
        vm.warp(block.timestamp + DURATION);
        house.finalizeAuction(id);
        vm.expectRevert(abi.encodeWithSelector(ErodoroAuctionHouse.AuctionClosed.selector, id));
        house.finalizeAuction(id);
    }

    // --- Rollover / cancel ---------------------------------------------------

    function test_rolloverPermissionlessWhenAllowed() public {
        uint256 id = _create(TEN, FLOOR, true);
        vm.warp(block.timestamp + DURATION);
        uint64 expectedEnd = uint64(block.timestamp) + DURATION;
        vm.prank(keeper);
        house.rolloverAuction(id);

        ErodoroAuctionHouse.Auction memory a = house.getAuction(id);
        assertEq(a.startTime, uint64(block.timestamp));
        assertEq(a.endTime, expectedEnd);
        assertEq(a.rolloverCount, 1);
        assertTrue(house.isLive(id));
        assertEq(vault.balanceOf(address(house), nid), TEN, "N stays escrowed across rolls");
    }

    function test_rolloverNotAllowedReverts() public {
        uint256 id = _create(TEN, FLOOR, false);
        vm.warp(block.timestamp + DURATION);
        vm.expectRevert(abi.encodeWithSelector(ErodoroAuctionHouse.RolloverNotAllowed.selector, id));
        house.rolloverAuction(id);
    }

    function test_rolloverWithBidReverts() public {
        uint256 id = _create(TEN, FLOOR, true);
        _bid(buyer, id, TEN, FLOOR);
        vm.warp(block.timestamp + DURATION);
        vm.expectRevert(abi.encodeWithSelector(ErodoroAuctionHouse.AuctionHasBids.selector, id));
        house.rolloverAuction(id);
    }

    function test_cancelReturnsNtoSeller() public {
        uint256 id = _create(TEN, FLOOR, false);
        assertEq(vault.balanceOf(seller, nid), SPLIT - TEN);
        vm.prank(seller);
        house.cancelAuction(id);
        assertEq(vault.balanceOf(seller, nid), SPLIT, "N returned");
        assertEq(vault.balanceOf(address(house), nid), 0);
        assertTrue(house.getAuction(id).cancelled);
        assertFalse(house.isActive(id));
    }

    function test_cancelAfterCloseNoBidReturnsN() public {
        uint256 id = _create(TEN, FLOOR, false);
        vm.warp(block.timestamp + DURATION);
        vm.prank(seller);
        house.cancelAuction(id);
        assertEq(vault.balanceOf(seller, nid), SPLIT);
    }

    function test_cancelWithBidReverts() public {
        uint256 id = _create(TEN, FLOOR, false);
        _bid(buyer, id, TEN, FLOOR);
        vm.prank(seller);
        vm.expectRevert(abi.encodeWithSelector(ErodoroAuctionHouse.AuctionHasBids.selector, id));
        house.cancelAuction(id);
    }

    function test_cancelNotSellerReverts() public {
        uint256 id = _create(TEN, FLOOR, false);
        vm.prank(keeper);
        vm.expectRevert(abi.encodeWithSelector(ErodoroAuctionHouse.NotSeller.selector, id));
        house.cancelAuction(id);
    }

    // --- Enumeration ---------------------------------------------------------

    function test_getActiveAuctionsPagination() public {
        uint256 a0 = _create(TEN, FLOOR, false);
        uint256 a1 = _create(TEN, FLOOR + 1e6, false);
        uint256 a2 = _create(TEN, FLOOR + 2e6, false);

        // Close a1 by finalizing it.
        _bid(buyer, a1, TEN, FLOOR + 1e6);
        vm.warp(block.timestamp + DURATION);
        house.finalizeAuction(a1);

        (ErodoroAuctionHouse.Auction[] memory first, uint256 cursor) = house.getActiveAuctions(0, 2);
        assertEq(first.length, 2, "first page");
        assertEq(first[0].id, a0);
        assertEq(first[1].id, a2);
        assertEq(cursor, 3, "cursor reached the end");

        (ErodoroAuctionHouse.Auction[] memory second,) = house.getActiveAuctions(1, 5);
        assertEq(second.length, 1);
        assertEq(second[0].id, a2);
    }

    function test_activeExcludesFinalizedAndCancelled() public {
        uint256 a0 = _create(TEN, FLOOR, false);
        uint256 a1 = _create(TEN, FLOOR, false);
        vm.prank(seller);
        house.cancelAuction(a1);
        assertTrue(house.isActive(a0));
        assertFalse(house.isActive(a1));
        assertFalse(house.isLive(a1));
    }

    function test_getAuctionUnknownReverts() public {
        vm.expectRevert(abi.encodeWithSelector(ErodoroAuctionHouse.AuctionNotFound.selector, uint256(7)));
        house.getAuction(7);
    }

    // --- Admin ---------------------------------------------------------------

    function test_onlyAdminSetsFee() public {
        vm.prank(buyer);
        vm.expectRevert();
        house.setProtocolFee(100, buyer);
    }

    function test_feeCapEnforced() public {
        vm.prank(seller);
        vm.expectRevert(abi.encodeWithSelector(ErodoroAuctionHouse.FeeTooHigh.selector, uint16(1_001)));
        house.setProtocolFee(1_001, seller);
    }

    // --- EIP-3009 funded bids ------------------------------------------------

    function _authorize(
        address from,
        address to,
        uint256 value,
        uint256 validAfter,
        uint256 validBefore,
        bytes32 nonce,
        uint256 key
    ) internal view returns (uint8 v, bytes32 r, bytes32 s) {
        bytes32 structHash = keccak256(
            abi.encode(
                usdc.RECEIVE_WITH_AUTHORIZATION_TYPEHASH(), from, to, value, validAfter, validBefore, nonce
            )
        );
        bytes32 digest = keccak256(abi.encodePacked("\x19\x01", usdc.DOMAIN_SEPARATOR(), structHash));
        return vm.sign(key, digest);
    }

    function test_authorizationBidFundsAndTakesBest() public {
        uint256 id = _create(TEN, FLOOR, false);
        bytes32 nonce = keccak256("nonce-funded");
        uint256 validAfter = block.timestamp - 1;
        uint256 validBefore = block.timestamp + 15 minutes;
        (uint8 v, bytes32 r, bytes32 s) =
            _authorize(buyer, address(house), FLOOR, validAfter, validBefore, nonce, buyerKey);

        uint256 before = usdc.balanceOf(buyer);
        vm.prank(buyer);
        house.placeBidWithAuthorization(id, TEN, FLOOR, validAfter, validBefore, nonce, v, r, s);

        assertEq(usdc.balanceOf(buyer), before - FLOOR, "premium escrowed from the signer");
        assertEq(usdc.balanceOf(address(house)), FLOOR, "house holds the funded premium");
        assertEq(house.getAuction(id).bestBidder, buyer);
        assertTrue(usdc.authorizationState(buyer, nonce), "nonce burned");
        assertEq(uint256(house.bidStatus(id, buyer)), uint256(ErodoroAuctionHouse.BidStatus.Funded));
    }

    function test_authorizationAloneIsNotAFundedBid() public {
        uint256 id = _create(TEN, FLOOR, false);
        bytes32 nonce = keccak256("nonce-unsent");
        _authorize(buyer, address(house), FLOOR, block.timestamp - 1, block.timestamp + 15 minutes, nonce, buyerKey);

        // Signing moves nothing. EIP-3009 does not reserve the payer's balance,
        // so until the authorization is submitted the auction has no bidder.
        ErodoroAuctionHouse.Auction memory a = house.getAuction(id);
        assertEq(a.bestBidder, address(0));
        assertEq(a.bestPremium, 0);
        assertEq(uint256(house.bidStatus(id, buyer)), uint256(ErodoroAuctionHouse.BidStatus.None));
        assertFalse(usdc.authorizationState(buyer, nonce));
    }

    function test_authorizationRejectsExpiredWindow() public {
        uint256 id = _create(TEN, FLOOR, false);
        bytes32 nonce = keccak256("nonce-expired");
        uint256 validBefore = block.timestamp - 1;
        (uint8 v, bytes32 r, bytes32 s) = _authorize(buyer, address(house), FLOOR, 0, validBefore, nonce, buyerKey);

        vm.prank(buyer);
        vm.expectRevert(TestQuoteToken.AuthorizationExpired.selector);
        house.placeBidWithAuthorization(id, TEN, FLOOR, 0, validBefore, nonce, v, r, s);
    }

    function test_authorizationRejectsFutureWindow() public {
        uint256 id = _create(TEN, FLOOR, false);
        bytes32 nonce = keccak256("nonce-future");
        uint256 validAfter = block.timestamp + 60;
        uint256 validBefore = block.timestamp + 15 minutes;
        (uint8 v, bytes32 r, bytes32 s) =
            _authorize(buyer, address(house), FLOOR, validAfter, validBefore, nonce, buyerKey);

        vm.prank(buyer);
        vm.expectRevert(TestQuoteToken.AuthorizationNotYetValid.selector);
        house.placeBidWithAuthorization(id, TEN, FLOOR, validAfter, validBefore, nonce, v, r, s);
    }

    function test_authorizationNonceCannotBeReused() public {
        uint256 id = _create(TEN, FLOOR, false);
        bytes32 nonce = keccak256("nonce-reuse");
        uint256 validAfter = block.timestamp - 1;
        uint256 validBefore = block.timestamp + 15 minutes;
        (uint8 v, bytes32 r, bytes32 s) =
            _authorize(buyer, address(house), FLOOR, validAfter, validBefore, nonce, buyerKey);
        vm.prank(buyer);
        house.placeBidWithAuthorization(id, TEN, FLOOR, validAfter, validBefore, nonce, v, r, s);

        uint256 higher = FLOOR + 1e6;
        (v, r, s) = _authorize(buyer, address(house), higher, validAfter, validBefore, nonce, buyerKey);
        vm.prank(buyer);
        vm.expectRevert(TestQuoteToken.AuthorizationAlreadyUsed.selector);
        house.placeBidWithAuthorization(id, TEN, higher, validAfter, validBefore, nonce, v, r, s);
    }

    function test_authorizationRejectsWrongSigner() public {
        uint256 id = _create(TEN, FLOOR, false);
        bytes32 nonce = keccak256("nonce-wrong-signer");
        uint256 validAfter = block.timestamp - 1;
        uint256 validBefore = block.timestamp + 15 minutes;
        // Signed by a key that does not control `buyer`.
        (uint8 v, bytes32 r, bytes32 s) =
            _authorize(buyer, address(house), FLOOR, validAfter, validBefore, nonce, buyerKey + 1);

        vm.prank(buyer);
        vm.expectRevert(TestQuoteToken.InvalidSignature.selector);
        house.placeBidWithAuthorization(id, TEN, FLOOR, validAfter, validBefore, nonce, v, r, s);
    }

    function test_authorizationCannotBeFrontRunByAThirdParty() public {
        uint256 id = _create(TEN, FLOOR, false);
        bytes32 nonce = keccak256("nonce-frontrun");
        uint256 validAfter = block.timestamp - 1;
        uint256 validBefore = block.timestamp + 15 minutes;
        (uint8 v, bytes32 r, bytes32 s) =
            _authorize(buyer, address(house), FLOOR, validAfter, validBefore, nonce, buyerKey);

        // buyer2 submits buyer's signature; the house would pull from buyer2,
        // whose recovered signer is not buyer.
        vm.prank(buyer2);
        vm.expectRevert(TestQuoteToken.InvalidSignature.selector);
        house.placeBidWithAuthorization(id, TEN, FLOOR, validAfter, validBefore, nonce, v, r, s);
    }

    function test_authorizationBidCanBeOutbidAndRefunded() public {
        uint256 id = _create(TEN, FLOOR, false);
        bytes32 nonce = keccak256("nonce-outbid");
        uint256 validAfter = block.timestamp - 1;
        uint256 validBefore = block.timestamp + 15 minutes;
        (uint8 v, bytes32 r, bytes32 s) =
            _authorize(buyer, address(house), FLOOR, validAfter, validBefore, nonce, buyerKey);
        vm.prank(buyer);
        house.placeBidWithAuthorization(id, TEN, FLOOR, validAfter, validBefore, nonce, v, r, s);

        uint256 higher = FLOOR + 5e6;
        _bid(buyer2, id, TEN, higher);

        assertEq(uint256(house.bidStatus(id, buyer)), uint256(ErodoroAuctionHouse.BidStatus.Outbid));
        assertEq(house.refundableOf(buyer), FLOOR, "displaced authorization premium is refundable");

        vm.prank(buyer);
        house.withdrawRefund();
        assertEq(house.refundableOf(buyer), 0);
    }

    function test_authorizationBidFinalizesAtomically() public {
        uint256 id = _create(TEN, FLOOR, false);
        bytes32 nonce = keccak256("nonce-finalize");
        uint256 validAfter = block.timestamp - 1;
        uint256 validBefore = block.timestamp + 15 minutes;
        uint256 premium = FLOOR + 10e6;
        (uint8 v, bytes32 r, bytes32 s) =
            _authorize(buyer, address(house), premium, validAfter, validBefore, nonce, buyerKey);
        vm.prank(buyer);
        house.placeBidWithAuthorization(id, TEN, premium, validAfter, validBefore, nonce, v, r, s);

        vm.warp(block.timestamp + DURATION);
        uint256 sellerBefore = usdc.balanceOf(seller);
        vm.prank(keeper);
        house.finalizeAuction(id);

        assertEq(vault.balanceOf(buyer, nid), TEN, "winner receives N");
        assertEq(usdc.balanceOf(seller), sellerBefore + premium, "seller paid the full premium");
        assertEq(uint256(house.bidStatus(id, buyer)), uint256(ErodoroAuctionHouse.BidStatus.Won));
        assertEq(usdc.balanceOf(address(house)), 0);
    }

    function test_bidStatusIsNoneForNonBidders() public {
        uint256 id = _create(TEN, FLOOR, false);
        assertEq(uint256(house.bidStatus(id, keeper)), uint256(ErodoroAuctionHouse.BidStatus.None));
        assertEq(uint256(house.bidStatus(99, keeper)), uint256(ErodoroAuctionHouse.BidStatus.None));
    }

    // --- Fee splitting -------------------------------------------------------

    function test_feeSplitBpsAlwaysTotalsTenThousand() public {
        ErodoroAuctionHouse.FeeSplitBps memory base = house.feeSplitBps();
        assertEq(uint256(base.sellerBps) + base.protocolBps + base.referralBps, 10_000);

        vm.prank(seller);
        house.setReferralFee(150, address(0x8EF));
        ErodoroAuctionHouse.FeeSplitBps memory withReferral = house.feeSplitBps();
        assertEq(uint256(withReferral.sellerBps) + withReferral.protocolBps + withReferral.referralBps, 10_000);
        assertEq(withReferral.referralBps, 150);
        assertEq(withReferral.sellerBps, 10_000 - FEE_BPS - 150);
    }

    function test_referralLegPaysAndConservesExactly() public {
        address referrer = address(0x8EF);
        vm.prank(seller);
        house.setReferralFee(100, referrer);

        uint256 id = _create(TEN, FLOOR, false);
        uint256 premium = FLOOR + 3_333_333; // odd, to force rounding
        _bid(buyer, id, TEN, premium);
        vm.warp(block.timestamp + DURATION);

        uint256 sellerBefore = usdc.balanceOf(seller);
        vm.prank(keeper);
        house.finalizeAuction(id);

        uint256 protocolFee = (premium * FEE_BPS + 9_999) / 10_000;
        uint256 referralFee = (premium * 100 + 9_999) / 10_000;
        uint256 sellerProceeds = premium - protocolFee - referralFee;

        assertEq(usdc.balanceOf(referrer), referralFee, "referral paid");
        // feeRecipient == seller, so the seller receives proceeds + protocol fee.
        assertEq(usdc.balanceOf(seller), sellerBefore + sellerProceeds + protocolFee);
        assertEq(sellerProceeds + protocolFee + referralFee, premium, "exact conservation");
        assertEq(usdc.balanceOf(address(house)), 0, "house holds nothing");
    }

    function test_referralDisabledWithoutRecipient() public {
        uint256 id = _create(TEN, FLOOR, false);
        uint256 premium = FLOOR + 1e6;
        _bid(buyer, id, TEN, premium);
        vm.warp(block.timestamp + DURATION);
        vm.prank(keeper);
        house.finalizeAuction(id);
        // No referral configured: the whole protocol+remainder split, as before.
        ErodoroAuctionHouse.FeeSplitBps memory split = house.feeSplitBps();
        assertEq(split.referralBps, 0);
    }

    function test_referralConfigIsBoundedAndAdminOnly() public {
        vm.prank(buyer);
        vm.expectRevert();
        house.setReferralFee(100, buyer);

        vm.prank(seller);
        vm.expectRevert(abi.encodeWithSelector(ErodoroAuctionHouse.FeeSplitInvalid.selector, FEE_BPS, uint16(9_900)));
        house.setReferralFee(9_900, address(0x8EF));

        vm.prank(seller);
        vm.expectRevert();
        house.setReferralFee(100, address(0));

        vm.prank(seller);
        house.setReferralFee(0, address(0));
        assertEq(house.referralFeeBps(), 0);
    }

    function test_settlementRecordRecomputesTheSplit() public {
        vm.prank(seller);
        house.setReferralFee(100, address(0x8EF));
        uint256 id = _create(TEN, FLOOR, false);
        uint256 premium = FLOOR + 3_333_333;
        _bid(buyer, id, TEN, premium);

        vm.expectRevert(abi.encodeWithSelector(ErodoroAuctionHouse.AuctionStillOpen.selector, id));
        house.settlementOf(id);

        vm.warp(block.timestamp + DURATION);
        house.finalizeAuction(id);

        ErodoroAuctionHouse.SettlementRecord memory r = house.settlementOf(id);
        assertEq(r.auctionId, id);
        assertEq(r.seller, seller);
        assertEq(r.winner, buyer);
        assertEq(r.clearingPremium, premium);
        assertEq(r.grossPayment, premium);
        assertEq(r.sellerProceeds + r.protocolFee + r.referralFee, premium, "exact conservation");
        assertEq(r.referralFee, (premium * 100 + 9_999) / 10_000);
    }
}

/// @dev Charges a 1% transfer fee, so the house receives less than the premium.
contract FoTQuoteToken is ERC20 {
    constructor() ERC20("Fee On Transfer", "FOT") {}

    function decimals() public pure override returns (uint8) {
        return 6;
    }

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }

    function _update(address from, address to, uint256 value) internal override {
        if (from != address(0) && to != address(0) && value > 0) {
            uint256 fee = value / 100;
            super._update(from, to, value - fee);
            super._update(from, address(0), fee);
        } else {
            super._update(from, to, value);
        }
    }
}
