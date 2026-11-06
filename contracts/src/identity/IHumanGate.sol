// SPDX-License-Identifier: Apache-2.0
pragma solidity 0.8.28;

/// @notice What a Rips pool asks before each sale when World ID gating is on.
interface IHumanGate {
    /// @notice Reverts unless `buyer` is a verified human with room under their cap for `usdcAmount` in
    ///         `batchId` of the calling pool; otherwise records the spend.
    function recordPurchase(address buyer, uint256 batchId, uint256 usdcAmount) external;

    function isVerified(address wallet) external view returns (bool);
}
