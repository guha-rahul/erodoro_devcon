// SPDX-License-Identifier: Apache-2.0
pragma solidity 0.8.28;

import {IAggregatorV3} from "../../src/oracle/IAggregatorV3.sol";

contract MockAggregatorV3 is IAggregatorV3 {
    struct Round {
        int256 answer;
        uint256 updatedAt;
        uint80 answeredInRound;
    }

    uint8 public immutable override decimals;
    mapping(uint80 => Round) public rounds;

    constructor(uint8 decimals_) {
        decimals = decimals_;
    }

    function setRound(uint80 roundId, int256 answer, uint256 updatedAt, uint80 answeredInRound) external {
        rounds[roundId] = Round(answer, updatedAt, answeredInRound);
    }

    function getRoundData(uint80 roundId) external view returns (uint80, int256, uint256, uint256, uint80) {
        Round memory round = rounds[roundId];
        return (roundId, round.answer, round.updatedAt, round.updatedAt, round.answeredInRound);
    }
}
