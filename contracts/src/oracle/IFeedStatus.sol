// SPDX-License-Identifier: Apache-2.0
pragma solidity 0.8.28;

/// @notice Authenticated operational status for one configured stock feed.
/// @dev A production implementation must read the issuer's documented status
///      registry. A timestamp check alone cannot detect a new feed freeze.
interface IFeedStatus {
    function isOperational(bytes32 feedId) external view returns (bool);
}
