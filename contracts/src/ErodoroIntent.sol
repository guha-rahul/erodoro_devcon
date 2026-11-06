// SPDX-License-Identifier: Apache-2.0
pragma solidity 0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {IERC6909} from "@openzeppelin/contracts/interfaces/IERC6909.sol";
import {EIP712} from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import {SignatureChecker} from "@openzeppelin/contracts/utils/cryptography/SignatureChecker.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {Errors} from "./libraries/Errors.sol";

/// @title ErodoroIntent
/// @notice Permissionless upside sale without a pre-onboarded market maker.
///
/// @dev The seller pre-splits stock into P+N via the vault, then signs a
///      `SellIntent` off-chain. Any buyer can fill it on-chain by paying at
///      least the seller's floor. Signing never moves funds and costs no gas;
///      only settlement hits the chain.
///
///      Economics are unchanged from the RFQ path: the seller keeps P, the
///      buyer receives N, the seller receives USDC. A failed auction leaves
///      the seller holding P+N, which is recoverable via `merge` on the vault.
///      This contract never holds funds and has no withdrawal path.
///
///      The intent binds collateral, strike and maturity explicitly and checks
///      them against the vault's series config, so a coordinator cannot alter
///      terms without breaking the signature AND the on-chain check.
contract ErodoroIntent is EIP712, ReentrancyGuard {
    using SafeERC20 for IERC20;

    /// @notice A seller's standing offer to sell N claims above a floor.
    struct SellIntent {
        /// @dev Who holds the N claims and receives the premium.
        address seller;
        /// @dev The ERC-6909 vault the claim lives in.
        address claims;
        /// @dev Must be an N id (low bit 1) on `claims`.
        uint256 claimId;
        /// @dev Vault collateral (B20 stock) the series was written against.
        address collateral;
        /// @dev Series strike, in the series' own priceDecimals.
        uint256 strike;
        /// @dev Series maturity (unix seconds).
        uint64 maturity;
        /// @dev Total N units offered.
        uint256 claimAmount;
        /// @dev Payment token, normally USDC.
        address quoteToken;
        /// @dev Floor premium for the FULL amount. Partials are pro-rated
        ///      with ceiling division so rounding never favors the buyer.
        uint256 minPremium;
        /// @dev Single use per seller. Fill completion or cancellation burns it.
        uint256 nonce;
        /// @dev First second the intent is fillable.
        uint256 validFrom;
        /// @dev Last second the intent is fillable.
        uint256 validUntil;
        /// @dev False means fill-or-kill: only the full amount may fill.
        bool allowPartial;
        /// @dev Off-chain signal only: may the coordinator roll this into the
        ///      next batch on expiry. Not enforced here.
        bool allowRollover;
    }

    bytes32 private constant INTENT_TYPEHASH = keccak256(
        "SellIntent(address seller,address claims,uint256 claimId,address collateral,uint256 strike,uint64 maturity,uint256 claimAmount,address quoteToken,uint256 minPremium,uint256 nonce,uint256 validFrom,uint256 validUntil,bool allowPartial,bool allowRollover)"
    );

    /// @notice Claim units already filled, per intent digest.
    mapping(bytes32 intentHash => uint256 filled) public filledOf;
    /// @notice Burned nonces per seller (filled-through or cancelled).
    mapping(address seller => mapping(uint256 nonce => bool)) public nonceUsed;

    event IntentFilled(
        bytes32 indexed intentHash,
        address indexed seller,
        address indexed buyer,
        uint256 claimId,
        uint256 fillAmount,
        uint256 premium,
        uint256 nonce
    );
    event IntentCancelled(bytes32 indexed intentHash, address indexed seller, uint256 nonce);

    error IntentNotActive(uint256 validFrom);
    error IntentExpired(uint256 validUntil);
    error IntentAlreadyUsed(uint256 nonce);
    error BadSignature();
    error PremiumBelowFloor(uint256 premium, uint256 required);
    error PartialNotAllowed();
    error Overfill(uint256 requested, uint256 remaining);
    error NotNClaim(uint256 claimId);
    error SeriesMismatch();
    error UnauthorizedCancel();

    constructor() EIP712("ErodoroIntent", "1") {}

    /// @notice The digest the seller signs. Exposed so wallets and the
    ///         coordinator agree on it without reimplementing the encoding.
    /// @dev The struct hash is the standard EIP-712 encoding
    ///      `keccak256(abi.encode(TYPEHASH, <all 14 fields>))`. It is built
    ///      from two sequential `abi.encode` calls only because one 15-word
    ///      encode exceeds the legacy codegen stack depth; for static value
    ///      types concatenation of the two word streams is byte-identical to
    ///      a single encode, so the digest matches what wallets sign.
    function hashIntent(SellIntent calldata intent) public view returns (bytes32) {
        bytes memory head = abi.encode(
            INTENT_TYPEHASH,
            intent.seller,
            intent.claims,
            intent.claimId,
            intent.collateral,
            intent.strike,
            intent.maturity,
            intent.claimAmount
        );
        bytes memory tail = abi.encode(
            intent.quoteToken,
            intent.minPremium,
            intent.nonce,
            intent.validFrom,
            intent.validUntil,
            intent.allowPartial,
            intent.allowRollover
        );
        return _hashTypedDataV4(keccak256(bytes.concat(head, tail)));
    }

    /// @notice Fill (possibly partially) a signed sell intent by paying premium.
    /// @dev Called by the BUYER. Requires the seller to have made this
    ///      contract an operator on the claims contract, and the buyer to have
    ///      approved it for the quote token. Both legs move atomically.
    function fillIntent(
        SellIntent calldata intent,
        bytes calldata sellerSignature,
        uint256 fillAmount,
        uint256 premium
    ) external nonReentrant {
        bytes32 digest = hashIntent(intent);
        _requireFillable(intent, digest, sellerSignature, fillAmount, premium);

        // CEI: book the fill before touching tokens.
        filledOf[digest] += fillAmount;
        if (filledOf[digest] == intent.claimAmount) {
            nonceUsed[intent.seller][intent.nonce] = true;
        }

        // N to the buyer, premium to the seller. Both or neither.
        // Fee-on-transfer quote tokens are NOT supported: the seller-side
        // receipt is checked below so a fee'd token reverts instead of
        // silently underpaying.
        IERC6909(intent.claims).transferFrom(intent.seller, msg.sender, intent.claimId, fillAmount);
        uint256 before = IERC20(intent.quoteToken).balanceOf(intent.seller);
        IERC20(intent.quoteToken).safeTransferFrom(msg.sender, intent.seller, premium);
        if (IERC20(intent.quoteToken).balanceOf(intent.seller) < before + premium) {
            revert PremiumBelowFloor(premium, premium);
        }

        emit IntentFilled(digest, intent.seller, msg.sender, intent.claimId, fillAmount, premium, intent.nonce);
    }

    /// @notice Cancel your own unfilled intent. Remainder becomes unfillable.
    function cancelIntent(SellIntent calldata intent) external {
        if (msg.sender != intent.seller) revert UnauthorizedCancel();
        bytes32 digest = hashIntent(intent);
        if (nonceUsed[intent.seller][intent.nonce]) revert IntentAlreadyUsed(intent.nonce);
        nonceUsed[intent.seller][intent.nonce] = true;
        emit IntentCancelled(digest, intent.seller, intent.nonce);
    }

    /// @notice Burn one of your nonces without naming an intent.
    function cancelNonce(uint256 nonce) external {
        nonceUsed[msg.sender][nonce] = true;
        emit IntentCancelled(bytes32(0), msg.sender, nonce);
    }

    /// @notice Whether this fill would succeed now, and why not otherwise.
    function checkIntent(
        SellIntent calldata intent,
        bytes calldata sellerSignature,
        uint256 fillAmount,
        uint256 premium,
        address buyer
    ) external view returns (bool ok, string memory reason) {
        bytes32 digest = hashIntent(intent);
        if (block.timestamp < intent.validFrom) return (false, "Intent not active yet");
        if (block.timestamp > intent.validUntil) return (false, "Intent expired");
        if (nonceUsed[intent.seller][intent.nonce]) return (false, "Intent already used or cancelled");
        if (intent.claimAmount == 0 || fillAmount == 0 || premium == 0) return (false, "Zero amount");
        if ((intent.claimId & 1) != 1) return (false, "Only N claims can be sold");
        if (!SignatureChecker.isValidSignatureNow(intent.seller, digest, sellerSignature)) {
            return (false, "Signature does not match the seller");
        }
        uint256 filled = filledOf[digest];
        if (fillAmount > intent.claimAmount - filled) return (false, "Fill exceeds remaining size");
        if (filled + fillAmount < intent.claimAmount && !intent.allowPartial) {
            return (false, "Partial fill not allowed");
        }
        uint256 required = _requiredPremium(intent, fillAmount);
        if (premium < required) return (false, "Premium below seller floor");
        if (!_seriesMatches(intent)) return (false, "Intent terms do not match the series");
        if (IERC6909(intent.claims).balanceOf(intent.seller, intent.claimId) < fillAmount) {
            return (false, "Seller is short of the upside claim");
        }
        if (!_isOperator(intent.claims, intent.seller, address(this))) {
            return (false, "Seller has not approved the intent contract");
        }
        if (IERC20(intent.quoteToken).balanceOf(buyer) < premium) {
            return (false, "Buyer is short of the quote token");
        }
        if (IERC20(intent.quoteToken).allowance(buyer, address(this)) < premium) {
            return (false, "Buyer has not approved the payment");
        }
        return (true, "");
    }

    /// @notice The EIP-712 domain, for wallets and coordinators to sign against.
    function domainSeparator() external view returns (bytes32) {
        return _domainSeparatorV4();
    }

    // --- Internals -----------------------------------------------------------

    function _requireFillable(
        SellIntent calldata intent,
        bytes32 digest,
        bytes calldata sellerSignature,
        uint256 fillAmount,
        uint256 premium
    ) internal view {
        if (block.timestamp < intent.validFrom) revert IntentNotActive(intent.validFrom);
        if (block.timestamp > intent.validUntil) revert IntentExpired(intent.validUntil);
        if (nonceUsed[intent.seller][intent.nonce]) revert IntentAlreadyUsed(intent.nonce);
        if (intent.claimAmount == 0 || fillAmount == 0 || premium == 0) revert Errors.InvalidAmount();
        if (intent.validFrom > intent.validUntil) revert Errors.InvalidParams();
        if ((intent.claimId & 1) != 1) revert NotNClaim(intent.claimId);
        if (!SignatureChecker.isValidSignatureNow(intent.seller, digest, sellerSignature)) revert BadSignature();
        uint256 filled = filledOf[digest];
        if (fillAmount > intent.claimAmount - filled) {
            revert Overfill(fillAmount, intent.claimAmount - filled);
        }
        if (filled + fillAmount < intent.claimAmount && !intent.allowPartial) revert PartialNotAllowed();
        uint256 required = _requiredPremium(intent, fillAmount);
        if (premium < required) revert PremiumBelowFloor(premium, required);
        if (!_seriesMatches(intent)) revert SeriesMismatch();
    }

    /// @dev Signature is intentionally NOT checked here: `fillIntent` checks
    ///      it via `SignatureChecker` after these guards. Kept separate so the
    ///      ordering (cheap guards first) is explicit. See `fillIntent`.
    function _requiredPremium(SellIntent calldata intent, uint256 fillAmount) internal pure returns (uint256) {
        // Ceiling division: rounding never shaves the seller's floor.
        return (intent.minPremium * fillAmount + intent.claimAmount - 1) / intent.claimAmount;
    }

    /// @dev The claim id's series is the id with the low bit cleared.
    /// @dev Reads (collateral, strike, maturity, exists) by word offset to
    ///      avoid a 22-element abi.decode (stack-too-deep). Offsets mirror
    ///      IErodoroVault.SeriesConfig field order: collateral=1, strike=9,
    ///      maturity=12, exists=21 (zero-based) past the 32-byte length prefix.
    function _seriesMatches(SellIntent calldata intent) internal view returns (bool) {
        uint256 seriesId = intent.claimId & ~uint256(1);
        (bool ok, bytes memory data) = intent.claims.staticcall(
            abi.encodeWithSignature("seriesConfig(uint256)", seriesId)
        );
        if (!ok || data.length < 22 * 32) return false;
        address collateral;
        uint256 strike;
        uint64 maturity;
        bool exists;
        assembly ("memory-safe") {
            collateral := mload(add(add(data, 32), mul(1, 32)))
            strike := mload(add(add(data, 32), mul(9, 32)))
            maturity := mload(add(add(data, 32), mul(12, 32)))
            exists := mload(add(add(data, 32), mul(21, 32)))
        }
        return exists && collateral == intent.collateral && strike == intent.strike
            && maturity == intent.maturity;
    }

    function _isOperator(address claims, address owner, address spender) internal view returns (bool) {
        (bool ok, bytes memory data) =
            claims.staticcall(abi.encodeWithSignature("isOperator(address,address)", owner, spender));
        return ok && data.length == 32 && abi.decode(data, (bool));
    }
}
