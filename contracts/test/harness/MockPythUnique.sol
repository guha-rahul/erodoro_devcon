// SPDX-License-Identifier: Apache-2.0
pragma solidity 0.8.28;

import {MockPyth} from "@pythnetwork/pyth-sdk-solidity/MockPyth.sol";
import {PythStructs} from "@pythnetwork/pyth-sdk-solidity/PythStructs.sol";
import {PythErrors} from "@pythnetwork/pyth-sdk-solidity/PythErrors.sol";

/// @notice Local test double for Pyth's unique historical-price selector.
/// @dev The production receiver proves that no earlier update was omitted. This
///      mock can only choose the earliest update supplied by the test.
contract MockPythUnique is MockPyth {
    constructor(uint256 validTimePeriod, uint256 singleUpdateFeeInWei)
        MockPyth(validTimePeriod, singleUpdateFeeInWei)
    {}

    function parsePriceFeedUpdatesUnique(
        bytes[] calldata updateData,
        bytes32[] calldata priceIds,
        uint64 minPublishTime,
        uint64 maxPublishTime
    ) external payable returns (PythStructs.PriceFeed[] memory feeds) {
        uint256 requiredFee = getUpdateFee(updateData);
        if (msg.value < requiredFee) revert PythErrors.InsufficientFee();

        feeds = new PythStructs.PriceFeed[](priceIds.length);
        for (uint256 i = 0; i < priceIds.length; i++) {
            uint64 earliest = type(uint64).max;
            bool found;

            for (uint256 j = 0; j < updateData.length; j++) {
                PythStructs.PriceFeed memory candidate = abi.decode(updateData[j], (PythStructs.PriceFeed));
                uint64 publishTime = uint64(candidate.price.publishTime);

                if (
                    candidate.id == priceIds[i] && minPublishTime <= publishTime && publishTime <= maxPublishTime
                        && publishTime < earliest
                ) {
                    feeds[i] = candidate;
                    earliest = publishTime;
                    found = true;
                }
            }

            if (!found) revert PythErrors.PriceFeedNotFoundWithinRange();
        }
    }
}
