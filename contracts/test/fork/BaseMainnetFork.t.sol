// SPDX-License-Identifier: Apache-2.0
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import {IPyth} from "@pythnetwork/pyth-sdk-solidity/IPyth.sol";

import {ErodoroVault} from "../../src/ErodoroVault.sol";
import {Factory} from "../../src/Factory.sol";
import {PythAdapter} from "../../src/oracle/PythAdapter.sol";
import {IPythUnique} from "../../src/oracle/IPythUnique.sol";
import {SettlementModel} from "../../src/oracle/SettlementModel.sol";
import {PayoutMath} from "../../src/libraries/PayoutMath.sol";
import {StrikeMath} from "../../src/libraries/StrikeMath.sol";

/// @title BaseMainnetFork
/// @notice The full lifecycle against real Base mainnet state.
///
/// ## What is real
///
/// - the configured Coinbase tokenized-equity B20 Asset, its decimals, its
///   live multiplier, its roles and any armed transfer policies;
/// - the canonical Pyth receiver and a genuinely signed Hermes update, verified
///   through Wormhole guardian signatures inside Pyth's own contract;
/// - the B20 precompiles themselves, hosted by `base-forge` at a pinned Base
///   release rather than reimplemented.
///
/// The only test controls are Foundry's `warp` and `prank`. No oracle, token
/// metadata or contract state is stubbed.
///
/// ## What this cannot establish
///
/// That an equity market was open when the print landed. That the issuer will
/// not seize tomorrow. That the confidence policy chosen here is the right one.
///
/// ## The boundary that got easier
///
/// The Solana suite needed two series, because Surfpool can only move time
/// forward and a signed price for a future timestamp cannot be manufactured.
/// Here `vm.warp` moves in both directions relative to a fetched print: the
/// series is opened *before* the real `publishTime` and settled *after* it, so
/// one series proves the whole path with a genuinely signed quote.
///
/// ## Running it
///
/// Requires `base-forge` and configuration; see `docs/base-fork-testing.md`.
/// Every address is supplied at runtime. This file contains no fallbacks.
contract BaseMainnetForkTest is Test {
    uint256 constant BASE_CHAIN_ID = 8453;
    /// @dev The units every strike in this suite is quoted in.
    uint8 constant PRICE_DECIMALS = 8;
    address constant POLICY_REGISTRY = 0x8453000000000000000000000000000000000002;

    address collateral;
    address whale;
    IPyth pyth;
    bytes32 feedId;
    bytes[] updateData;
    uint64 publishTime;
    uint256 referencePrice;
    uint8 referenceDecimals;

    ErodoroVault vault;
    PythAdapter adapter;
    Factory factory;

    address alice = address(0xA11CE);
    address gov = address(0x60F);

    bool configured;

    function setUp() public {
        string memory rpc = vm.envOr("BASE_RPC_URL", string(""));
        if (bytes(rpc).length == 0) return;

        vm.createSelectFork(rpc);
        // Prove we are really on Base before trusting anything else here.
        assertEq(block.chainid, BASE_CHAIN_ID, "BASE_RPC_URL does not point at Base mainnet");

        collateral = vm.envAddress("BASE_COLLATERAL");
        whale = vm.envAddress("BASE_COLLATERAL_WHALE");
        pyth = IPyth(vm.envAddress("BASE_PYTH"));
        feedId = vm.envBytes32("BASE_FEED_ID");

        bytes memory raw = vm.envBytes("BASE_PYTH_UPDATE");
        updateData = new bytes[](1);
        updateData[0] = raw;
        publishTime = uint64(vm.envUint("BASE_PYTH_PUBLISH_TIME"));
        int256 signedPrice = vm.envInt("BASE_PYTH_PRICE");
        int256 expo = vm.envInt("BASE_PYTH_EXPO");
        require(signedPrice > 0 && expo <= 0 && expo >= -18, "invalid Hermes price metadata");
        referencePrice = uint256(signedPrice);
        referenceDecimals = uint8(uint256(-expo));

        vault = new ErodoroVault();
        adapter = new PythAdapter(IPythUnique(address(pyth)));
        configured = true;
    }

    modifier onlyConfigured() {
        if (!configured) {
            vm.skip(true);
        }
        _;
    }

    // --- What the chain actually says ---------------------------------------

    /// @notice Read the live token rather than assuming its shape. The spec
    ///         urges 18 decimals for equities; whether the issuer took that
    ///         advice is a fact about the chain, not about this repo.
    function test_theLiveTokenIsShapedAsExpected() public onlyConfigured {
        uint8 dec = IERC20Metadata(collateral).decimals();
        emit log_named_uint("collateral decimals", dec);
        assertGe(dec, 6, "B20 Asset decimals are bounded [6,18]");
        assertLe(dec, 18);

        (bool ok, bytes memory data) = collateral.staticcall(abi.encodeWithSignature("multiplier()"));
        assertTrue(ok, "collateral does not answer multiplier() - not a B20 Asset");
        uint256 m = abi.decode(data, (uint256));
        emit log_named_uint("live multiplier (WAD)", m);
        StrikeMath.validateMultiplier(m);

        assertGt(IERC20(collateral).balanceOf(whale), 0, "configured whale holds none of it");
    }

    /// @notice Which Base release is live, established by probing rather than
    ///         by assuming. Records the answer instead of asserting one, because
    ///         both answers are legitimate — but they mean different things for
    ///         `docs/known-limitations.md`.
    function test_reportWhetherTheScheduledMultiplierSurfaceExists() public onlyConfigured {
        (bool ok,) = collateral.staticcall(abi.encodeWithSignature("effectiveAt()"));
        emit log_named_string("scheduled multiplier surface (ERC-8056)", ok ? "present (Cobalt+)" : "absent (Beryl)");
        if (!ok) {
            emit log_string("NOTE: the creation-time corporate-action gate is UNAVAILABLE on this chain. See known-limitations.md");
        }
    }

    // --- The lifecycle -------------------------------------------------------

    /// @notice Lock real collateral, mint P and N, settle against a genuinely
    ///         signed Pyth print, redeem both sides, assert conservation.
    function test_fullLifecycleAgainstRealCollateral() public onlyConfigured {
        uint8 dec = IERC20Metadata(collateral).decimals();
        uint256 amount = 10 ** dec; // one whole unit

        // Open the series before the real print, so the print lands inside the
        // publish window when we warp forward to settle.
        vm.warp(publishTime - 1 hours);

        uint256 strike = _strikeNear(dec);
        ErodoroVault.CreateSeriesParams memory p = ErodoroVault.CreateSeriesParams({
            collateral: collateral,
            oracle: address(adapter),
            fallbackOracle: address(0),
            feeRecipient: gov,
            feedId: feedId,
            fallbackRequestId: bytes32(0),
            settlementModel: SettlementModel.RAW_SHARE,
            strike: strike,
            minSplitAmount: 0,
            maturity: publishTime,
            settlementDelay: 60,
            maxPriceLag: 60,
            fallbackDelay: 0,
            maxConfBps: 500,
            feeBps: 0,
            priceDecimals: PRICE_DECIMALS,
            admin: gov
        });

        vm.prank(alice);
        uint256 id = vault.createSeries(p);

        // Real collateral, moved by a real holder through the real token.
        vm.prank(whale);
        IERC20(collateral).transfer(alice, amount);

        vm.startPrank(alice);
        IERC20(collateral).approve(address(vault), amount);
        vault.split(id, amount);
        vm.stopPrank();

        assertEq(vault.balanceOf(alice, vault.pId(id)), amount);
        assertEq(vault.balanceOf(alice, vault.nId(id)), amount);
        assertEq(vault.lockedOf(id), amount);

        // Settle against the signed print.
        vm.warp(uint256(publishTime) + 120);
        uint256 fee = pyth.getUpdateFee(updateData);
        vm.deal(address(this), fee);
        vault.settle{value: fee}(id, updateData);

        ErodoroVault.Settlement memory st = vault.settlementOf(id);
        emit log_named_uint("settlement price", st.price);
        emit log_named_uint("effective strike", st.effectiveStrike);
        emit log_named_uint("P pool", st.pPool);
        emit log_named_uint("N pool", st.nPool);
        assertEq(st.pPool + st.nPool, amount, "pools must partition the collateral");
        assertEq(st.priceTs, publishTime, "must settle against the print we supplied");

        uint256 before = IERC20(collateral).balanceOf(alice);
        vm.startPrank(alice);
        uint256 paidP = vault.redeem(id, true, amount);
        uint256 paidN = vault.redeem(id, false, amount);
        vm.stopPrank();

        assertEq(paidP, st.pPool, "P paid its whole pool");
        assertEq(paidN, st.nPool, "N paid its whole pool");
        assertEq(IERC20(collateral).balanceOf(alice) - before, amount, "collateral conserved");
        assertEq(vault.lockedOf(id), 0, "series fully retired");
    }

    /// @notice The seizure precondition, asserted against live state.
    ///
    /// @dev On Beryl there is no `seizeWithMemo`. Seizure is `burnBlocked` +
    ///      re-mint, and `burnBlocked` requires the target to be **denied** under
    ///      `TRANSFER_SENDER_POLICY`. On the live token that scope is armed
    ///      (policy id 5) but the policy currently authorizes every address we
    ///      have probed — so no address is seizable right now, and the call
    ///      reverts `AccountNotBlocked` for anyone who holds the role.
    ///
    ///      That is the honest state of the lever today: **armed and wired, one
    ///      list-addition away from live.** Not dormant, and not requiring a
    ///      redeploy. This test pins the precondition so the day it changes,
    ///      this fails.
    function test_theSeizurePreconditionDoesNotHoldToday() public onlyConfigured {
        (bool ok, bytes memory data) = collateral.staticcall(abi.encodeWithSignature("TRANSFER_SENDER_POLICY()"));
        assertTrue(ok, "sender policy scope unreadable");
        bytes32 scope = abi.decode(data, (bytes32));

        (ok, data) = collateral.staticcall(abi.encodeWithSignature("policyId(bytes32)", scope));
        assertTrue(ok, "policyId unreadable");
        uint64 id = abi.decode(data, (uint64));
        emit log_named_uint("TRANSFER_SENDER_POLICY id (0 would be ALWAYS_ALLOW)", id);

        // Deploy a fresh vault so we are asking about an address with no history.
        (ok, data) =
            POLICY_REGISTRY.staticcall(abi.encodeWithSignature("isAuthorized(uint64,address)", id, address(vault)));
        assertTrue(ok, "registry unreadable");
        bool authorized = abi.decode(data, (bool));

        emit log_named_string("vault authorized to send", authorized ? "yes" : "NO");
        if (authorized) {
            emit log_string("=> not seizable today: burnBlocked would revert AccountNotBlocked");
        } else {
            emit log_string("=> WARNING: the vault is denied. It cannot redeem, and it IS seizable.");
        }
        // Today's expected state. If this flips, redemption is already broken.
        assertTrue(authorized, "the vault is blocked from sending - redemption would revert");
    }

    /// @notice §7 against **real forked collateral**: the proportional haircut.
    ///
    /// @dev What is real here: the AAPLc balance, the settled pools, the
    ///      redemption arithmetic, and the collateral that actually moves.
    ///
    ///      What is a test control: the balance reduction itself. Because the
    ///      seizure precondition does not hold on-chain today (see the test
    ///      above), no real caller can execute one, so the drain is produced by
    ///      pranking the vault to send its own collateral away. That reproduces
    ///      the exact *state* a seizure produces — vault balance down, protocol
    ///      accounting untouched — without fabricating an authority that does
    ///      not exist. The authority is asserted separately and honestly.
    function test_realCollateralShortfallIsHaircutProportionally() public onlyConfigured {
        uint8 dec = IERC20Metadata(collateral).decimals();
        uint256 amount = 10 ** dec;

        vm.warp(publishTime - 1 hours);
        uint256 id = _open(amount);

        vm.warp(uint256(publishTime) + 120);
        uint256 fee = pyth.getUpdateFee(updateData);
        vm.deal(address(this), fee);
        vault.settle{value: fee}(id, updateData);

        ErodoroVault.Settlement memory st = vault.settlementOf(id);
        assertEq(st.pPool + st.nPool, amount, "pools partition the collateral");

        // Half the real collateral leaves the vault.
        vm.prank(address(vault));
        IERC20(collateral).transfer(address(0xBEEF), amount / 2);
        assertEq(IERC20(collateral).balanceOf(address(vault)), amount / 2);

        vm.startPrank(alice);
        uint256 paidP = vault.redeem(id, true, amount);
        uint256 paidN = vault.redeem(id, false, amount);
        vm.stopPrank();

        emit log_named_uint("P quoted / paid", st.pPool);
        emit log_named_uint("P paid", paidP);
        emit log_named_uint("N paid", paidN);

        assertEq(paidP + paidN, amount / 2, "must pay out exactly what remained, no more");
        assertApproxEqAbs(paidP, st.pPool / 2, 2, "P takes the same ~50% haircut");
        assertApproxEqAbs(paidN, st.nPool / 2, 2, "N takes the same ~50% haircut");

        st = vault.settlementOf(id);
        assertTrue(st.shortfallObserved, "shortfall must be recorded on-chain");
        assertEq(vault.lockedOf(id), 0, "the series must retire its belief, not leave a phantom");
    }

    /// @dev Open a series against the live token and lock real collateral.
    function _open(uint256 amount) internal returns (uint256 id) {
        ErodoroVault.CreateSeriesParams memory p = ErodoroVault.CreateSeriesParams({
            collateral: collateral,
            oracle: address(adapter),
            fallbackOracle: address(0),
            feeRecipient: gov,
            feedId: feedId,
            fallbackRequestId: bytes32(0),
            settlementModel: SettlementModel.RAW_SHARE,
            strike: _strikeNear(0),
            minSplitAmount: 0,
            maturity: publishTime,
            settlementDelay: 60,
            maxPriceLag: 60,
            fallbackDelay: 0,
            maxConfBps: 500,
            feeBps: 0,
            priceDecimals: PRICE_DECIMALS,
            admin: gov
        });
        vm.prank(alice);
        id = vault.createSeries(p);

        vm.prank(whale);
        IERC20(collateral).transfer(alice, amount);
        vm.startPrank(alice);
        IERC20(collateral).approve(address(vault), amount);
        vault.split(id, amount);
        vm.stopPrank();
    }

    /// @dev A strike near the money, derived from the live print rather than
    ///      hard-coded, so the test exercises the interesting branch on any day.
    ///
    ///      **Normalise before scaling.** The live `Equity.US.AAPL/USD` feed
    ///      publishes at `expo = -5`, while these series declare
    ///      `priceDecimals = 8`. Quoting the strike in feed-native units against
    ///      an 8-decimal series understates it by 1000x, which caps P at
    ///      essentially nothing and hands the whole position to N. The first
    ///      version of this helper did exactly that, and the payoff it produced
    ///      still summed to the collateral — conservation holds whatever the
    ///      strike is, so the arithmetic never complains. A strike is only
    ///      meaningful in the units its series declares.
    function _strikeNear(uint8) internal returns (uint256) {
        uint256 normalized = PayoutMath.normalizeDecimals(referencePrice, referenceDecimals, PRICE_DECIMALS);
        emit log_named_uint("live feed decimals", referenceDecimals);
        emit log_named_uint("strike (series units)", normalized * 90 / 100);
        // 10% below the print: guarantees price > strike, so both pools are live.
        return normalized * 90 / 100;
    }
}
