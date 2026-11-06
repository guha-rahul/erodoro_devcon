// SPDX-License-Identifier: Apache-2.0
pragma solidity 0.8.28;

import {IOracleAdapter} from "./IOracleAdapter.sol";
import {IAggregatorV3} from "./IAggregatorV3.sol";
import {IFeedStatus} from "./IFeedStatus.sol";
import {SettlementModel} from "./SettlementModel.sol";
import {PayoutMath} from "../libraries/PayoutMath.sol";
import {Errors} from "../libraries/Errors.sol";

/// @notice Reads Coinbase's Chainlink total-return stock value.
/// @dev `updateData` must contain one ABI-encoded round id. The adapter accepts
///      only the first round after `minPublishTime`. A first round in a new
///      Chainlink phase is rejected because `roundId - 1` cannot prove the last
///      round of the prior phase. The delayed fallback handles that rare case.
contract ChainlinkTotalReturnAdapter is IOracleAdapter {
    IAggregatorV3 public immutable feed;
    IFeedStatus public immutable status;
    bytes32 public immutable configuredFeedId;

    constructor(IAggregatorV3 feed_, IFeedStatus status_, bytes32 feedId_) {
        if (address(feed_) == address(0) || address(status_) == address(0) || feedId_ == bytes32(0)) {
            revert Errors.InvalidOracle();
        }
        feed = feed_;
        status = status_;
        configuredFeedId = feedId_;
    }

    function settlementModel() external pure returns (SettlementModel) {
        return SettlementModel.TOTAL_RETURN;
    }

    /// @notice The issuer registry's view of this token, when the configured
    ///         status exposes it. `paused` is what distinguishes a corporate-
    ///         action freeze from a genuinely missing feed, so a UI can explain
    ///         the wait. Returns `(0, false)` for a plain status.
    function oracleParams() external view returns (uint256 multiplier, bool paused) {
        (bool ok, bytes memory data) = address(status).staticcall(abi.encodeWithSignature("oracleParams()"));
        if (!ok || data.length < 64) return (0, false);
        return abi.decode(data, (uint256, bool));
    }

    function updateFee(bytes[] calldata) external pure returns (uint256) {
        return 0;
    }

    function settlementPrice(
        bytes32 feedId,
        uint64 minPublishTime,
        uint64 maxPublishTime,
        uint256 maxConfBps,
        bytes[] calldata updateData
    ) external payable returns (uint256 price, uint8 priceDecimals, uint64 publishTime) {
        if (feedId != configuredFeedId) revert Errors.FeedMismatch();
        if (minPublishTime > maxPublishTime || maxConfBps != 0 || updateData.length != 1) {
            revert Errors.InvalidParams();
        }
        if (!status.isOperational(feedId)) _revertNotOperational();

        uint80 roundId = abi.decode(updateData[0], (uint80));
        if (uint64(roundId) <= 1) revert Errors.OraclePriceInvalid();
        (price, publishTime) = _readCandidate(roundId, minPublishTime, maxPublishTime);
        _requirePreviousBefore(roundId - 1, minPublishTime);

        priceDecimals = feed.decimals();
        if (priceDecimals > PayoutMath.MAX_DECIMALS) revert Errors.OracleDecimalsInvalid();
    }

    function _readCandidate(uint80 roundId, uint64 minPublishTime, uint64 maxPublishTime)
        internal
        view
        returns (uint256 price, uint64 publishTime)
    {
        (uint80 returnedId, int256 answer,, uint256 updatedAt, uint80 answeredInRound) = feed.getRoundData(roundId);
        if (returnedId != roundId || answer <= 0 || updatedAt == 0 || answeredInRound < roundId) {
            revert Errors.OraclePriceInvalid();
        }
        if (updatedAt < minPublishTime || updatedAt > maxPublishTime || updatedAt > type(uint64).max) {
            revert Errors.OraclePriceStale();
        }
        return (uint256(answer), uint64(updatedAt));
    }

    function _requirePreviousBefore(uint80 previousRoundId, uint64 minPublishTime) internal view {
        (uint80 returnedId,,, uint256 updatedAt, uint80 answeredInRound) = feed.getRoundData(previousRoundId);
        if (
            returnedId != previousRoundId || updatedAt == 0 || answeredInRound < previousRoundId
                || updatedAt >= minPublishTime
        ) revert Errors.OraclePriceInvalid();
    }

    /// @dev Distinguish a corporate-action pause from a genuinely closed market.
    ///      A registry-backed status exposes `oracleParams()`; a plain status
    ///      does not, so the probe failing falls back to `MarketClosed`.
    function _revertNotOperational() internal view {
        (bool ok, bytes memory data) = address(status).staticcall(abi.encodeWithSignature("oracleParams()"));
        if (ok && data.length >= 64) {
            (uint256 multiplier, bool paused) = abi.decode(data, (uint256, bool));
            if (paused && multiplier != 0) revert Errors.OraclePausedForCorporateAction();
        }
        revert Errors.MarketClosed();
    }
}
