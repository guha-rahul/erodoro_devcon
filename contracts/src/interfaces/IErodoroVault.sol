// SPDX-License-Identifier: Apache-2.0
pragma solidity 0.8.28;

import {SettlementModel} from "../oracle/SettlementModel.sol";

/// @title IErodoroVault
/// @notice Types and events for the singleton vault.
interface IErodoroVault {
    /// @notice Everything fixed at creation. No field is mutable except
    ///         `admin` (renounce-only) and `splitsPaused`.
    struct SeriesConfig {
        address creator;
        address collateral; // B20 Asset acting as collateral
        address oracle; // IOracleAdapter
        address fallbackOracle; // IFallbackSettlementOracle, or zero
        address admin; // pause/unpause/sweep only; renounce-only
        address feeRecipient;
        bytes32 feedId;
        bytes32 fallbackRequestId;
        SettlementModel settlementModel;
        uint256 strike; // per UI unit, in `priceDecimals`
        uint256 multiplierAtCreation; // WAD
        uint256 minSplitAmount; // raw collateral units
        uint64 maturity;
        uint64 settlementDelay;
        uint64 maxPriceLag;
        uint64 fallbackDelay;
        uint32 maxConfBps; // 0 disables the confidence gate
        uint16 feeBps; // 0 in V1
        uint8 collateralDecimals;
        uint8 priceDecimals;
        bool splitsPaused;
        bool exists;
    }

    /// @notice The frozen result of settlement, plus what it observed.
    /// @dev `supplyMismatch` and `shortfallObserved` are recorded rather than
    ///      gated on. See `SECURITY.md` findings #1 and §7.
    struct Settlement {
        uint256 price; // normalised to `priceDecimals`
        uint256 effectiveStrike;
        uint256 multiplierAtSettlement; // WAD
        uint256 collateralAtSettlement;
        uint256 pSupplyAtSettlement;
        uint256 nSupplyAtSettlement;
        uint256 pPool;
        uint256 nPool;
        uint256 pQuoted; // cumulative quoted claim against pPool
        uint256 nQuoted; // cumulative quoted claim against nPool
        uint256 pPaid; // cumulative collateral actually paid
        uint256 nPaid;
        uint64 priceTs;
        uint64 settledTs;
        bool settled;
        bool fallbackUsed;
        bool supplyMismatch;
        bool underCollateralized;
        bool shortfallObserved;
    }

    event SeriesCreated(
        uint256 indexed seriesId,
        address indexed creator,
        address indexed collateral,
        uint256 strike,
        uint64 maturity,
        uint256 multiplierAtCreation,
        SettlementModel settlementModel
    );
    event Split(uint256 indexed seriesId, address indexed who, uint256 amount, uint256 fee);
    event Merge(uint256 indexed seriesId, address indexed who, uint256 amount);
    event Settled(
        uint256 indexed seriesId, uint256 price, uint256 effectiveStrike, uint256 pPool, uint256 nPool, uint64 priceTs
    );
    event FallbackSettled(uint256 indexed seriesId, address indexed fallbackOracle, bytes32 indexed requestId);
    event Redeemed(
        uint256 indexed seriesId, address indexed who, bool isP, uint256 amount, uint256 quoted, uint256 paid
    );
    /// @notice The vault held less than it owed at the moment of a redemption.
    event ShortfallObserved(uint256 indexed seriesId, uint256 available, uint256 outstanding);
    /// @notice Settlement saw supplies disagree or collateral below the senior claim.
    event SettlementHealth(uint256 indexed seriesId, bool supplyMismatch, bool underCollateralized);
    event SplitsPaused(uint256 indexed seriesId);
    event SplitsUnpaused(uint256 indexed seriesId);
    event AdminRenounced(uint256 indexed seriesId);
    event DustSwept(uint256 indexed seriesId, address indexed to, uint256 amount);
}
