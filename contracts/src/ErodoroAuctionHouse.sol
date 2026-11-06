// SPDX-License-Identifier: Apache-2.0
pragma solidity 0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {IERC6909} from "@openzeppelin/contracts/interfaces/IERC6909.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

import {IErodoroVault} from "./interfaces/IErodoroVault.sol";
import {Errors} from "./libraries/Errors.sol";

/// @dev The vault exposes `seriesConfig` beyond the shared interface, which
///      carries only the types and events. Declared here so the house can read
///      the terms it binds a listing to without importing the full vault.
interface IVaultSeries {
    function seriesConfig(uint256 seriesId) external view returns (IErodoroVault.SeriesConfig memory);
}

/// @dev The EIP-3009 surface the quote token must expose for signature-funded
///      bids. `receiveWithAuthorization` requires `to == msg.sender`, so only
///      this contract can consume a bidder's authorization for itself.
interface IEIP3009 {
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
    ) external;
}

/// @title ErodoroAuctionHouse
/// @notice Enumerable, fully funded, on-chain upside auction.
///
/// @dev The coordinator is not the source of truth. This contract stores every
///      auction, escrows the seller's `N` claims before a listing opens, escrows
///      each bidder's quote token before a bid counts, and moves both legs
///      atomically on `finalizeAuction`. The app therefore needs no database to
///      list what is live or to read a wallet's positions; a bounded scan of
///      `getActiveAuctions` is enough.
///
///      Policy and the reasons behind it:
///
///      1. **Full-size, funded bids only.** `placeBid` requires the bid to cover
///         the whole listed quantity. Partial fills are not offered here because
///         they would force per-bid pro-rating, a second `escrowedOf`-style
///         ledger and a rounding policy that the vault already owns. Sellers who
///         want partials use the signed `ErodoroIntent` path.
///      2. **Strictly increasing premiums.** A tie would need a "first seen"
///         clock, which is exactly the off-chain ordering this contract
///         replaces. A bid must beat the standing best outright.
///      3. **Pull refunds.** When a bid is displaced its premium becomes
///         withdrawable rather than being pushed out, so a hostile bidder cannot
///         block a better bid by reverting on receive.
///      4. **Permissionless completion.** `finalizeAuction` and the no-bid
///         `rolloverAuction` pay the caller nothing but are open to anyone,
///         because a contract cannot wake itself at the deadline. The UI always
///         surfaces the required transaction after `endTime`.
contract ErodoroAuctionHouse is ReentrancyGuard {
    using SafeERC20 for IERC20;

    uint256 internal constant BPS_DENOMINATOR = 10_000;
    uint256 internal constant MAX_PROTOCOL_FEE_BPS = 1_000;
    uint64 internal constant MIN_AUCTION_SECONDS = 60;
    uint64 internal constant MAX_AUCTION_SECONDS = 1_800;

    /// @notice The single currency every bid is denominated in. Fixed at deploy
    ///         so refunds share one balance and one approval target.
    IERC20 public immutable quoteToken;

    address public admin;
    address public feeRecipient;
    uint16 public protocolFeeBps;
    /// @notice Optional referral leg, paid from the same premium as the
    ///         protocol fee. Zero disables it and keeps the old behaviour.
    address public referralRecipient;
    uint16 public referralFeeBps;

    struct Auction {
        uint256 id;
        address seller;
        address claims; // ERC-6909 vault holding the N claim
        uint256 claimId; // N id (low bit set)
        address collateral; // B20 stock, read from the series
        uint256 strike; // series strike, for display only
        uint64 maturity; // series maturity, blocks an already-closed market
        uint256 quantity; // N units listed, full-size only
        uint256 floor; // minimum premium for the full quantity
        uint64 startTime;
        uint64 endTime;
        uint64 duration;
        address bestBidder;
        uint256 bestPremium;
        uint32 rolloverCount;
        bool allowRollover;
        bool finalized;
        bool cancelled;
    }

    struct CreateParams {
        address claims;
        uint256 claimId;
        uint256 quantity;
        uint256 floor;
        uint64 durationSeconds;
        bool allowRollover;
    }

    /// @notice A bidder's standing, derived entirely from on-chain state.
    /// @dev `Outbid` covers a displaced bidder whose premium is withdrawable.
    ///      A settled bid is `Won` — `finalizeAuction` moves the legs in the
    ///      same transaction, so there is no window where a winner is unfunded.
    enum BidStatus {
        None,
        Funded,
        Outbid,
        Won
    }

    /// @notice The three legs of a premium, all decided from on-chain config.
    /// @dev `sellerBps` is derived so the three always total exactly 10,000.
    struct FeeSplitBps {
        uint16 sellerBps;
        uint16 protocolBps;
        uint16 referralBps;
    }

    /// @notice One settlement, carrying every leg under a shared reference.
    struct SettlementRecord {
        bytes32 settlementRef;
        uint256 auctionId;
        address seller;
        address winner;
        uint256 clearingPremium;
        uint256 grossPayment;
        uint256 sellerProceeds;
        uint256 protocolFee;
        uint256 referralFee;
    }

    mapping(uint256 auctionId => Auction) private _auctions;
    uint256[] private _auctionIds;
    mapping(address seller => uint256[] ids) private _sellerAuctions;
    mapping(address bidder => uint256[] ids) private _bidderAuctions;

    /// @notice Quote token a displaced bidder may withdraw.
    mapping(address bidder => uint256 amount) public refundableOf;

    event AuctionCreated(
        uint256 indexed auctionId,
        address indexed seller,
        address indexed claims,
        uint256 claimId,
        uint256 quantity,
        uint256 floor,
        uint64 startTime,
        uint64 endTime,
        bool allowRollover
    );
    event BidPlaced(uint256 indexed auctionId, address indexed bidder, uint256 amount, uint256 premium);
    /// @notice A displaced bidder now has that premium withdrawable.
    event RefundAvailable(uint256 indexed auctionId, address indexed bidder, uint256 premium);
    event RefundWithdrawn(address indexed bidder, uint256 amount);
    event AuctionFinalized(
        uint256 indexed auctionId, address indexed winner, uint256 premium, uint256 sellerProceeds, uint256 protocolFee
    );
    event AuctionRolledOver(uint256 indexed auctionId, uint64 startTime, uint64 endTime, uint32 rolloverCount);
    event AuctionCancelled(uint256 indexed auctionId, address indexed seller);
    event ProtocolFeeChanged(uint16 protocolFeeBps, address indexed feeRecipient);
    event ReferralFeeChanged(uint16 referralFeeBps, address indexed referralRecipient);
    /// @notice Every leg of one settlement, joined by `reference`.
    event Settlement(
        bytes32 indexed settlementRef,
        uint256 indexed auctionId,
        address indexed winner,
        uint256 clearingPremium,
        uint256 grossPayment,
        uint256 sellerProceeds,
        uint256 protocolFee,
        uint256 referralFee
    );

    error AuctionNotFound(uint256 auctionId);
    error AuctionClosed(uint256 auctionId);
    error AuctionStillOpen(uint256 auctionId);
    error AuctionHasBids(uint256 auctionId);
    error NoBid(uint256 auctionId);
    error NotSeller(uint256 auctionId);
    error NotAnNClaim(uint256 claimId);
    error SeriesMismatch();
    error SeriesClosed();
    error BadDuration(uint64 durationSeconds);
    error BidBelowFloor(uint256 premium, uint256 floor);
    error BidNotBest(uint256 premium, uint256 bestPremium);
    error PartialFillNotAllowed(uint256 amount, uint256 quantity);
    error RolloverNotAllowed(uint256 auctionId);
    error NothingToRefund();
    error FeeTooHigh(uint16 protocolFeeBps);
    /// @notice The protocol and referral legs alone would exceed the premium.
    error FeeSplitInvalid(uint16 protocolBps, uint16 referralBps);
    /// @notice Ceiling rounding pushed the two fee legs past the premium.
    error FeeSplitExceedsPremium(uint256 fees, uint256 premium);
    /// @notice A quote token delivered less than the bid premium (fee-on-transfer).
    error QuoteTransferShort(uint256 expected, uint256 received);

    constructor(address admin_, address feeRecipient_, IERC20 quoteToken_, uint16 protocolFeeBps_) {
        if (admin_ == address(0) || feeRecipient_ == address(0) || address(quoteToken_) == address(0)) {
            revert Errors.InvalidParams();
        }
        _setProtocolFee(protocolFeeBps_, feeRecipient_);
        admin = admin_;
        quoteToken = quoteToken_;
    }

    // --- Admin ---------------------------------------------------------------

    function setProtocolFee(uint16 bps, address recipient) external {
        if (msg.sender != admin) revert Errors.Unauthorized();
        _setProtocolFee(bps, recipient);
    }

    /// @notice Set the referral leg. A zero bps or zero recipient disables it.
    function setReferralFee(uint16 bps, address recipient) external {
        if (msg.sender != admin) revert Errors.Unauthorized();
        if (bps > 0 && recipient == address(0)) revert Errors.InvalidParams();
        if (uint256(protocolFeeBps) + bps > BPS_DENOMINATOR) revert FeeSplitInvalid(protocolFeeBps, bps);
        referralFeeBps = bps;
        referralRecipient = recipient;
        emit ReferralFeeChanged(bps, recipient);
    }

    /// @notice The split, with the seller taking the remainder so the three legs
    ///         always total exactly 10,000 bps.
    function feeSplitBps() external view returns (FeeSplitBps memory) {
        uint16 protocol = protocolFeeBps;
        uint16 referral = referralRecipient == address(0) ? 0 : referralFeeBps;
        return FeeSplitBps({
            sellerBps: uint16(BPS_DENOMINATOR) - protocol - referral,
            protocolBps: protocol,
            referralBps: referral
        });
    }

    function setAdmin(address newAdmin) external {
        if (msg.sender != admin) revert Errors.Unauthorized();
        if (newAdmin == address(0)) revert Errors.InvalidParams();
        admin = newAdmin;
    }

    function _setProtocolFee(uint16 bps, address recipient) internal {
        if (bps > MAX_PROTOCOL_FEE_BPS) revert FeeTooHigh(bps);
        if (recipient == address(0)) revert Errors.InvalidParams();
        if (uint256(bps) + referralFeeBps > BPS_DENOMINATOR) revert FeeSplitInvalid(bps, referralFeeBps);
        protocolFeeBps = bps;
        feeRecipient = recipient;
        emit ProtocolFeeChanged(bps, recipient);
    }

    // --- Seller --------------------------------------------------------------

    /// @notice Escrow N and open a funded auction.
    /// @dev The seller must have made this contract an ERC-6909 operator on the
    ///      vault first. Terms are bound to the series so a listing cannot name a
    ///      strike or maturity the vault does not hold.
    function createAuction(CreateParams calldata p) external nonReentrant returns (uint256 auctionId) {
        if (p.quantity == 0 || p.floor == 0) revert Errors.InvalidAmount();
        if ((p.claimId & 1) != 1) revert NotAnNClaim(p.claimId);
        if (p.durationSeconds < MIN_AUCTION_SECONDS || p.durationSeconds > MAX_AUCTION_SECONDS) {
            revert BadDuration(p.durationSeconds);
        }

        (address collateral, uint256 strike, uint64 maturity) = _seriesOf(p.claims, p.claimId);
        if (maturity <= block.timestamp) revert SeriesClosed();

        auctionId = _auctionIds.length;
        uint64 startTime = uint64(block.timestamp);
        uint64 endTime = startTime + p.durationSeconds;

        _auctions[auctionId] = Auction({
            id: auctionId,
            seller: msg.sender,
            claims: p.claims,
            claimId: p.claimId,
            collateral: collateral,
            strike: strike,
            maturity: maturity,
            quantity: p.quantity,
            floor: p.floor,
            startTime: startTime,
            endTime: endTime,
            duration: p.durationSeconds,
            bestBidder: address(0),
            bestPremium: 0,
            rolloverCount: 0,
            allowRollover: p.allowRollover,
            finalized: false,
            cancelled: false
        });
        _auctionIds.push(auctionId);
        _sellerAuctions[msg.sender].push(auctionId);

        // Escrow N before the auction can accept a bid.
        IERC6909(p.claims).transferFrom(msg.sender, address(this), p.claimId, p.quantity);
        if (IERC6909(p.claims).balanceOf(address(this), p.claimId) < p.quantity) {
            revert Errors.InsufficientBalance();
        }

        emit AuctionCreated(
            auctionId, msg.sender, p.claims, p.claimId, p.quantity, p.floor, startTime, endTime, p.allowRollover
        );
    }

    /// @notice Cancel a listing that has attracted no funded bid and take N back.
    function cancelAuction(uint256 auctionId) external nonReentrant {
        Auction storage a = _requireOpen(auctionId);
        if (msg.sender != a.seller) revert NotSeller(auctionId);
        if (a.bestBidder != address(0)) revert AuctionHasBids(auctionId);

        a.cancelled = true;
        IERC6909(a.claims).transfer(a.seller, a.claimId, a.quantity);
        emit AuctionCancelled(auctionId, a.seller);
    }

    // --- Bidder --------------------------------------------------------------

    /// @notice Escrow a full-size premium and take the standing best.
    /// @dev `amount` must equal the listed quantity; see the contract note.
    function placeBid(uint256 auctionId, uint256 amount, uint256 premium) external nonReentrant {
        Auction storage a = _requireOpen(auctionId);
        _requireBiddable(a, auctionId, amount, premium);

        // CEI: book the displacement before pulling the new premium.
        _bookBid(a, auctionId, msg.sender, premium);

        uint256 before = quoteToken.balanceOf(address(this));
        quoteToken.safeTransferFrom(msg.sender, address(this), premium);
        // Fee-on-transfer quote tokens would leave the house holding less than it
        // owes the seller at finalize time. Reject them at the door.
        _requireExactDeposit(before, premium);
        emit BidPlaced(auctionId, msg.sender, amount, premium);
    }

    /// @notice Escrow a full-size premium using an EIP-3009 authorization.
    /// @dev A signature alone is never a funded bid: EIP-3009 does not reserve
    ///      the payer's balance, so the authorization is captured and the quote
    ///      escrowed in this same transaction. If the transfer reverts, the
    ///      whole call reverts and no bid is recorded. The bidder supplies a
    ///      fresh random `nonce` and a short `validAfter`/`validBefore` window.
    function placeBidWithAuthorization(
        uint256 auctionId,
        uint256 amount,
        uint256 premium,
        uint256 validAfter,
        uint256 validBefore,
        bytes32 nonce,
        uint8 v,
        bytes32 r,
        bytes32 s
    ) external nonReentrant {
        Auction storage a = _requireOpen(auctionId);
        _requireBiddable(a, auctionId, amount, premium);

        _bookBid(a, auctionId, msg.sender, premium);

        uint256 before = quoteToken.balanceOf(address(this));
        IEIP3009(address(quoteToken)).receiveWithAuthorization(
            msg.sender, address(this), premium, validAfter, validBefore, nonce, v, r, s
        );
        _requireExactDeposit(before, premium);
        emit BidPlaced(auctionId, msg.sender, amount, premium);
    }

    /// @notice Withdraw every premium this caller had displaced.
    function withdrawRefund() external nonReentrant returns (uint256 amount) {
        amount = refundableOf[msg.sender];
        if (amount == 0) revert NothingToRefund();
        refundableOf[msg.sender] = 0;
        quoteToken.safeTransfer(msg.sender, amount);
        emit RefundWithdrawn(msg.sender, amount);
    }

    // --- Permissionless completion -------------------------------------------

    /// @notice Settle the best bid after the window. Anyone may call.
    /// @dev The premium is split into seller, protocol and optional referral
    ///      legs. The two fee legs are ceiled, so rounding dust lands with the
    ///      designated fee recipients and never silently disappears; the seller
    ///      takes the exact remainder. All legs share one `reference`.
    function finalizeAuction(uint256 auctionId) external nonReentrant {
        Auction storage a = _requireOpen(auctionId);
        if (block.timestamp < a.endTime) revert AuctionStillOpen(auctionId);
        if (a.bestBidder == address(0)) revert NoBid(auctionId);

        a.finalized = true;

        address winner = a.bestBidder;
        uint256 premium = a.bestPremium;
        bool hasReferral = referralRecipient != address(0) && referralFeeBps > 0;
        uint256 protocolFee = _bpsCeil(premium, protocolFeeBps);
        uint256 referralFee = hasReferral ? _bpsCeil(premium, referralFeeBps) : 0;
        uint256 fees = protocolFee + referralFee;
        if (fees > premium) revert FeeSplitExceedsPremium(fees, premium);
        uint256 sellerProceeds = premium - fees;

        bytes32 settlementRef = keccak256(abi.encode(block.chainid, address(this), auctionId, winner, premium));

        // Every leg moves in one transaction. A fee-on-transfer quote token would
        // short the seller, so the house rejects it by construction: `premium`
        // is exactly what `placeBid` pulled in.
        IERC6909(a.claims).transfer(winner, a.claimId, a.quantity);
        if (referralFee > 0) quoteToken.safeTransfer(referralRecipient, referralFee);
        if (protocolFee > 0) quoteToken.safeTransfer(feeRecipient, protocolFee);
        quoteToken.safeTransfer(a.seller, sellerProceeds);

        emit Settlement(
            settlementRef, auctionId, winner, premium, premium, sellerProceeds, protocolFee, referralFee
        );
        emit AuctionFinalized(auctionId, winner, premium, sellerProceeds, protocolFee);
    }

    /// @notice Reopen a no-bid auction for another window. Anyone may call.
    /// @dev Only when the seller opted in. A seller who did not can cancel.
    function rolloverAuction(uint256 auctionId) external nonReentrant {
        Auction storage a = _requireOpen(auctionId);
        if (block.timestamp < a.endTime) revert AuctionStillOpen(auctionId);
        if (a.bestBidder != address(0)) revert AuctionHasBids(auctionId);
        if (!a.allowRollover) revert RolloverNotAllowed(auctionId);

        uint64 startTime = uint64(block.timestamp);
        a.startTime = startTime;
        a.endTime = startTime + a.duration;
        a.rolloverCount += 1;

        emit AuctionRolledOver(auctionId, a.startTime, a.endTime, a.rolloverCount);
    }

    // --- Views ---------------------------------------------------------------

    function auctionCount() external view returns (uint256) {
        return _auctionIds.length;
    }

    function getAuction(uint256 auctionId) external view returns (Auction memory) {
        if (auctionId >= _auctionIds.length) revert AuctionNotFound(auctionId);
        return _auctions[auctionId];
    }

    /// @notice Whether an auction can still be bid on at `block.timestamp`.
    function isLive(uint256 auctionId) public view returns (bool) {
        if (auctionId >= _auctionIds.length) return false;
        Auction storage a = _auctions[auctionId];
        return !a.finalized && !a.cancelled && block.timestamp < a.endTime;
    }

    /// @notice Whether an auction is created and not yet finalized or cancelled.
    function isActive(uint256 auctionId) public view returns (bool) {
        if (auctionId >= _auctionIds.length) return false;
        Auction storage a = _auctions[auctionId];
        return !a.finalized && !a.cancelled;
    }

    /// @notice Paginated scan of the created order for open or actionable lots.
    /// @dev Filters `isActive` rather than an index that would need rebalancing
    ///      on every finalize. The array is append-only and small in practice.
    function getActiveAuctions(uint256 offset, uint256 limit)
        external
        view
        returns (Auction[] memory items, uint256 nextOffset)
    {
        uint256 total = _auctionIds.length;
        if (offset >= total || limit == 0) {
            return (new Auction[](0), total);
        }
        Auction[] memory buffer = new Auction[](limit);
        uint256 found;
        uint256 cursor = offset;
        while (cursor < total && found < limit) {
            uint256 id = _auctionIds[cursor];
            if (isActive(id)) {
                buffer[found] = _auctions[id];
                found += 1;
            }
            cursor += 1;
        }
        items = new Auction[](found);
        for (uint256 i = 0; i < found; i++) {
            items[i] = buffer[i];
        }
        nextOffset = cursor;
    }

    function auctionsOfSeller(address seller) external view returns (uint256[] memory) {
        return _sellerAuctions[seller];
    }

    function auctionsOfBidder(address bidder) external view returns (uint256[] memory) {
        return _bidderAuctions[bidder];
    }

    /// @notice One bidder's standing in one auction, read from on-chain state.
    /// @dev The coordinator has no vote. A bid exists only once it is funded and
    ///      recorded here, and a win exists only once `finalizeAuction` moves
    ///      both legs.
    function bidStatus(uint256 auctionId, address bidder) external view returns (BidStatus) {
        if (auctionId >= _auctionIds.length) return BidStatus.None;
        Auction storage a = _auctions[auctionId];
        if (a.bestBidder == bidder) {
            if (a.finalized) return BidStatus.Won;
            if (!a.cancelled && block.timestamp < a.endTime) return BidStatus.Funded;
            // The window closed with this bid standing; finalize will pay it.
            return BidStatus.Won;
        }
        if (_hasBid(auctionId, bidder)) return BidStatus.Outbid;
        return BidStatus.None;
    }

    /// @notice The settlement record for a finalized auction, recomputed from
    ///         on-chain config and the winning premium.
    function settlementOf(uint256 auctionId) external view returns (SettlementRecord memory record) {
        if (auctionId >= _auctionIds.length) revert AuctionNotFound(auctionId);
        Auction storage a = _auctions[auctionId];
        if (!a.finalized) revert AuctionStillOpen(auctionId);

        uint256 premium = a.bestPremium;
        bool hasReferral = referralRecipient != address(0) && referralFeeBps > 0;
        uint256 protocolFee = _bpsCeil(premium, protocolFeeBps);
        uint256 referralFee = hasReferral ? _bpsCeil(premium, referralFeeBps) : 0;
        record = SettlementRecord({
            settlementRef: keccak256(abi.encode(block.chainid, address(this), auctionId, a.bestBidder, premium)),
            auctionId: auctionId,
            seller: a.seller,
            winner: a.bestBidder,
            clearingPremium: premium,
            grossPayment: premium,
            sellerProceeds: premium - protocolFee - referralFee,
            protocolFee: protocolFee,
            referralFee: referralFee
        });
    }

    // --- Internals -----------------------------------------------------------

    function _requireOpen(uint256 auctionId) internal view returns (Auction storage a) {
        if (auctionId >= _auctionIds.length) revert AuctionNotFound(auctionId);
        a = _auctions[auctionId];
        if (a.finalized || a.cancelled) revert AuctionClosed(auctionId);
    }

    /// @dev Every rule a bid must satisfy, shared by the allowance and
    ///      authorization paths so the two cannot drift apart.
    function _requireBiddable(Auction storage a, uint256 auctionId, uint256 amount, uint256 premium) internal view {
        if (block.timestamp >= a.endTime) revert AuctionClosed(auctionId);
        if (amount != a.quantity) revert PartialFillNotAllowed(amount, a.quantity);
        if (premium < a.floor) revert BidBelowFloor(premium, a.floor);
        if (premium <= a.bestPremium) revert BidNotBest(premium, a.bestPremium);
    }

    /// @dev Book the bid as the standing best before the premium is pulled.
    function _bookBid(Auction storage a, uint256 auctionId, address bidder, uint256 premium) internal {
        address previousBidder = a.bestBidder;
        uint256 previousPremium = a.bestPremium;

        a.bestBidder = bidder;
        a.bestPremium = premium;
        if (previousBidder != address(0) && previousBidder != bidder) {
            refundableOf[previousBidder] += previousPremium;
            emit RefundAvailable(auctionId, previousBidder, previousPremium);
        }
        if (previousBidder != bidder && !_hasBid(auctionId, bidder)) {
            _bidderAuctions[bidder].push(auctionId);
        }
    }

    /// @dev A fee-on-transfer quote token would leave the house short at
    ///      finalize time, so the deposit must equal the premium exactly.
    function _requireExactDeposit(uint256 before, uint256 premium) internal view {
        uint256 received = quoteToken.balanceOf(address(this)) - before;
        if (received != premium) revert QuoteTransferShort(premium, received);
    }

    function _hasBid(uint256 auctionId, address bidder) internal view returns (bool) {
        uint256[] storage ids = _bidderAuctions[bidder];
        for (uint256 i = 0; i < ids.length; i++) {
            if (ids[i] == auctionId) return true;
        }
        return false;
    }

    /// @dev Ceiling: rounding dust goes to the fee recipient by policy, never
    ///      silently shaved from the seller.
    function _bpsCeil(uint256 amount, uint16 bps) internal pure returns (uint256) {
        if (bps == 0) return 0;
        return (amount * bps + BPS_DENOMINATOR - 1) / BPS_DENOMINATOR;
    }

    function _seriesOf(address claims, uint256 claimId)
        internal
        view
        returns (address collateral, uint256 strike, uint64 maturity)
    {
        uint256 seriesId = claimId & ~uint256(1);
        IErodoroVault.SeriesConfig memory cfg = IVaultSeries(claims).seriesConfig(seriesId);
        if (!cfg.exists) revert SeriesMismatch();
        return (cfg.collateral, cfg.strike, cfg.maturity);
    }
}
