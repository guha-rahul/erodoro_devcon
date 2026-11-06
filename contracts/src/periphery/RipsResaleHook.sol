// SPDX-License-Identifier: Apache-2.0
pragma solidity 0.8.28;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {IHooks} from "@uniswap/v4-core/src/interfaces/IHooks.sol";
import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {Hooks} from "@uniswap/v4-core/src/libraries/Hooks.sol";
import {BalanceDelta} from "@uniswap/v4-core/src/types/BalanceDelta.sol";
import {BeforeSwapDelta, BeforeSwapDeltaLibrary} from "@uniswap/v4-core/src/types/BeforeSwapDelta.sol";
import {Currency} from "@uniswap/v4-core/src/types/Currency.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {ModifyLiquidityParams, SwapParams} from "@uniswap/v4-core/src/types/PoolOperation.sol";
import {IHumanGate} from "../identity/IHumanGate.sol";

/// @notice Uniswap's routers report the account they act for.
interface IMsgSender {
    function msgSender() external view returns (address);
}

/// @title RipsResaleHook
/// @notice Uniswap v4 hook for the Rips resale market: pools pairing a wrapped Rip claim (ClaimWrapper over
///         a vault N id) with USDC, where only World ID verified humans can trade or add liquidity.
/// @dev The PoolManager tells a hook which contract called it, not who the user is. Universal Router and
///      PositionManager expose the user through `msgSender()`, so calls through them are checked against the
///      user; any other caller is checked itself. Removing liquidity is never blocked.
contract RipsResaleHook is IHooks, Ownable {
    IPoolManager public immutable poolManager;
    IHumanGate public immutable gate;
    Currency public immutable usdc;

    /// @notice Routers whose `msgSender()` is trusted to name the user.
    mapping(address router => bool) public trustedRouter;
    /// @notice Accounts that trade without verifying: the house market maker, and V4Quoter, whose simulated
    ///         swaps always revert.
    mapping(address account => bool) public exempt;

    event TrustedRouterSet(address indexed router, bool trusted);
    event ExemptSet(address indexed account, bool exempt);

    error NotPoolManager();
    error NotVerifiedHuman(address user);
    error PoolNotAllowed();
    error HookNotImplemented();

    constructor(IPoolManager poolManager_, IHumanGate gate_, Currency usdc_, address owner_) Ownable(owner_) {
        poolManager = poolManager_;
        gate = gate_;
        usdc = usdc_;
        Hooks.validateHookPermissions(
            this,
            Hooks.Permissions({
                beforeInitialize: true,
                afterInitialize: false,
                beforeAddLiquidity: true,
                afterAddLiquidity: false,
                beforeRemoveLiquidity: false,
                afterRemoveLiquidity: false,
                beforeSwap: true,
                afterSwap: false,
                beforeDonate: false,
                afterDonate: false,
                beforeSwapReturnDelta: false,
                afterSwapReturnDelta: false,
                afterAddLiquidityReturnDelta: false,
                afterRemoveLiquidityReturnDelta: false
            })
        );
    }

    modifier onlyPoolManager() {
        if (msg.sender != address(poolManager)) revert NotPoolManager();
        _;
    }

    function setTrustedRouter(address router, bool trusted) external onlyOwner {
        trustedRouter[router] = trusted;
        emit TrustedRouterSet(router, trusted);
    }

    function setExempt(address account, bool isExempt) external onlyOwner {
        exempt[account] = isExempt;
        emit ExemptSet(account, isExempt);
    }

    /// @notice The account a call from `sender` acts for.
    function userOf(address sender) public view returns (address) {
        return trustedRouter[sender] ? IMsgSender(sender).msgSender() : sender;
    }

    /// @dev Only the owner opens resale pools, and each one quotes against USDC.
    function beforeInitialize(address sender, PoolKey calldata key, uint160) external view onlyPoolManager returns (bytes4) {
        if (sender != owner() || !(key.currency0 == usdc || key.currency1 == usdc)) revert PoolNotAllowed();
        return IHooks.beforeInitialize.selector;
    }

    function beforeAddLiquidity(address sender, PoolKey calldata, ModifyLiquidityParams calldata, bytes calldata)
        external
        view
        onlyPoolManager
        returns (bytes4)
    {
        _requireHuman(sender);
        return IHooks.beforeAddLiquidity.selector;
    }

    function beforeSwap(address sender, PoolKey calldata, SwapParams calldata, bytes calldata)
        external
        view
        onlyPoolManager
        returns (bytes4, BeforeSwapDelta, uint24)
    {
        _requireHuman(sender);
        return (IHooks.beforeSwap.selector, BeforeSwapDeltaLibrary.ZERO_DELTA, 0);
    }

    /// @dev An exempt caller (V4Quoter) or user (the house) passes; anyone else must be a verified human. A router
    ///      that names no user (zero) is refused, since zero is never verified.
    function _requireHuman(address sender) internal view {
        if (exempt[sender]) return;
        address user = userOf(sender);
        if (!exempt[user] && !gate.isVerified(user)) revert NotVerifiedHuman(user);
    }

    // Hooks this contract's address doesn't enable; the PoolManager never calls them.

    function afterInitialize(address, PoolKey calldata, uint160, int24) external pure returns (bytes4) {
        revert HookNotImplemented();
    }

    function afterAddLiquidity(
        address,
        PoolKey calldata,
        ModifyLiquidityParams calldata,
        BalanceDelta,
        BalanceDelta,
        bytes calldata
    ) external pure returns (bytes4, BalanceDelta) {
        revert HookNotImplemented();
    }

    function beforeRemoveLiquidity(address, PoolKey calldata, ModifyLiquidityParams calldata, bytes calldata)
        external
        pure
        returns (bytes4)
    {
        revert HookNotImplemented();
    }

    function afterRemoveLiquidity(
        address,
        PoolKey calldata,
        ModifyLiquidityParams calldata,
        BalanceDelta,
        BalanceDelta,
        bytes calldata
    ) external pure returns (bytes4, BalanceDelta) {
        revert HookNotImplemented();
    }

    function afterSwap(address, PoolKey calldata, SwapParams calldata, BalanceDelta, bytes calldata)
        external
        pure
        returns (bytes4, int128)
    {
        revert HookNotImplemented();
    }

    function beforeDonate(address, PoolKey calldata, uint256, uint256, bytes calldata) external pure returns (bytes4) {
        revert HookNotImplemented();
    }

    function afterDonate(address, PoolKey calldata, uint256, uint256, bytes calldata) external pure returns (bytes4) {
        revert HookNotImplemented();
    }
}
