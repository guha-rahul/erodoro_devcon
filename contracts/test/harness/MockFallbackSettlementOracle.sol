// SPDX-License-Identifier: Apache-2.0
pragma solidity 0.8.28;

import {IFallbackSettlementOracle} from "../../src/oracle/IFallbackSettlementOracle.sol";
import {SettlementModel} from "../../src/oracle/SettlementModel.sol";

contract MockFallbackSettlementOracle is IFallbackSettlementOracle {
    SettlementModel public immutable override settlementModel;
    bytes32 public immutable override configuredFeedId;

    uint256 public price;
    uint8 public decimals;
    uint64 public priceTime;
    bool public finalized;

    constructor(SettlementModel model, bytes32 feedId) {
        settlementModel = model;
        configuredFeedId = feedId;
    }

    function setResult(uint256 price_, uint8 decimals_, uint64 priceTime_, bool finalized_) external {
        price = price_;
        decimals = decimals_;
        priceTime = priceTime_;
        finalized = finalized_;
    }

    function requestIdFor(uint64 maturity, uint64 notBefore) external view returns (bytes32) {
        return keccak256(abi.encode(address(this), maturity, notBefore));
    }

    function finalizedPrice(bytes32, bytes calldata) external view returns (uint256, uint8, uint64, bool) {
        return (price, decimals, priceTime, finalized);
    }
}
