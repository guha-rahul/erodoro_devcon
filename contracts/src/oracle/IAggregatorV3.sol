// SPDX-License-Identifier: Apache-2.0
pragma solidity 0.8.28;

interface IAggregatorV3 {
    function decimals() external view returns (uint8);

    function getRoundData(uint80 roundId)
        external
        view
        returns (uint80 answeredRoundId, int256 answer, uint256 startedAt, uint256 updatedAt, uint80 answeredInRound);
}
