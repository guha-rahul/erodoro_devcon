// SPDX-License-Identifier: Apache-2.0
pragma solidity 0.8.28;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/// @notice A B20 Asset stand-in for unit tests, covering both live chain shapes.
///
/// @dev base-std ships `MockB20Factory` for the factory precompile, but the
///      protocol only needs three things from the collateral: ERC-20 behaviour,
///      the multiplier surface, and a way for the issuer to take collateral out
///      of a vault. This mock provides exactly those, on both sides of the
///      Cobalt boundary:
///
///      - **Beryl (`berylMode = true`)**: `multiplier()` and the instant
///        `updateMultiplier` only. `effectiveAt()` reverts, exactly as a call to
///        a selector the precompile does not implement would. Seizure is
///        `burnBlocked` + re-mint.
///      - **Cobalt (`berylMode = false`)**: adds the ERC-8056 scheduled surface
///        and `seizeWithMemo`.
///
///      Function names match the spec so the selectors match too — `multiplier()`
///      is `0x1b3ed722` and `effectiveAt()` is `0x97a4064f`, which is what the
///      vault's capability probe dispatches on.
contract MockB20Asset is ERC20 {
    bytes32 private constant _DEFAULT_ADMIN_ROLE = bytes32(0);
    bytes32 private constant _MINT_ROLE = keccak256("MINT_ROLE");
    bytes32 private constant _PAUSE_ROLE = keccak256("PAUSE_ROLE");
    bytes32 private constant _UNPAUSE_ROLE = keccak256("UNPAUSE_ROLE");
    bytes32 private constant _OPERATOR_ROLE = keccak256("OPERATOR_ROLE");

    uint8 private immutable _decimals;

    uint256 private _multiplier = 1e18;
    uint256 private _pendingMultiplier;
    uint256 private _effectiveAt;

    /// @notice When true, the scheduled-multiplier surface does not exist.
    bool public berylMode;
    mapping(bytes32 role => mapping(address account => bool)) private _roles;

    error NoPendingSurface();
    error EffectiveAtInPast(uint256 at);
    error InvalidMultiplier();
    error AccessControlUnauthorizedAccount(address account, bytes32 neededRole);

    event Seized(address indexed caller, address indexed from, address indexed to, uint256 amount);
    event BurnedBlocked(address indexed caller, address indexed from, uint256 amount);

    constructor(string memory name_, string memory symbol_, uint8 dec, bool beryl) ERC20(name_, symbol_) {
        _decimals = dec;
        berylMode = beryl;
        _roles[_DEFAULT_ADMIN_ROLE][msg.sender] = true;
        _roles[_MINT_ROLE][msg.sender] = true;
        _roles[_PAUSE_ROLE][msg.sender] = true;
        _roles[_UNPAUSE_ROLE][msg.sender] = true;
        _roles[_OPERATOR_ROLE][msg.sender] = true;
    }

    // --- Test role surface ---------------------------------------------------

    function DEFAULT_ADMIN_ROLE() external pure returns (bytes32) {
        return _DEFAULT_ADMIN_ROLE;
    }

    function MINT_ROLE() external pure returns (bytes32) {
        return _MINT_ROLE;
    }

    function PAUSE_ROLE() external pure returns (bytes32) {
        return _PAUSE_ROLE;
    }

    function UNPAUSE_ROLE() external pure returns (bytes32) {
        return _UNPAUSE_ROLE;
    }

    function OPERATOR_ROLE() external pure returns (bytes32) {
        return _OPERATOR_ROLE;
    }

    function hasRole(bytes32 role, address account) external view returns (bool) {
        return _roles[role][account];
    }

    function grantRole(bytes32 role, address account) external {
        require(_roles[_DEFAULT_ADMIN_ROLE][msg.sender], "B20: not admin");
        _roles[role][account] = true;
    }

    function decimals() public view override returns (uint8) {
        return _decimals;
    }

    function WAD_PRECISION() external pure returns (uint256) {
        return 1e18;
    }

    function MAX_UI_MULTIPLIER() external pure returns (uint256) {
        return type(uint128).max;
    }

    // --- Multiplier ----------------------------------------------------------

    /// @notice Lazily-evaluated effective multiplier.
    /// @dev Matches Cobalt's semantics: once `effectiveAt` passes the flipped
    ///      value is *computed on read* and the pre-flip value is never written
    ///      back. That irreversibility is the reason
    ///      `StrikeMath.resolveMultiplier` has to reject rather than resolve.
    function multiplier() public view returns (uint256) {
        if (_effectiveAt != 0 && block.timestamp >= _effectiveAt) return _pendingMultiplier;
        return _multiplier;
    }

    function scaledBalanceOf(address account) external view returns (uint256) {
        return balanceOf(account) * multiplier() / 1e18;
    }

    /// @notice ERC-8056 pending-schedule read. Absent before Cobalt.
    function effectiveAt() external view returns (uint256) {
        if (berylMode) revert NoPendingSurface();
        return _effectiveAt;
    }

    function newUIMultiplier() external view returns (uint256) {
        if (berylMode) revert NoPendingSurface();
        return _effectiveAt == 0 ? multiplier() : _pendingMultiplier;
    }

    /// @notice Schedule a corporate action. Cobalt only.
    function updateUIMultiplier(uint256 newMultiplier, uint256 at) external {
        if (berylMode) revert NoPendingSurface();
        if (newMultiplier == 0 || newMultiplier > type(uint128).max) revert InvalidMultiplier();
        if (at <= block.timestamp) revert EffectiveAtInPast(at);
        _foldMatured();
        _pendingMultiplier = newMultiplier;
        _effectiveAt = at;
    }

    /// @notice The deprecated instant failsafe. Present on every release.
    function updateMultiplier(uint256 newMultiplier) external {
        if (newMultiplier == 0 || newMultiplier > type(uint128).max) revert InvalidMultiplier();
        _multiplier = newMultiplier;
        _pendingMultiplier = 0;
        _effectiveAt = 0;
    }

    function _foldMatured() internal {
        if (_effectiveAt != 0 && block.timestamp >= _effectiveAt) {
            _multiplier = _pendingMultiplier;
            _pendingMultiplier = 0;
            _effectiveAt = 0;
        }
    }

    // --- Pause ---------------------------------------------------------------

    /// @dev Mirrors the live enum: TRANSFER, MINT, BURN.
    enum PausableFeature {
        TRANSFER,
        MINT,
        BURN
    }

    mapping(uint8 => bool) private _paused;
    mapping(address => bool) public denied;

    function setDenied(address account, bool value) external {
        denied[account] = value;
    }

    function isPaused(PausableFeature feature) external view returns (bool) {
        return _paused[uint8(feature)];
    }

    /// @dev Array-shaped, matching the real interface. A mock that takes a
    ///      single feature would let a caller compile against a signature the
    ///      live token does not have.
    function pause(PausableFeature[] calldata features) external {
        if (!_roles[_PAUSE_ROLE][msg.sender]) {
            revert AccessControlUnauthorizedAccount(msg.sender, _PAUSE_ROLE);
        }
        for (uint256 i = 0; i < features.length; i++) {
            _paused[uint8(features[i])] = true;
        }
    }

    function unpause(PausableFeature[] calldata features) external {
        if (!_roles[_UNPAUSE_ROLE][msg.sender]) {
            revert AccessControlUnauthorizedAccount(msg.sender, _UNPAUSE_ROLE);
        }
        for (uint256 i = 0; i < features.length; i++) {
            _paused[uint8(features[i])] = false;
        }
    }

    /// @dev A transfer pause has to actually stop transfers, or a test that
    ///      pauses and then transfers would pass while the real token reverts.
    function _update(address from, address to, uint256 value) internal override {
        require(!_paused[uint8(PausableFeature.TRANSFER)], "B20: transfers paused");
        require(!denied[from] && !denied[to], "B20: policy denied");
        super._update(from, to, value);
    }

    // --- Issuer levers -------------------------------------------------------

    /// @notice Cobalt seizure: reassigns a balance directly.
    function seizeWithMemo(address from, address to, uint256 amount, bytes32) external {
        if (berylMode) revert NoPendingSurface();
        _transfer(from, to, amount);
        emit Seized(msg.sender, from, to, amount);
    }

    /// @notice Beryl seizure: burn the blocked balance, then re-mint elsewhere.
    /// @dev The pre-Cobalt path. `totalSupply` moves twice and the events read
    ///      as a burn, which is precisely why Cobalt replaced it.
    function burnBlocked(address from, uint256 amount) external {
        _burn(from, amount);
        emit BurnedBlocked(msg.sender, from, amount);
    }

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }
}
