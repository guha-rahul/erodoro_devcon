// SPDX-License-Identifier: Apache-2.0
pragma solidity 0.8.28;

import {IPyth} from "@pythnetwork/pyth-sdk-solidity/IPyth.sol";
import {PythStructs} from "@pythnetwork/pyth-sdk-solidity/PythStructs.sol";

/// @notice Pyth receiver surface that proves the first update in a time range.
/// @dev This function is part of the current receiver API but is not present in
///      the older Solidity SDK version vendored by this repository.
interface IPythUnique is IPyth {
    function parsePriceFeedUpdatesUnique(
        bytes[] calldata updateData,
        bytes32[] calldata priceIds,
        uint64 minPublishTime,
        uint64 maxPublishTime
    ) external payable returns (PythStructs.PriceFeed[] memory priceFeeds);
}
