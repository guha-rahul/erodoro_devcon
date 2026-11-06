// SPDX-License-Identifier: Apache-2.0
pragma solidity 0.8.28;

/// @notice The stock-oracle status surface published by Coinbase on Base.
interface ICoinbaseOracleRegistry {
    function getOracleParams(address token) external view returns (uint256 multiplier, bool paused);
}
