// SPDX-License-Identifier: Apache-2.0
pragma solidity 0.8.28;

/// @notice The UMA Optimistic Oracle V2 calls used by Erodoro.
interface IOptimisticOracleV2 {
    function requestPrice(
        bytes32 identifier,
        uint256 timestamp,
        bytes memory ancillaryData,
        address currency,
        uint256 reward
    ) external returns (uint256 totalBond);

    function setBond(bytes32 identifier, uint256 timestamp, bytes memory ancillaryData, uint256 bond)
        external
        returns (uint256 totalBond);

    function setCustomLiveness(
        bytes32 identifier,
        uint256 timestamp,
        bytes memory ancillaryData,
        uint256 customLiveness
    ) external;

    function proposePriceFor(
        address proposer,
        address requester,
        bytes32 identifier,
        uint256 timestamp,
        bytes memory ancillaryData,
        int256 proposedPrice
    ) external returns (uint256 totalBond);

    function disputePriceFor(
        address disputer,
        address requester,
        bytes32 identifier,
        uint256 timestamp,
        bytes memory ancillaryData
    ) external returns (uint256 totalBond);

    function hasPrice(address requester, bytes32 identifier, uint256 timestamp, bytes memory ancillaryData)
        external
        view
        returns (bool);

    function settleAndGetPrice(bytes32 identifier, uint256 timestamp, bytes memory ancillaryData)
        external
        returns (int256 resolvedPrice);
}
