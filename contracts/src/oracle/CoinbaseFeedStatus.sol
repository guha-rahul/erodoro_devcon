// SPDX-License-Identifier: Apache-2.0
pragma solidity 0.8.28;

import {IFeedStatus} from "./IFeedStatus.sol";
import {ICoinbaseOracleRegistry} from "./ICoinbaseOracleRegistry.sol";
import {Errors} from "../libraries/Errors.sol";

/// @notice Fails closed when Coinbase has paused a configured stock oracle.
/// @dev One instance binds one B20 token to one Erodoro feed identifier.
contract CoinbaseFeedStatus is IFeedStatus {
    ICoinbaseOracleRegistry public immutable registry;
    address public immutable token;
    bytes32 public immutable configuredFeedId;

    constructor(ICoinbaseOracleRegistry registry_, address token_, bytes32 feedId_) {
        if (address(registry_) == address(0) || token_ == address(0) || feedId_ == bytes32(0)) {
            revert Errors.InvalidOracle();
        }
        registry = registry_;
        token = token_;
        configuredFeedId = feedId_;
    }

    function isOperational(bytes32 feedId) external view returns (bool) {
        if (feedId != configuredFeedId) return false;

        try registry.getOracleParams(token) returns (uint256 multiplier, bool paused) {
            return multiplier != 0 && !paused;
        } catch {
            return false;
        }
    }

    function oracleParams() external view returns (uint256 multiplier, bool paused) {
        return registry.getOracleParams(token);
    }
}
