// SPDX-License-Identifier: Apache-2.0
pragma solidity 0.8.28;

import {SettlementModel} from "./SettlementModel.sol";

/// @notice A finalized price from a delayed proposal and dispute process.
interface IFallbackSettlementOracle {
    function settlementModel() external view returns (SettlementModel);

    /// @notice The one feed (one stock) this fallback answers for. A fallback
    ///         never serves two stocks: its requests are keyed by time only.
    function configuredFeedId() external view returns (bytes32);

    /// @notice Bind one maturity and recovery-open time to one request id.
    function requestIdFor(uint64 maturity, uint64 notBefore) external view returns (bytes32);

    function finalizedPrice(bytes32 requestId, bytes calldata resolutionData)
        external
        view
        returns (uint256 price, uint8 priceDecimals, uint64 priceTime, bool finalized);
}
