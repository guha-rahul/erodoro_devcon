// SPDX-License-Identifier: Apache-2.0
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {MockPythUnique} from "../harness/MockPythUnique.sol";

import {ErodoroVault} from "../../src/ErodoroVault.sol";
import {PythAdapter} from "../../src/oracle/PythAdapter.sol";
import {IPythUnique} from "../../src/oracle/IPythUnique.sol";
import {SettlementModel} from "../../src/oracle/SettlementModel.sol";
import {PayoutMath} from "../../src/libraries/PayoutMath.sol";
import {MockB20Asset} from "../harness/MockB20Asset.sol";

/// @notice §7 through the vault: the issuer can take collateral out of a settled
///         vault, and no contract can stop it. What a contract *can* do is make
///         sure everyone takes the same proportional loss instead of the first
///         redeemer walking away whole and the last getting nothing.
contract ShortfallTest is Test {
    MockB20Asset collateral;
    MockPythUnique pyth;
    PythAdapter adapter;
    ErodoroVault vault;

    address alice = address(0xA11CE);
    address bob = address(0xB0B);
    address issuer = address(0x155E);

    bytes32 constant FEED = bytes32("AAPLc/USD");
    uint8 constant PRICE_DECIMALS = 8;
    uint256 constant USD = 1e8;
    uint256 constant STRIKE = 500 * USD;
    uint256 constant ONE = 1e18;
    uint64 constant DELAY = 300;
    uint64 constant MAX_LAG = 60;

    uint64 maturity;

    function setUp() public {
        vm.warp(1_700_000_000);
        collateral = new MockB20Asset("Apple Tokenized Stock", "AAPLc", 18, false);
        pyth = new MockPythUnique(60, 1);
        adapter = new PythAdapter(IPythUnique(address(pyth)));
        vault = new ErodoroVault();
        maturity = uint64(block.timestamp + 30 days);

        collateral.mint(alice, 100 * ONE);
        collateral.mint(bob, 100 * ONE);
        vm.prank(alice);
        collateral.approve(address(vault), type(uint256).max);
        vm.prank(bob);
        collateral.approve(address(vault), type(uint256).max);
    }

    function _params() internal view returns (ErodoroVault.CreateSeriesParams memory) {
        return ErodoroVault.CreateSeriesParams({
            collateral: address(collateral),
            oracle: address(adapter),
            fallbackOracle: address(0),
            feeRecipient: address(0xFEE),
            feedId: FEED,
            fallbackRequestId: bytes32(0),
            settlementModel: SettlementModel.RAW_SHARE,
            strike: STRIKE,
            minSplitAmount: 0,
            maturity: maturity,
            settlementDelay: DELAY,
            maxPriceLag: MAX_LAG,
            fallbackDelay: 0,
            maxConfBps: 500,
            feeBps: 0,
            priceDecimals: PRICE_DECIMALS,
            admin: alice
        });
    }

    function _create(address creator) internal returns (uint256 id) {
        vm.prank(creator);
        id = vault.createSeries(_params());
    }

    function _settle(uint256 id, int64 price) internal {
        vm.warp(uint256(maturity) + DELAY);
        bytes[] memory data = new bytes[](1);
        data[0] = pyth.createPriceFeedUpdateData(
            FEED, price, uint64(uint64(price) / 1000), -int32(int256(uint256(PRICE_DECIMALS))), price, 0, maturity + 60
        );
        uint256 fee = pyth.getUpdateFee(data);
        vm.deal(bob, fee);
        vm.prank(bob);
        vault.settle{value: fee}(id, data);
    }

    // --- The core §7 property ------------------------------------------------

    /// @notice Half the vault is taken after settlement. Both sides are paid
    ///         half of what they were quoted, and the vault is emptied exactly.
    function test_postSettlementSeizureIsHaircutProportionally() public {
        uint256 id = _create(alice);
        vm.prank(alice);
        vault.split(id, ONE);
        _settle(id, int64(600 * 1e8));

        ErodoroVault.Settlement memory st = vault.settlementOf(id);
        uint256 quotedP = st.pPool;
        uint256 quotedN = st.nPool;
        assertEq(quotedP + quotedN, ONE);

        // The issuer takes half. On Beryl this is `burnBlocked` + re-mint; the
        // vault's balance simply drops and no contract check can prevent it.
        vm.prank(issuer);
        collateral.burnBlocked(address(vault), ONE / 2);
        assertEq(collateral.balanceOf(address(vault)), ONE / 2);

        uint256 beforeBal = collateral.balanceOf(alice);
        vm.startPrank(alice);
        uint256 paidP = vault.redeem(id, true, ONE);
        uint256 paidN = vault.redeem(id, false, ONE);
        vm.stopPrank();

        // Each side takes the same ~50% haircut...
        assertApproxEqAbs(paidP, quotedP / 2, 2, "P haircut");
        assertApproxEqAbs(paidN, quotedN / 2, 2, "N haircut");
        // ...and the vault paid out exactly what it held, no more.
        assertEq(paidP + paidN, ONE / 2, "must pay out exactly what remained");
        assertEq(collateral.balanceOf(alice) - beforeBal, ONE / 2);
        assertEq(collateral.balanceOf(address(vault)), 0);

        st = vault.settlementOf(id);
        assertTrue(st.shortfallObserved, "shortfall must be recorded on-chain");
    }

    /// @notice The property that distinguishes a haircut from first-come-first-
    ///         served: redemption order does not change what anyone receives.
    function test_shortfallIsIndependentOfRedemptionOrder() public {
        // Run A: P redeems first.
        uint256 idA = _create(alice);
        vm.prank(alice);
        vault.split(idA, ONE);
        _settle(idA, int64(600 * 1e8));
        vm.prank(issuer);
        collateral.burnBlocked(address(vault), ONE / 2);

        vm.startPrank(alice);
        uint256 aP = vault.redeem(idA, true, ONE);
        uint256 aN = vault.redeem(idA, false, ONE);
        vm.stopPrank();

        // Run B: identical series, N redeems first.
        maturity = uint64(block.timestamp + 30 days);
        uint256 idB = _create(bob);
        vm.prank(bob);
        vault.split(idB, ONE);
        _settle(idB, int64(600 * 1e8));
        vm.prank(issuer);
        collateral.burnBlocked(address(vault), ONE / 2);

        vm.startPrank(bob);
        uint256 bN = vault.redeem(idB, false, ONE);
        uint256 bP = vault.redeem(idB, true, ONE);
        vm.stopPrank();

        // Not bit-identical — each payout floors, so the vault keeps a sub-unit
        // remainder that very slightly improves the ratio for whoever is next.
        // Bounded by one unit per claim, which is the difference between "the
        // same haircut" and "first come, first served".
        assertApproxEqAbs(aP, bP, 2, "P payout changed with order");
        assertApproxEqAbs(aN, bN, 2, "N payout changed with order");
        assertEq(aP + aN, bP + bN, "total paid must not depend on order");
    }

    /// @notice A fully drained vault pays nothing rather than reverting. The
    ///         claim is still burned: there is nothing left to be owed.
    function test_aFullyDrainedVaultPaysNothingAndDoesNotRevert() public {
        uint256 id = _create(alice);
        vm.prank(alice);
        vault.split(id, ONE);
        _settle(id, int64(600 * 1e8));

        vm.prank(issuer);
        collateral.burnBlocked(address(vault), ONE);

        vm.prank(alice);
        uint256 paid = vault.redeem(id, true, ONE);
        assertEq(paid, 0);
    }

    /// @notice The Cobalt seizure path reaches the same place by a different
    ///         route: a direct reassignment rather than a burn and re-mint.
    function test_cobaltSeizeWithMemoIsHandledIdentically() public {
        uint256 id = _create(alice);
        vm.prank(alice);
        vault.split(id, ONE);
        _settle(id, int64(600 * 1e8));

        vm.prank(issuer);
        collateral.seizeWithMemo(address(vault), issuer, ONE / 2, bytes32("regulatory"));
        assertEq(collateral.balanceOf(issuer), ONE / 2);

        vm.startPrank(alice);
        uint256 paidP = vault.redeem(id, true, ONE);
        uint256 paidN = vault.redeem(id, false, ONE);
        vm.stopPrank();
        assertEq(paidP + paidN, ONE / 2);
    }

    // --- The singleton consequence -------------------------------------------

    /// @notice One address holds every series' collateral, so a seizure aimed at
    ///         the vault hits every series written against that token. The loss
    ///         is shared pro-rata rather than falling on whoever redeems last.
    ///
    /// @dev This has no Solana counterpart — there each series owned its own
    ///      token account. It is a direct consequence of the singleton design
    ///      and belongs in the UI as a headline risk, not a footnote.
    function test_aDrainIsSocialisedAcrossSeriesOfTheSameToken() public {
        uint256 idA = _create(alice); // 1 token
        uint256 idB = _create(bob); // 3 tokens

        vm.prank(alice);
        vault.split(idA, ONE);
        vm.prank(bob);
        vault.split(idB, 3 * ONE);

        assertEq(vault.tokenLocked(address(collateral)), 4 * ONE);
        assertEq(collateral.balanceOf(address(vault)), 4 * ONE);

        // Half the pooled collateral is taken.
        vm.prank(issuer);
        collateral.burnBlocked(address(vault), 2 * ONE);

        _settle(idA, int64(600 * 1e8));
        _settle(idB, int64(600 * 1e8));

        // Each series is settled against its own pro-rata share: 50% each.
        ErodoroVault.Settlement memory stA = vault.settlementOf(idA);
        ErodoroVault.Settlement memory stB = vault.settlementOf(idB);
        assertEq(stA.collateralAtSettlement, ONE / 2, "series A takes half");
        assertEq(stB.collateralAtSettlement, 3 * ONE / 2, "series B takes half");

        // Neither series can draw on the other's share.
        assertEq(
            stA.collateralAtSettlement + stB.collateralAtSettlement,
            collateral.balanceOf(address(vault)),
            "attributed shares must exactly account for what is held"
        );
    }

    /// @notice A donation to the contract cannot inflate one series' pool at
    ///         another's expense: the share is capped at what the series locked.
    function test_aDonationDoesNotInflateAnyPool() public {
        uint256 id = _create(alice);
        vm.prank(alice);
        vault.split(id, ONE);

        vm.prank(bob);
        collateral.transfer(address(vault), 5 * ONE); // unsolicited

        _settle(id, int64(600 * 1e8));
        ErodoroVault.Settlement memory st = vault.settlementOf(id);
        assertEq(st.collateralAtSettlement, ONE, "capped at what the series locked");
    }

    /// @notice Regression. A series that redeems under a haircut must retire
    ///         its *belief*, not just what it was paid.
    ///
    /// @dev The first version of `redeem` decremented `lockedOf` by `paid`. A
    ///      series paid 50% of its claim therefore left half its belief behind
    ///      as a balance that could never pay out but stayed in `tokenLocked`
    ///      forever — inflating the denominator and permanently under-paying
    ///      every sibling series over the same token. Here B would have received
    ///      0.333 instead of its correct 0.5, robbed by A's exit rather than by
    ///      the seizure. See `_consumeBelieved`.
    function test_aHaircutSeriesExitDoesNotDiluteItsSiblings() public {
        uint256 idA = _create(alice);
        uint256 idB = _create(bob);

        vm.prank(alice);
        vault.split(idA, ONE);
        vm.prank(bob);
        vault.split(idB, ONE);

        // Half the pooled collateral is seized: both series are down 50%.
        vm.prank(issuer);
        collateral.burnBlocked(address(vault), ONE);

        _settle(idA, int64(600 * 1e8));
        vm.startPrank(alice);
        uint256 aP = vault.redeem(idA, true, ONE);
        uint256 aN = vault.redeem(idA, false, ONE);
        vm.stopPrank();
        assertApproxEqAbs(aP + aN, ONE / 2, 2, "A takes its own 50% loss");
        assertEq(vault.lockedOf(idA), 0, "a fully-redeemed series must retire its belief");

        // B settles after A has exited, and must still see exactly 50%.
        _settle(idB, int64(600 * 1e8));
        ErodoroVault.Settlement memory stB = vault.settlementOf(idB);
        assertEq(stB.collateralAtSettlement, ONE / 2, "B must not be diluted by A's exit");

        vm.startPrank(bob);
        uint256 bP = vault.redeem(idB, true, ONE);
        uint256 bN = vault.redeem(idB, false, ONE);
        vm.stopPrank();
        assertApproxEqAbs(bP + bN, ONE / 2, 2, "B takes its own 50% loss and no more");
        assertEq(collateral.balanceOf(address(vault)), 0, "vault fully drained by redemptions");
    }

    // --- Solvency under fuzzing ---------------------------------------------

    /// @notice However much is drained, total payouts never exceed what the
    ///         vault actually holds.
    function testFuzz_totalPaidNeverExceedsWhatTheVaultHolds(uint256 drain, uint256 priceUsd) public {
        drain = bound(drain, 0, ONE);
        priceUsd = bound(priceUsd, 1, 5000);

        uint256 id = _create(alice);
        vm.prank(alice);
        vault.split(id, ONE);
        _settle(id, int64(uint64(priceUsd * 1e8)));

        vm.prank(issuer);
        collateral.burnBlocked(address(vault), drain);
        uint256 held = collateral.balanceOf(address(vault));

        vm.startPrank(alice);
        uint256 paidP = vault.redeem(id, true, ONE);
        uint256 paidN = vault.redeem(id, false, ONE);
        vm.stopPrank();

        assertLe(paidP + paidN, held, "paid more than the vault held");
        assertLe(collateral.balanceOf(address(vault)), held, "vault balance must not grow");
    }
}
