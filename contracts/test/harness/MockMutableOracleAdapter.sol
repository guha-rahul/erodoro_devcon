// SPDX-License-Identifier: Apache-2.0
pragma solidity 0.8.28;

import {IOracleAdapter} from "../../src/oracle/IOracleAdapter.sol";
import {SettlementModel} from "../../src/oracle/SettlementModel.sol";
import {Errors} from "../../src/libraries/Errors.sol";

/// @notice A price adapter whose declared settlement model can change.
/// @dev The real adapters declare an immutable model, and a series pins the
///      oracle address at creation, so a mismatch is not reachable through
///      normal use. This exists only to prove the settlement-time re-check
///      fails closed if one ever is.
contract MockMutableOracleAdapter is IOracleAdapter {
    SettlementModel public override settlementModel;

    uint256 public price;
    uint8 public decimals;
    uint64 public publishTime;

    constructor(SettlementModel model) {
        settlementModel = model;
    }

    function setSettlementModel(SettlementModel model) external {
        settlementModel = model;
    }

    function setPrice(uint256 price_, uint8 decimals_, uint64 publishTime_) external {
        price = price_;
        decimals = decimals_;
        publishTime = publishTime_;
    }

    function updateFee(bytes[] calldata) external pure returns (uint256) {
        return 0;
    }

    function settlementPrice(bytes32, uint64 minPublishTime, uint64 maxPublishTime, uint256, bytes[] calldata)
        external
        payable
        returns (uint256, uint8, uint64)
    {
        if (publishTime < minPublishTime || publishTime > maxPublishTime) revert Errors.OraclePriceStale();
        return (price, decimals, publishTime);
    }
}
