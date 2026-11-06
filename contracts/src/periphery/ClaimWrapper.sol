// SPDX-License-Identifier: Apache-2.0
pragma solidity 0.8.28;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {IERC6909} from "@openzeppelin/contracts/interfaces/IERC6909.sol";
import {Errors} from "../libraries/Errors.sol";

/// @title ClaimWrapper
/// @notice A plain ERC-20 over one claim id, so `P` or `N` can be listed on an
///         AMM.
///
/// @dev This is the cost side of the singleton design. On Solana `P` and `N`
///      were SPL mints and listed anywhere directly; here they are ERC-6909 ids
///      and need this to reach Aerodrome or Uniswap.
///
///      It is deliberately dumb: one id, one wrapper, 1:1, no fees, no rebasing,
///      no admin, nothing upgradeable. The wrapper holds claim tokens and
///      nothing else — it never touches collateral, never settles, and has no
///      privileged relationship with the vault.
///
///      **A wrapped claim is still the same claim.** Wrapping does not insulate
///      a holder from a seizure, a shortfall or a corporate action: the wrapper
///      just holds the id, and everything §6 and §7 say still applies to what it
///      redeems for. It also does not redeem on anyone's behalf — a holder must
///      unwrap before redeeming.
contract ClaimWrapper is ERC20 {
    IERC6909 public immutable vault;
    uint256 public immutable id;

    event Wrapped(address indexed who, uint256 amount);
    event Unwrapped(address indexed who, uint256 amount);

    constructor(IERC6909 vault_, uint256 id_, string memory name_, string memory symbol_)
        ERC20(name_, symbol_)
    {
        if (address(vault_) == address(0)) revert Errors.InvalidParams();
        vault = vault_;
        id = id_;
    }

    /// @notice Deposit claim tokens and receive the ERC-20 1:1.
    /// @dev Requires the caller to have approved this wrapper on the vault for
    ///      `id` (or set it as an operator).
    function wrap(uint256 amount) external {
        if (amount == 0) revert Errors.InvalidAmount();
        // Measure what arrived rather than trusting the argument.
        uint256 before = vault.balanceOf(address(this), id);
        vault.transferFrom(msg.sender, address(this), id, amount);
        uint256 received = vault.balanceOf(address(this), id) - before;
        if (received == 0) revert Errors.InvalidAmount();
        _mint(msg.sender, received);
        emit Wrapped(msg.sender, received);
    }

    /// @notice Burn the ERC-20 and take the claim tokens back 1:1.
    function unwrap(uint256 amount) external {
        if (amount == 0) revert Errors.InvalidAmount();
        _burn(msg.sender, amount);
        vault.transfer(msg.sender, id, amount);
        emit Unwrapped(msg.sender, amount);
    }
}
