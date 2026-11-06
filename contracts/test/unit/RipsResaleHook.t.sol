// SPDX-License-Identifier: Apache-2.0
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {IHooks} from "@uniswap/v4-core/src/interfaces/IHooks.sol";
import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {Hooks} from "@uniswap/v4-core/src/libraries/Hooks.sol";
import {Currency} from "@uniswap/v4-core/src/types/Currency.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {ModifyLiquidityParams, SwapParams} from "@uniswap/v4-core/src/types/PoolOperation.sol";
import {HumanRegistry} from "../../src/identity/HumanRegistry.sol";
import {IHumanGate} from "../../src/identity/IHumanGate.sol";
import {RipsResaleHook} from "../../src/periphery/RipsResaleHook.sol";

/// Stands in for Universal Router or PositionManager mid-call.
contract MockRouter {
    address public msgSender;

    function act(address user) external {
        msgSender = user;
    }
}

contract RipsResaleHookTest is Test {
    address constant POOL_MANAGER = address(0x9999);
    uint160 constant FLAGS = Hooks.BEFORE_INITIALIZE_FLAG | Hooks.BEFORE_ADD_LIQUIDITY_FLAG | Hooks.BEFORE_SWAP_FLAG;
    Currency constant USDC = Currency.wrap(address(0x05DC));
    Currency constant CLAIM = Currency.wrap(address(0xC1A1));

    RipsResaleHook hook;
    HumanRegistry registry;
    MockRouter router;
    address alice = address(0xA11CE);
    address bob = address(0xB0B);

    function setUp() public {
        registry = new HumanRegistry(address(this), address(this), address(0), 0);
        registry.onReport("", abi.encode(alice, uint256(1)));
        address at = address(uint160(0x4444 << 14) | FLAGS);
        deployCodeTo(
            "RipsResaleHook.sol:RipsResaleHook", abi.encode(POOL_MANAGER, registry, USDC, address(this)), at
        );
        hook = RipsResaleHook(at);
        router = new MockRouter();
        hook.setTrustedRouter(address(router), true);
    }

    function _key() internal view returns (PoolKey memory) {
        return PoolKey({currency0: USDC, currency1: CLAIM, fee: 3000, tickSpacing: 60, hooks: IHooks(address(hook))});
    }

    function _swap(address sender) internal {
        vm.prank(POOL_MANAGER);
        hook.beforeSwap(sender, _key(), SwapParams(true, -1e6, 0), "");
    }

    function _addLiquidity(address sender) internal {
        vm.prank(POOL_MANAGER);
        hook.beforeAddLiquidity(sender, _key(), ModifyLiquidityParams(-60, 60, 1e18, 0), "");
    }

    function test_verifiedHumanTradesThroughTheRouter() public {
        router.act(alice);
        _swap(address(router));
        _addLiquidity(address(router));
    }

    function test_unverifiedUserIsRejectedThroughTheRouter() public {
        router.act(bob);
        vm.expectRevert(abi.encodeWithSelector(RipsResaleHook.NotVerifiedHuman.selector, bob));
        _swap(address(router));
        vm.expectRevert(abi.encodeWithSelector(RipsResaleHook.NotVerifiedHuman.selector, bob));
        _addLiquidity(address(router));
    }

    function test_otherCallersAreCheckedThemselves() public {
        _swap(alice);
        vm.expectRevert(abi.encodeWithSelector(RipsResaleHook.NotVerifiedHuman.selector, bob));
        _swap(bob);
    }

    function test_quoterAndHouseAreExempt() public {
        address quoter = address(0x0E);
        hook.setExempt(quoter, true);
        _swap(quoter);
        address house = address(0x4005E);
        hook.setExempt(house, true);
        router.act(house);
        _addLiquidity(address(router));
    }

    function test_verificationExpiryClosesAccess() public {
        router.act(alice);
        vm.warp(block.timestamp + registry.validity());
        vm.expectRevert(abi.encodeWithSelector(RipsResaleHook.NotVerifiedHuman.selector, alice));
        _swap(address(router));
    }

    function test_onlyThePoolManagerCalls() public {
        vm.expectRevert(RipsResaleHook.NotPoolManager.selector);
        hook.beforeSwap(alice, _key(), SwapParams(true, -1e6, 0), "");
    }

    function test_onlyOwnerOpensUsdcPools() public {
        vm.prank(POOL_MANAGER);
        hook.beforeInitialize(address(this), _key(), 1 << 96);

        vm.prank(POOL_MANAGER);
        vm.expectRevert(RipsResaleHook.PoolNotAllowed.selector);
        hook.beforeInitialize(alice, _key(), 1 << 96);

        PoolKey memory noUsdc = _key();
        noUsdc.currency0 = Currency.wrap(address(0xDEAD));
        vm.prank(POOL_MANAGER);
        vm.expectRevert(RipsResaleHook.PoolNotAllowed.selector);
        hook.beforeInitialize(address(this), noUsdc, 1 << 96);
    }

    /// Whoever the router acts for, and whoever calls directly, only verified humans and exempt accounts pass.
    function testFuzz_onlyVerifiedOrExemptTrade(address user, bool viaRouter) public {
        vm.assume(user != alice && user != address(router));
        router.act(user);
        vm.expectRevert(abi.encodeWithSelector(RipsResaleHook.NotVerifiedHuman.selector, user));
        _swap(viaRouter ? address(router) : user);

        hook.setExempt(user, true);
        _swap(viaRouter ? address(router) : user);
    }

    function test_addressMustCarryTheHookFlags() public {
        vm.expectRevert();
        new RipsResaleHook(IPoolManager(POOL_MANAGER), IHumanGate(address(registry)), USDC, address(this));
    }
}
