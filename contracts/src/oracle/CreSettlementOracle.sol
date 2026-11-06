// SPDX-License-Identifier: Apache-2.0
pragma solidity 0.8.28;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {Address} from "@openzeppelin/contracts/utils/Address.sol";
import {CreReceiver} from "../cre/CreReceiver.sol";
import {Errors} from "../libraries/Errors.sol";
import {IOracleAdapter} from "./IOracleAdapter.sol";
import {SettlementModel} from "./SettlementModel.sol";

/// @title CreSettlementOracle
/// @notice Chainlink stock prices delivered by a Chainlink CRE workflow, for settling Rips on chains where the
///         feeds don't exist (Base Sepolia). The workflow reads Coinbase's Chainlink stock feeds on Base
///         mainnet and reports each feed's latest answer here. Every report is kept, so settlement can find
///         the price in effect at maturity.
/// @dev An observation's time is when its report landed; `feedUpdatedAt` is when Chainlink last moved the
///      price. Stock feeds only update on a deviation or heartbeat and pause outside market hours, so the
///      first observation at or after maturity carries the price in effect at maturity. `maxFeedAge`
///      rejects observations of a feed that had stopped updating.
contract CreSettlementOracle is IOracleAdapter, CreReceiver {
    struct Observation {
        uint128 price;
        uint64 observedAt;
        uint64 feedUpdatedAt;
    }

    uint8 public constant PRICE_DECIMALS = 8;

    /// @notice Oldest feed print an observation may carry. Covers a weekend plus a market holiday.
    uint64 public maxFeedAge = 4 days;

    mapping(bytes32 feedId => Observation[]) private _observations;

    event PriceObserved(bytes32 indexed feedId, uint256 price, uint64 feedUpdatedAt);
    event MaxFeedAgeSet(uint64 maxFeedAge);

    constructor(address owner_, address forwarder_, address simulationSender_)
        Ownable(owner_)
        CreReceiver(forwarder_, simulationSender_)
    {}

    function settlementModel() external pure returns (SettlementModel) {
        return SettlementModel.TOTAL_RETURN;
    }

    function updateFee(bytes[] calldata) external pure returns (uint256) {
        return 0;
    }

    /// @notice The first observation of `feedId` inside `[minPublishTime, maxPublishTime]`.
    function settlementPrice(bytes32 feedId, uint64 minPublishTime, uint64 maxPublishTime, uint256, bytes[] calldata)
        external
        payable
        returns (uint256 price, uint8 priceDecimals, uint64 publishTime)
    {
        Observation[] storage observations = _observations[feedId];
        uint256 i = _firstAtOrAfter(observations, minPublishTime);
        if (i == observations.length) revert Errors.OraclePriceStale();
        Observation memory o = observations[i];
        if (o.observedAt > maxPublishTime || o.observedAt - o.feedUpdatedAt > maxFeedAge) {
            revert Errors.OraclePriceStale();
        }
        if (msg.value != 0) Address.sendValue(payable(msg.sender), msg.value);
        return (o.price, PRICE_DECIMALS, o.observedAt);
    }

    function latest(bytes32 feedId) external view returns (Observation memory) {
        Observation[] storage observations = _observations[feedId];
        if (observations.length == 0) revert Errors.OraclePriceInvalid();
        return observations[observations.length - 1];
    }

    function observationCount(bytes32 feedId) external view returns (uint256) {
        return _observations[feedId].length;
    }

    function observation(bytes32 feedId, uint256 index) external view returns (Observation memory) {
        return _observations[feedId][index];
    }

    function setMaxFeedAge(uint64 maxFeedAge_) external onlyOwner {
        maxFeedAge = maxFeedAge_;
        emit MaxFeedAgeSet(maxFeedAge_);
    }

    /// @dev Report: abi.encode(bytes32[] feedIds, uint256[] prices, uint64[] feedUpdatedAts), prices with
    ///      8 decimals. Zero prices, future prints and prints older than the feed's last one are skipped.
    function _processReport(bytes calldata report) internal override {
        (bytes32[] memory feedIds, uint256[] memory prices, uint64[] memory updatedAts) =
            abi.decode(report, (bytes32[], uint256[], uint64[]));
        if (feedIds.length != prices.length || feedIds.length != updatedAts.length) revert Errors.InvalidParams();
        for (uint256 i; i < feedIds.length; ++i) {
            Observation[] storage observations = _observations[feedIds[i]];
            uint256 n = observations.length;
            if (prices[i] == 0 || prices[i] > type(uint128).max || updatedAts[i] > block.timestamp) continue;
            if (n != 0 && updatedAts[i] < observations[n - 1].feedUpdatedAt) continue;
            observations.push(
                Observation({price: uint128(prices[i]), observedAt: uint64(block.timestamp), feedUpdatedAt: updatedAts[i]})
            );
            emit PriceObserved(feedIds[i], prices[i], updatedAts[i]);
        }
    }

    /// @dev Observation times never decrease, so binary search for the first one at or after `t`.
    function _firstAtOrAfter(Observation[] storage observations, uint64 t) private view returns (uint256 lo) {
        uint256 hi = observations.length;
        while (lo < hi) {
            uint256 mid = (lo + hi) / 2;
            if (observations[mid].observedAt < t) lo = mid + 1;
            else hi = mid;
        }
    }
}
