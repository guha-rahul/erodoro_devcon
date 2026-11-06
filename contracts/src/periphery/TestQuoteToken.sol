// SPDX-License-Identifier: Apache-2.0
pragma solidity 0.8.28;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {EIP712} from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";

/// @title TestQuoteToken
/// @notice A mintable stand-in for the quote currency, for testnets only.
///
/// @dev Base has a canonical USDC and that is what a real deployment quotes
///      against. This exists because a testnet account has none, and a sale
///      cannot be demonstrated without something to pay with.
///
///      **Anyone can mint it.** That is the point on a testnet and a disaster
///      anywhere else, so the constructor refuses to deploy on mainnet rather
///      than relying on nobody making a mistake.
///
///      It implements EIP-3009 `transferWithAuthorization` /
///      `receiveWithAuthorization` because the real USDC does, and the auction
///      house captures a signed authorization rather than relying on a
///      pre-existing allowance. The EIP-712 domain mirrors USDC (`version`
///      `"2"`), so the same signing code works against the mainnet token.
contract TestQuoteToken is ERC20, EIP712 {
    uint256 private constant BASE_MAINNET = 8453;

    bytes32 public constant TRANSFER_WITH_AUTHORIZATION_TYPEHASH = keccak256(
        "TransferWithAuthorization(address from,address to,uint256 value,uint256 validAfter,uint256 validBefore,bytes32 nonce)"
    );
    bytes32 public constant RECEIVE_WITH_AUTHORIZATION_TYPEHASH = keccak256(
        "ReceiveWithAuthorization(address from,address to,uint256 value,uint256 validAfter,uint256 validBefore,bytes32 nonce)"
    );
    bytes32 public constant CANCEL_AUTHORIZATION_TYPEHASH =
        keccak256("CancelAuthorization(address authorizer,bytes32 nonce)");

    /// @notice Whether an authorizer has used or cancelled a nonce.
    mapping(address authorizer => mapping(bytes32 nonce => bool used)) public authorizationState;

    event AuthorizationUsed(address indexed authorizer, bytes32 indexed nonce);
    event AuthorizationCanceled(address indexed authorizer, bytes32 indexed nonce);

    error NotForMainnet();
    error AuthorizationExpired();
    error AuthorizationNotYetValid();
    error AuthorizationAlreadyUsed();
    error CallerMustBePayee();
    error InvalidSignature();

    constructor() ERC20("Test USD", "tUSDC") EIP712("Test USD", "2") {
        if (block.chainid == BASE_MAINNET) revert NotForMainnet();
    }

    function decimals() public pure override returns (uint8) {
        return 6;
    }

    /// @dev Mirrors USDC's public getter so callers can build the EIP-712 digest.
    function DOMAIN_SEPARATOR() external view returns (bytes32) {
        return _domainSeparatorV4();
    }

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }

    /// @notice Move `value` from `from` to `to` when `from` has signed for it.
    function transferWithAuthorization(
        address from,
        address to,
        uint256 value,
        uint256 validAfter,
        uint256 validBefore,
        bytes32 nonce,
        uint8 v,
        bytes32 r,
        bytes32 s
    ) external {
        _requireValidAuthorization(from, nonce, validAfter, validBefore);
        _requireSignature(
            from,
            keccak256(abi.encode(TRANSFER_WITH_AUTHORIZATION_TYPEHASH, from, to, value, validAfter, validBefore, nonce)),
            v,
            r,
            s
        );
        _markAuthorizationUsed(from, nonce);
        _transfer(from, to, value);
    }

    /// @notice Like `transferWithAuthorization`, but only the payee may submit.
    /// @dev This is the variant the auction house uses: the `to` address is the
    ///      caller, so a third party cannot consume someone else's signature.
    function receiveWithAuthorization(
        address from,
        address to,
        uint256 value,
        uint256 validAfter,
        uint256 validBefore,
        bytes32 nonce,
        uint8 v,
        bytes32 r,
        bytes32 s
    ) external {
        if (to != msg.sender) revert CallerMustBePayee();
        _requireValidAuthorization(from, nonce, validAfter, validBefore);
        _requireSignature(
            from,
            keccak256(abi.encode(RECEIVE_WITH_AUTHORIZATION_TYPEHASH, from, to, value, validAfter, validBefore, nonce)),
            v,
            r,
            s
        );
        _markAuthorizationUsed(from, nonce);
        _transfer(from, to, value);
    }

    /// @notice Revoke an unused authorization.
    function cancelAuthorization(address authorizer, bytes32 nonce, uint8 v, bytes32 r, bytes32 s) external {
        if (authorizationState[authorizer][nonce]) revert AuthorizationAlreadyUsed();
        _requireSignature(authorizer, keccak256(abi.encode(CANCEL_AUTHORIZATION_TYPEHASH, authorizer, nonce)), v, r, s);
        authorizationState[authorizer][nonce] = true;
        emit AuthorizationCanceled(authorizer, nonce);
    }

    function _requireValidAuthorization(address authorizer, bytes32 nonce, uint256 validAfter, uint256 validBefore)
        internal
        view
    {
        if (authorizationState[authorizer][nonce]) revert AuthorizationAlreadyUsed();
        if (block.timestamp <= validAfter) revert AuthorizationNotYetValid();
        if (block.timestamp >= validBefore) revert AuthorizationExpired();
    }

    function _requireSignature(address signer, bytes32 structHash, uint8 v, bytes32 r, bytes32 s) internal view {
        if (ECDSA.recover(_hashTypedDataV4(structHash), v, r, s) != signer) revert InvalidSignature();
    }

    function _markAuthorizationUsed(address authorizer, bytes32 nonce) internal {
        authorizationState[authorizer][nonce] = true;
        emit AuthorizationUsed(authorizer, nonce);
    }
}
