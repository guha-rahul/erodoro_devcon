// SPDX-License-Identifier: Apache-2.0
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {MockPythUnique} from "../harness/MockPythUnique.sol";
import {IERC6909} from "@openzeppelin/contracts/interfaces/IERC6909.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

import {ErodoroVault} from "../../src/ErodoroVault.sol";
import {ClaimWrapper} from "../../src/periphery/ClaimWrapper.sol";
import {PythAdapter} from "../../src/oracle/PythAdapter.sol";
import {IPythUnique} from "../../src/oracle/IPythUnique.sol";
import {SettlementModel} from "../../src/oracle/SettlementModel.sol";
import {MockB20Asset} from "../harness/MockB20Asset.sol";

contract ClaimWrapperTest is Test {
    MockB20Asset collateral;
    MockPythUnique pyth;
    PythAdapter adapter;
    ErodoroVault vault;
    ClaimWrapper wrapper;

    address alice = address(0xA11CE);
    address bob = address(0xB0B);

    bytes32 constant FEED = bytes32("AAPLc/USD");
    uint256 constant ONE = 1e18;
    uint256 id;
    uint64 maturity;

    function setUp() public {
        vm.warp(1_700_000_000);
        collateral = new MockB20Asset("Apple Tokenized Stock", "AAPLc", 18, false);
        pyth = new MockPythUnique(60, 1);
        adapter = new PythAdapter(IPythUnique(address(pyth)));
        vault = new ErodoroVault();
        maturity = uint64(block.timestamp + 30 days);

        collateral.mint(alice, 10 * ONE);
        vm.prank(alice);
        collateral.approve(address(vault), type(uint256).max);

        vm.prank(alice);
        id = vault.createSeries(
            ErodoroVault.CreateSeriesParams({
                collateral: address(collateral),
                oracle: address(adapter),
                fallbackOracle: address(0),
                feeRecipient: address(0xFEE),
                feedId: FEED,
                fallbackRequestId: bytes32(0),
                settlementModel: SettlementModel.RAW_SHARE,
                strike: 500 * 1e8,
                minSplitAmount: 0,
                maturity: maturity,
                settlementDelay: 300,
                maxPriceLag: 60,
                fallbackDelay: 0,
                maxConfBps: 500,
                feeBps: 0,
                priceDecimals: 8,
                admin: alice
            })
        );

        wrapper = new ClaimWrapper(IERC6909(address(vault)), vault.nId(id), "erodoro N AAPLc 500", "eN-AAPLc-500");

        vm.prank(alice);
        vault.split(id, 2 * ONE);
    }

    function test_wrapAndUnwrapRoundTrip() public {
        vm.startPrank(alice);
        vault.setOperator(address(wrapper), true);
        wrapper.wrap(ONE);
        vm.stopPrank();

        assertEq(wrapper.balanceOf(alice), ONE, "ERC-20 minted 1:1");
        assertEq(vault.balanceOf(address(wrapper), vault.nId(id)), ONE, "wrapper holds the claim");
        assertEq(vault.balanceOf(alice, vault.nId(id)), ONE, "and alice keeps the rest");

        vm.prank(alice);
        wrapper.unwrap(ONE);
        assertEq(wrapper.balanceOf(alice), 0);
        assertEq(vault.balanceOf(alice, vault.nId(id)), 2 * ONE);
    }

    /// @notice The point of the wrapper: N becomes an ordinary ERC-20 that any
    ///         AMM can hold, which is the only route by which the P holder ever
    ///         gets paid for capping their upside.
    function test_aWrappedClaimIsAnOrdinaryERC20() public {
        vm.startPrank(alice);
        vault.setOperator(address(wrapper), true);
        wrapper.wrap(ONE);
        IERC20(address(wrapper)).transfer(bob, ONE / 2);
        vm.stopPrank();

        assertEq(wrapper.balanceOf(bob), ONE / 2);

        // And bob can unwrap into the real claim without alice's involvement.
        vm.prank(bob);
        wrapper.unwrap(ONE / 2);
        assertEq(vault.balanceOf(bob, vault.nId(id)), ONE / 2);
    }

    /// @notice Wrapping does not insulate anyone from anything. A holder must
    ///         unwrap before redeeming; the wrapper never redeems for them.
    function test_theWrapperDoesNotRedeem() public {
        vm.startPrank(alice);
        vault.setOperator(address(wrapper), true);
        wrapper.wrap(ONE);
        vm.stopPrank();
        // The wrapper holds a claim but exposes no path to the collateral.
        assertEq(collateral.balanceOf(address(wrapper)), 0);
        assertEq(vault.balanceOf(address(wrapper), vault.nId(id)), ONE);
    }

    function test_wrapRejectsZero() public {
        vm.prank(alice);
        vm.expectRevert();
        wrapper.wrap(0);
    }
}
