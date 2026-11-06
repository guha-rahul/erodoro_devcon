// SPDX-License-Identifier: Apache-2.0
pragma solidity 0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {IERC6909} from "@openzeppelin/contracts/interfaces/IERC6909.sol";
import {EIP712} from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import {SignatureChecker} from "@openzeppelin/contracts/utils/cryptography/SignatureChecker.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {Errors} from "./libraries/Errors.sol";

/// @title ErodoroRFQ
/// @notice Sell a claim into a market maker's signed quote, in one transaction.
///
/// @dev **Why quotes rather than a book.** A resting order book needs someone to
///      have already posted, and an AMM needs a pool someone has already seeded.
///      Both start empty and stay empty until a market exists. A quote is
///      requested when a seller wants one, so the first seller can be served on
///      day one — which is the whole difficulty with this product.
///
///      The maker never sends a transaction. They sign a quote off-chain and the
///      seller submits it, so the maker pays no gas, keeps custody of their
///      funds until the instant of the fill, and can walk away from an unfilled
///      quote for free by letting it expire.
///
///      The swap is atomic: the claim moves to the maker and the payment moves
///      to the seller inside one call, or neither happens. Nothing is escrowed
///      and this contract never holds either asset — it has no balance to lose
///      and no withdrawal path to get wrong.
///
///      **What a quote is not.** A signature is a firm price from that maker for
///      that size until it expires. It is not a market price, not a valuation,
///      and not a promise anyone else will match it.
contract ErodoroRFQ is EIP712, ReentrancyGuard {
    using SafeERC20 for IERC20;

    /// @notice A firm offer to buy a claim for a fixed payment.
    struct Quote {
        /// @dev The market maker. Pays `quoteAmount` and receives the claim.
        address maker;
        /// @dev Who may fill this. `address(0)` lets anyone.
        address taker;
        /// @dev The ERC-6909 contract the claim lives in.
        address claims;
        uint256 claimId;
        uint256 claimAmount;
        address quoteToken;
        uint256 quoteAmount;
        /// @dev Last second this quote is good for.
        uint256 expiry;
        /// @dev Single use, chosen by the maker.
        uint256 nonce;
    }

    bytes32 private constant QUOTE_TYPEHASH = keccak256(
        "Quote(address maker,address taker,address claims,uint256 claimId,uint256 claimAmount,address quoteToken,uint256 quoteAmount,uint256 expiry,uint256 nonce)"
    );

    /// @notice Nonces already spent or cancelled, per maker.
    mapping(address maker => mapping(uint256 nonce => bool)) public nonceUsed;

    event Filled(
        address indexed maker,
        address indexed taker,
        uint256 indexed claimId,
        uint256 claimAmount,
        address quoteToken,
        uint256 quoteAmount,
        uint256 nonce
    );
    event NonceCancelled(address indexed maker, uint256 nonce);

    error QuoteExpired(uint256 expiry);
    error QuoteNotForYou(address taker);
    error QuoteAlreadyUsed(uint256 nonce);
    error BadSignature();

    constructor() EIP712("ErodoroRFQ", "1") {}

    /// @notice The digest a maker signs. Exposed so a quoting service and a
    ///         wallet can agree on it without reimplementing the encoding.
    function hashQuote(Quote calldata q) public view returns (bytes32) {
        return _hashTypedDataV4(
            keccak256(
                abi.encode(
                    QUOTE_TYPEHASH,
                    q.maker,
                    q.taker,
                    q.claims,
                    q.claimId,
                    q.claimAmount,
                    q.quoteToken,
                    q.quoteAmount,
                    q.expiry,
                    q.nonce
                )
            )
        );
    }

    /// @notice Sell `claimAmount` of the claim into `q`, receiving `quoteAmount`.
    ///
    /// @dev Called by the **seller**, not the maker. Requires the seller to have
    ///      made this contract an operator on the claims contract, and the maker
    ///      to have approved it for the quote token.
    ///
    ///      `SignatureChecker` is used rather than plain `ECDSA` so a maker can
    ///      be a smart contract — a desk running a multisig or a session key is
    ///      the normal case, not the exception.
    function fill(Quote calldata q, bytes calldata signature) external nonReentrant {
        if (block.timestamp > q.expiry) revert QuoteExpired(q.expiry);
        if (q.taker != address(0) && q.taker != msg.sender) revert QuoteNotForYou(q.taker);
        if (q.claimAmount == 0 || q.quoteAmount == 0) revert Errors.InvalidAmount();
        if (nonceUsed[q.maker][q.nonce]) revert QuoteAlreadyUsed(q.nonce);
        if (!SignatureChecker.isValidSignatureNow(q.maker, hashQuote(q), signature)) revert BadSignature();

        nonceUsed[q.maker][q.nonce] = true;

        // Claim to the maker, payment to the seller. Both or neither.
        IERC6909(q.claims).transferFrom(msg.sender, q.maker, q.claimId, q.claimAmount);
        IERC20(q.quoteToken).safeTransferFrom(q.maker, msg.sender, q.quoteAmount);

        emit Filled(q.maker, msg.sender, q.claimId, q.claimAmount, q.quoteToken, q.quoteAmount, q.nonce);
    }

    /// @notice Invalidate one of your own quotes before it expires.
    /// @dev The only way a maker touches the chain. Pulling a live quote should
    ///      not require waiting out its expiry.
    function cancelNonce(uint256 nonce) external {
        nonceUsed[msg.sender][nonce] = true;
        emit NonceCancelled(msg.sender, nonce);
    }

    /// @notice Whether this quote would fill right now, and why not if it would not.
    /// @dev Lets an interface refuse to show a `Sell` button it knows would
    ///      revert, instead of finding out in the user's wallet.
    function checkQuote(Quote calldata q, bytes calldata signature, address taker)
        external
        view
        returns (bool ok, string memory reason)
    {
        if (block.timestamp > q.expiry) return (false, "Quote expired");
        if (q.taker != address(0) && q.taker != taker) return (false, "Quote is for another address");
        if (nonceUsed[q.maker][q.nonce]) return (false, "Quote already used or cancelled");
        if (!SignatureChecker.isValidSignatureNow(q.maker, hashQuote(q), signature)) {
            return (false, "Signature does not match the maker");
        }
        if (IERC20(q.quoteToken).balanceOf(q.maker) < q.quoteAmount) {
            return (false, "Market maker is short of the quote token");
        }
        if (IERC20(q.quoteToken).allowance(q.maker, address(this)) < q.quoteAmount) {
            return (false, "Market maker has not approved the payment");
        }
        return (true, "");
    }

    /// @notice The EIP-712 domain, for a quoting service to sign against.
    function domainSeparator() external view returns (bytes32) {
        return _domainSeparatorV4();
    }
}
