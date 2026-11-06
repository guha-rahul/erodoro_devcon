// SPDX-License-Identifier: Apache-2.0
pragma solidity 0.8.28;

import {IFeedStatus} from "../../src/oracle/IFeedStatus.sol";

contract MockFeedStatus is IFeedStatus {
    mapping(bytes32 => bool) public operational;

    function setOperational(bytes32 feedId, bool value) external {
        operational[feedId] = value;
    }

    function isOperational(bytes32 feedId) external view returns (bool) {
        return operational[feedId];
    }
}
