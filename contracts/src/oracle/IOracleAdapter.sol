// SPDX-License-Identifier: Apache-2.0
pragma solidity 0.8.28;

import {SettlementModel} from "./SettlementModel.sol";

/// @title IOracleAdapter
/// @notice The single thing settlement is allowed to learn from the outside
///         world: one price, its decimals, and when it was printed.
///
/// @dev The Solana original split this across a feed-config account and a
///      posted price-update account, because a Pyth update on Solana must be
///      written to an account before it can be read. On EVM the verification and
///      the window check happen inside one call, so the adapter is a thin,
///      stateless translator rather than a program with its own lifecycle.
interface IOracleAdapter {
    /// @notice The immutable meaning of every price returned by this adapter.
    function settlementModel() external view returns (SettlementModel);

    /// @notice Verify `updateData` and return the price for `feedId`, requiring
    ///         the print to fall inside `[minPublishTime, maxPublishTime]`.
    ///
    /// @dev Reverts if no update for `feedId` falls inside the window. The
    ///      window is therefore an argument rather than an invariant the caller
    ///      has to keep coherent with a separate staleness bound — which is what
    ///      made finding #4 possible on Solana.
    ///
    ///      Payable: verification costs a fee. Any excess is refunded to
    ///      `msg.sender`, so a caller that overpays is not penalised.
    function settlementPrice(
        bytes32 feedId,
        uint64 minPublishTime,
        uint64 maxPublishTime,
        uint256 maxConfBps,
        bytes[] calldata updateData
    ) external payable returns (uint256 price, uint8 priceDecimals, uint64 publishTime);

    /// @notice Fee required to verify `updateData`.
    function updateFee(bytes[] calldata updateData) external view returns (uint256);
}
