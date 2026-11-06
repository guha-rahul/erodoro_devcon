// SPDX-License-Identifier: Apache-2.0
pragma solidity 0.8.28;

import {ICoinbaseOracleRegistry} from "../../src/oracle/ICoinbaseOracleRegistry.sol";

contract MockCoinbaseOracleRegistry is ICoinbaseOracleRegistry {
    mapping(address token => uint256 multiplier) public multiplierOf;
    mapping(address token => bool paused) public pausedOf;
    bool public shouldRevert;

    function setParams(address token, uint256 multiplier, bool paused) external {
        multiplierOf[token] = multiplier;
        pausedOf[token] = paused;
    }

    function setShouldRevert(bool value) external {
        shouldRevert = value;
    }

    function getOracleParams(address token) external view returns (uint256 multiplier, bool paused) {
        if (shouldRevert) revert("registry unavailable");
        return (multiplierOf[token], pausedOf[token]);
    }
}
