// SPDX-License-Identifier: Apache-2.0
pragma solidity 0.8.28;

import {PythStructs} from "@pythnetwork/pyth-sdk-solidity/PythStructs.sol";
import {IOracleAdapter} from "./IOracleAdapter.sol";
import {IPythUnique} from "./IPythUnique.sol";
import {SettlementModel} from "./SettlementModel.sol";
import {Errors} from "../libraries/Errors.sol";
import {PayoutMath} from "../libraries/PayoutMath.sol";

/// @title PythAdapter
/// @notice Reads a settlement price from Pyth, ported from
///         `programs/oracle-adapter/`.
///
/// @dev Three of the original's gates are structural here rather than
///      configured, and the difference is worth stating precisely:
///
///      - **Finding #3** (an admin swapping a Pyth feed for a mock) is closed by
///        construction: this adapter has no backend selector and no admin. The
///        `IPyth` address is immutable, and the only way to point a series at a
///        different price is to deploy a different adapter, which the factory
///        must then approve.
///
///      - **Finding #6** (a zero signature-verification floor being valid
///        on-chain) does not have a configurable analogue. Pyth's EVM contract
///        verifies Wormhole guardian signatures inside `parsePriceFeedUpdates`
///        and there is no threshold for a consumer to set — correctly or
///        incorrectly. What replaces the check is confirming that `pyth` is the
///        canonical deployment, which is a deploy-time assertion, not a runtime
///        one. `script/Preflight.s.sol` carries it.
///
///      - **Finding #4** (a series that can never be settled) loses its
///        arithmetic. The publish window is passed directly to Pyth instead of
///        being reconstructed from a delay and two independent staleness
///        bounds, so there is no inequality between three parameters left to
///        hold.
///
///      What is *not* inherited from the chain: the confidence policy. The
///      Solana preflight explicitly declined to choose one. It is a series
///      parameter here and enforced on every read, because a wide confidence
///      band is exactly what a thin book at 3am looks like.
contract PythAdapter is IOracleAdapter {
    /// @notice The canonical Pyth receiver for this chain. Immutable by design.
    IPythUnique public immutable pyth;

    /// @notice Widest confidence band expressible, in basis points of price.
    uint256 internal constant BPS = 10_000;
    uint64 public constant MAX_UNIQUE_WINDOW = 60;

    constructor(IPythUnique pyth_) {
        if (address(pyth_) == address(0)) revert Errors.InvalidOracle();
        pyth = pyth_;
    }

    /// @inheritdoc IOracleAdapter
    function settlementModel() external pure returns (SettlementModel) {
        return SettlementModel.RAW_SHARE;
    }

    /// @inheritdoc IOracleAdapter
    function updateFee(bytes[] calldata updateData) external view returns (uint256) {
        return pyth.getUpdateFee(updateData);
    }

    /// @inheritdoc IOracleAdapter
    function settlementPrice(
        bytes32 feedId,
        uint64 minPublishTime,
        uint64 maxPublishTime,
        uint256 maxConfBps,
        bytes[] calldata updateData
    ) external payable returns (uint256 price, uint8 priceDecimals, uint64 publishTime) {
        if (minPublishTime > maxPublishTime) {
            revert Errors.InvalidParams();
        }

        uint256 fee = pyth.getUpdateFee(updateData);
        if (msg.value < fee) revert Errors.InsufficientBalance();

        PythStructs.Price memory p = _verify(feedId, minPublishTime, maxPublishTime, fee, updateData);

        if (p.price <= 0) revert Errors.OraclePriceInvalid();
        // A positive exponent would mean a price coarser than one unit, which no
        // equity feed uses and the decimal normalisation cannot express.
        if (p.expo > 0 || p.expo < -int32(int256(PayoutMath.MAX_DECIMALS))) {
            revert Errors.OracleDecimalsInvalid();
        }

        price = uint256(uint64(p.price));
        priceDecimals = uint8(uint32(-p.expo));
        publishTime = uint64(p.publishTime);

        // Confidence policy. Pyth widens `conf` when publishers disagree, which
        // is what a closed market or a thin book looks like from on-chain. A
        // series that settles through a wide band is settling against noise.
        if (maxConfBps != 0 && uint256(p.conf) * BPS > price * maxConfBps) {
            revert Errors.MarketClosed();
        }

        _refund(msg.value - fee);
    }

    /// @dev Verification is split out so the caller's stack stays shallow.
    ///      Reverts if no update for `feedId` was published inside the window.
    function _verify(
        bytes32 feedId,
        uint64 minPublishTime,
        uint64 maxPublishTime,
        uint256 fee,
        bytes[] calldata updateData
    ) internal returns (PythStructs.Price memory) {
        bytes32[] memory ids = new bytes32[](1);
        ids[0] = feedId;

        PythStructs.PriceFeed[] memory feeds =
            pyth.parsePriceFeedUpdatesUnique{value: fee}(updateData, ids, minPublishTime, maxPublishTime);

        // Pyth returns feeds in the order requested, but the identity is what
        // the series is actually bound to, so check it rather than trust order.
        if (feeds[0].id != feedId) revert Errors.FeedMismatch();
        return feeds[0].price;
    }

    /// @dev Refund any overpayment rather than keeping it.
    function _refund(uint256 excess) internal {
        if (excess == 0) return;
        (bool ok,) = msg.sender.call{value: excess}("");
        if (!ok) revert Errors.InvalidParams();
    }
}
