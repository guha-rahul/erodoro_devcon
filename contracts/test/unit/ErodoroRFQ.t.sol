// SPDX-License-Identifier: Apache-2.0
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {MockPythUnique} from "../harness/MockPythUnique.sol";

import {ErodoroVault} from "../../src/ErodoroVault.sol";
import {ErodoroRFQ} from "../../src/ErodoroRFQ.sol";
import {PythAdapter} from "../../src/oracle/PythAdapter.sol";
import {IPythUnique} from "../../src/oracle/IPythUnique.sol";
import {SettlementModel} from "../../src/oracle/SettlementModel.sol";
import {TestQuoteToken} from "../../src/periphery/TestQuoteToken.sol";
import {Errors} from "../../src/libraries/Errors.sol";
import {MockB20Asset} from "../harness/MockB20Asset.sol";

contract ErodoroRFQTest is Test {
    MockB20Asset collateral;
    TestQuoteToken usdc;
    MockPythUnique pyth;
    PythAdapter adapter;
    ErodoroVault vault;
    ErodoroRFQ rfq;

    uint256 makerKey = 0xA11CE5;
    address maker;
    address seller = address(0x5E11E4);

    uint256 constant TEN = 10e8; // 10 shares at 8 decimals
    uint256 constant PREMIUM = 61_500_000; // 61.50 USDC at 6 decimals
    uint256 id;
    uint256 nId;

    function setUp() public {
        vm.chainId(84532);
        vm.warp(1_700_000_000);
        maker = vm.addr(makerKey);

        collateral = new MockB20Asset("Apple", "AAPLc", 8, false);
        usdc = new TestQuoteToken();
        pyth = new MockPythUnique(60, 1);
        adapter = new PythAdapter(IPythUnique(address(pyth)));
        vault = new ErodoroVault();
        rfq = new ErodoroRFQ();

        collateral.mint(seller, 100e8);
        usdc.mint(maker, 100_000e6);

        vm.prank(maker);
        usdc.approve(address(rfq), type(uint256).max);

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
                strike: 340 * 1e8,
                minSplitAmount: 0,
                maturity: uint64(block.timestamp + 30 days),
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
        vault.setOperator(address(rfq), true);
        vm.stopPrank();
        nId = vault.nId(id);
    }

    function _quote(uint256 nonce, uint256 expiry, address taker)
        internal
        view
        returns (ErodoroRFQ.Quote memory)
    {
        return ErodoroRFQ.Quote({
            maker: maker,
            taker: taker,
            claims: address(vault),
            claimId: nId,
            claimAmount: TEN,
            quoteToken: address(usdc),
            quoteAmount: PREMIUM,
            expiry: expiry,
            nonce: nonce
        });
    }

    function _sign(ErodoroRFQ.Quote memory q) internal view returns (bytes memory) {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(makerKey, rfq.hashQuote(q));
        return abi.encodePacked(r, s, v);
    }

    /// @notice The whole product: sell 10 N, receive 61.50 USDC, one transaction.
    function test_sellUpsideIntoASignedQuote() public {
        ErodoroRFQ.Quote memory q = _quote(1, block.timestamp + 60, address(0));
        bytes memory sig = _sign(q);

        (bool ok, string memory why) = rfq.checkQuote(q, sig, seller);
        assertTrue(ok, why);

        vm.prank(seller);
        rfq.fill(q, sig);

        assertEq(usdc.balanceOf(seller), PREMIUM, "seller was paid the premium");
        assertEq(vault.balanceOf(maker, nId), TEN, "maker holds the upside claim");
        assertEq(vault.balanceOf(seller, nId), 0, "seller gave up the upside");
        // And keeps the capped claim - that is the trade.
        assertEq(vault.balanceOf(seller, vault.pId(id)), TEN, "seller keeps P");
        // The contract is a conduit, never a custodian.
        assertEq(usdc.balanceOf(address(rfq)), 0);
        assertEq(vault.balanceOf(address(rfq), nId), 0);
    }

    /// @notice The maker signs; only the seller transacts.
    function test_theMakerNeverSendsATransaction() public {
        ErodoroRFQ.Quote memory q = _quote(1, block.timestamp + 60, address(0));
        bytes memory sig = _sign(q);
        uint256 makerNonceBefore = vm.getNonce(maker);

        vm.prank(seller);
        rfq.fill(q, sig);

        assertEq(vm.getNonce(maker), makerNonceBefore, "maker sent no transaction");
    }

    function test_aQuoteFillsOnlyOnce() public {
        ErodoroRFQ.Quote memory q = _quote(1, block.timestamp + 60, address(0));
        bytes memory sig = _sign(q);
        vm.startPrank(seller);
        rfq.fill(q, sig);
        vm.expectRevert(abi.encodeWithSelector(ErodoroRFQ.QuoteAlreadyUsed.selector, uint256(1)));
        rfq.fill(q, sig);
        vm.stopPrank();
    }

    function test_anExpiredQuoteCannotFill() public {
        uint256 expiry = block.timestamp + 60;
        ErodoroRFQ.Quote memory q = _quote(1, expiry, address(0));
        bytes memory sig = _sign(q);

        vm.warp(expiry + 1);
        vm.prank(seller);
        vm.expectRevert(abi.encodeWithSelector(ErodoroRFQ.QuoteExpired.selector, expiry));
        rfq.fill(q, sig);
    }

    /// @notice A quote is a price from one maker. Tampering with any field
    ///         breaks the signature rather than repricing the trade.
    function test_aTamperedQuoteIsRejected() public {
        ErodoroRFQ.Quote memory q = _quote(1, block.timestamp + 60, address(0));
        bytes memory sig = _sign(q);

        q.quoteAmount = PREMIUM / 2; // seller tries to pay themselves less? no - maker pays less
        vm.prank(seller);
        vm.expectRevert(ErodoroRFQ.BadSignature.selector);
        rfq.fill(q, sig);
    }

    function test_aQuoteAddressedToSomeoneElseIsRejected() public {
        address other = address(0xBEEF);
        ErodoroRFQ.Quote memory q = _quote(1, block.timestamp + 60, other);
        bytes memory sig = _sign(q);
        vm.prank(seller);
        vm.expectRevert(abi.encodeWithSelector(ErodoroRFQ.QuoteNotForYou.selector, other));
        rfq.fill(q, sig);
    }

    function test_makerCanCancelBeforeExpiry() public {
        ErodoroRFQ.Quote memory q = _quote(7, block.timestamp + 3600, address(0));
        bytes memory sig = _sign(q);

        vm.prank(maker);
        rfq.cancelNonce(7);

        (bool ok, string memory why) = rfq.checkQuote(q, sig, seller);
        assertFalse(ok);
        assertEq(why, "Quote already used or cancelled");

        vm.prank(seller);
        vm.expectRevert(abi.encodeWithSelector(ErodoroRFQ.QuoteAlreadyUsed.selector, uint256(7)));
        rfq.fill(q, sig);
    }

    /// @notice checkQuote must catch what the UI cannot see, so a Sell button is
    ///         never offered for a fill that would revert in the wallet.
    function test_checkQuoteCatchesAnUnfundedMaker() public {
        uint256 all = usdc.balanceOf(maker); // hoisted: an argument call eats the prank
        vm.prank(maker);
        usdc.transfer(address(0xDEAD), all);

        ErodoroRFQ.Quote memory q = _quote(1, block.timestamp + 60, address(0));
        (bool ok, string memory why) = rfq.checkQuote(q, _sign(q), seller);
        assertFalse(ok);
        assertEq(why, "Market maker is short of the quote token");
    }

    function test_checkQuoteCatchesAMissingApproval() public {
        vm.prank(maker);
        usdc.approve(address(rfq), 0);

        ErodoroRFQ.Quote memory q = _quote(1, block.timestamp + 60, address(0));
        (bool ok, string memory why) = rfq.checkQuote(q, _sign(q), seller);
        assertFalse(ok);
        assertEq(why, "Market maker has not approved the payment");
    }

    /// @notice Best-of-three, which is the point of asking several makers.
    function test_bestOfSeveralQuotesWins() public {
        uint256[3] memory premiums = [uint256(59_000_000), 61_500_000, 60_300_000];
        uint256 best;
        uint256 bestIdx;
        for (uint256 i = 0; i < 3; i++) {
            if (premiums[i] > best) {
                best = premiums[i];
                bestIdx = i;
            }
        }
        assertEq(best, 61_500_000, "the seller should be shown the highest premium");

        ErodoroRFQ.Quote memory q = _quote(bestIdx + 1, block.timestamp + 60, address(0));
        q.quoteAmount = best;
        bytes memory sig = _sign(q);

        vm.prank(seller);
        rfq.fill(q, sig);
        assertEq(usdc.balanceOf(seller), best);
    }

    function test_rejectsZeroAmounts() public {
        ErodoroRFQ.Quote memory q = _quote(1, block.timestamp + 60, address(0));
        q.claimAmount = 0;
        bytes memory sig = _sign(q); // hoisted: _sign() would consume the expectRevert
        vm.prank(seller);
        vm.expectRevert(Errors.InvalidAmount.selector);
        rfq.fill(q, sig);
    }
}
