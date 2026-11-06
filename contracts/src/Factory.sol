// SPDX-License-Identifier: Apache-2.0
pragma solidity 0.8.28;

import {ErodoroVault} from "./ErodoroVault.sol";
import {SafeCast} from "@openzeppelin/contracts/utils/math/SafeCast.sol";
import {Errors} from "./libraries/Errors.sol";
import {IOracleAdapter} from "./oracle/IOracleAdapter.sol";
import {IFallbackSettlementOracle} from "./oracle/IFallbackSettlementOracle.sol";
import {SettlementModel} from "./oracle/SettlementModel.sol";

/// @title Factory
/// @notice Decides what is *canonical*. Ported from `programs/factory/`.
///
/// @dev Creation on the vault is permissionless and stays that way. This
///      contract does not gate it — it maintains complete settlement
///      configurations and parameter bounds that a series must satisfy to be
///      listed, and the registry a front end should read.
///
///      **The factory has no power over a series it creates — not even to pause
///      one.** It never takes the admin role: the caller designates an admin, or
///      passes `address(0)` to open the series with the admin surface dead from
///      birth. What the factory controls is which parameters, oracles, feeds and
///      collateral may become canonical, and nothing else.
///
///      Because `seriesIdFor` puts the creator in the preimage, every series
///      created here lives in the factory's own id space. Nobody else can
///      occupy an address the factory would have used, which is finding #2's
///      fix carried across intact.
///
///      Approvals are deliberately not independent. An approved AAPL adapter
///      and an approved NVDA feed must not be recombined into a canonical
///      market. One configuration id binds collateral, primary oracle, fallback
///      oracle, feed, settlement model, fallback delay, and price decimals.
contract Factory {
    using SafeCast for uint256;

    /// @notice Parameter bounds a canonical series must satisfy.
    struct Bounds {
        uint64 minHorizon; // maturity at least this far out
        uint64 maxHorizon; // and no further
        uint64 minSettlementDelay;
        uint64 maxSettlementDelay;
        uint64 minPriceLag;
        uint64 maxPriceLag;
        uint32 maxConfBps; // ceiling; a series may be stricter, never laxer
        uint16 maxFeeBps;
        uint8 priceDecimals; // exact
    }

    struct SeriesRecord {
        uint256 seriesId;
        bytes32 settlementConfigurationId;
        address collateral;
        address oracle;
        bytes32 feedId;
        SettlementModel settlementModel;
        uint256 strike;
        uint64 maturity;
        uint64 index;
        uint8 priceDecimals;
        bool canonical;
    }

    struct SettlementConfigurationParams {
        address collateral;
        address oracle;
        address fallbackOracle;
        bytes32 feedId;
        SettlementModel settlementModel;
        uint64 fallbackDelay;
        uint8 priceDecimals;
    }

    struct SettlementConfiguration {
        address collateral;
        address oracle;
        address fallbackOracle;
        bytes32 feedId;
        SettlementModel settlementModel;
        uint64 fallbackDelay;
        uint8 priceDecimals;
        bool enabled;
    }

    ErodoroVault public immutable vault;

    address public admin;
    bool public creationPaused;
    uint64 public seriesCount;
    Bounds public bounds;

    mapping(bytes32 configurationId => SettlementConfiguration) public configurationOf;
    mapping(address collateral => bytes32 configurationId) public activeConfigurationId;
    mapping(uint256 seriesId => SeriesRecord) public recordOf;

    uint256[] private _canonical;

    event AdminChanged(address indexed from, address indexed to);
    event CreationPaused();
    event CreationUnpaused();
    event BoundsChanged();
    event SettlementConfigurationSet(
        bytes32 indexed configurationId,
        address indexed collateral,
        address indexed oracle,
        address fallbackOracle,
        bytes32 feedId,
        SettlementModel settlementModel,
        uint64 fallbackDelay,
        uint8 priceDecimals
    );
    event SettlementConfigurationEnabled(bytes32 indexed configurationId, bool enabled);
    event ActiveConfigurationSet(address indexed collateral, bytes32 indexed configurationId);
    event CanonicalSeriesCreated(uint256 indexed seriesId, uint64 index, address indexed creator);

    modifier onlyAdmin() {
        if (msg.sender != admin) revert Errors.Unauthorized();
        _;
    }

    constructor(ErodoroVault vault_, address admin_, Bounds memory bounds_) {
        if (address(vault_) == address(0) || admin_ == address(0)) revert Errors.InvalidParams();
        vault = vault_;
        admin = admin_;
        _setBounds(bounds_);
    }

    // --- Admin ---------------------------------------------------------------

    function setAdmin(address newAdmin) external onlyAdmin {
        if (newAdmin == address(0)) revert Errors.InvalidParams();
        emit AdminChanged(admin, newAdmin);
        admin = newAdmin;
    }

    function pauseCreation() external onlyAdmin {
        creationPaused = true;
        emit CreationPaused();
    }

    function unpauseCreation() external onlyAdmin {
        creationPaused = false;
        emit CreationUnpaused();
    }

    function setBounds(Bounds calldata b) external onlyAdmin {
        _setBounds(b);
    }

    /// @notice Add and activate one complete settlement configuration.
    /// @dev Re-adding the same immutable tuple re-enables it. Changing any
    ///      field creates a different configuration id.
    function setSettlementConfiguration(SettlementConfigurationParams calldata c)
        external
        onlyAdmin
        returns (bytes32 configurationId)
    {
        _validateConfiguration(c);
        configurationId = configurationIdFor(c);
        configurationOf[configurationId] = SettlementConfiguration({
            collateral: c.collateral,
            oracle: c.oracle,
            fallbackOracle: c.fallbackOracle,
            feedId: c.feedId,
            settlementModel: c.settlementModel,
            fallbackDelay: c.fallbackDelay,
            priceDecimals: c.priceDecimals,
            enabled: true
        });
        activeConfigurationId[c.collateral] = configurationId;

        emit SettlementConfigurationSet(
            configurationId,
            c.collateral,
            c.oracle,
            c.fallbackOracle,
            c.feedId,
            c.settlementModel,
            c.fallbackDelay,
            c.priceDecimals
        );
        emit SettlementConfigurationEnabled(configurationId, true);
        emit ActiveConfigurationSet(c.collateral, configurationId);
    }

    /// @notice Disable a configuration, or re-enable it as the collateral's active one.
    function setConfigurationEnabled(bytes32 configurationId, bool enabled) external onlyAdmin {
        SettlementConfiguration storage c = configurationOf[configurationId];
        if (c.collateral == address(0)) revert Errors.InvalidSettlementConfiguration();
        c.enabled = enabled;
        if (enabled) {
            activeConfigurationId[c.collateral] = configurationId;
            emit ActiveConfigurationSet(c.collateral, configurationId);
        }
        emit SettlementConfigurationEnabled(configurationId, enabled);
    }

    // --- Listing -------------------------------------------------------------

    /// @notice Create a series against the vault and record it as canonical.
    /// @param seriesAdmin Who may pause splits and sweep dust. `address(0)`
    ///        opens the series with no admin at all.
    function createSeries(ErodoroVault.CreateSeriesParams calldata p, address seriesAdmin)
        external
        returns (uint256 seriesId)
    {
        if (creationPaused) revert Errors.CreationPaused();
        bytes32 configurationId = _requireWithinBounds(p);

        ErodoroVault.CreateSeriesParams memory q = p;
        q.admin = seriesAdmin;
        seriesId = vault.createSeries(q);

        uint64 index = seriesCount++;
        recordOf[seriesId] = SeriesRecord({
            seriesId: seriesId,
            settlementConfigurationId: configurationId,
            collateral: p.collateral,
            oracle: p.oracle,
            feedId: p.feedId,
            settlementModel: p.settlementModel,
            strike: p.strike,
            maturity: p.maturity,
            index: index,
            priceDecimals: p.priceDecimals,
            canonical: true
        });
        _canonical.push(seriesId);

        emit CanonicalSeriesCreated(seriesId, index, msg.sender);
    }

    /// @notice Every canonical series, in creation order.
    /// @dev A front end must list from here and never from the vault at large:
    ///      anyone can open a series on the vault with any terms they like.
    function canonicalSeries() external view returns (uint256[] memory) {
        return _canonical;
    }

    function canonicalAt(uint256 i) external view returns (uint256) {
        return _canonical[i];
    }

    function canonicalCount() external view returns (uint256) {
        return _canonical.length;
    }

    function configurationIdFor(SettlementConfigurationParams memory c) public pure returns (bytes32) {
        return keccak256(
            abi.encode(
                c.collateral, c.oracle, c.fallbackOracle, c.feedId, c.settlementModel, c.fallbackDelay, c.priceDecimals
            )
        );
    }

    function activeSettlementConfiguration(address collateral)
        external
        view
        returns (bytes32 configurationId, SettlementConfiguration memory configuration)
    {
        configurationId = activeConfigurationId[collateral];
        configuration = configurationOf[configurationId];
    }

    // --- Internals -----------------------------------------------------------

    function _setBounds(Bounds memory b) internal {
        if (b.minHorizon > b.maxHorizon) revert Errors.InvalidParams();
        if (b.minSettlementDelay > b.maxSettlementDelay) revert Errors.InvalidParams();
        if (b.minPriceLag > b.maxPriceLag || b.minPriceLag == 0) revert Errors.InvalidParams();
        if (b.maxConfBps == 0) revert Errors.InvalidParams();
        bounds = b;
        emit BoundsChanged();
    }

    function _validateConfiguration(SettlementConfigurationParams calldata c) internal view {
        if (c.collateral == address(0) || c.oracle == address(0) || c.feedId == bytes32(0)) {
            revert Errors.InvalidSettlementConfiguration();
        }
        if (c.priceDecimals != bounds.priceDecimals) revert Errors.OracleDecimalsInvalid();
        if (IOracleAdapter(c.oracle).settlementModel() != c.settlementModel) {
            revert Errors.OraclePairInvalid();
        }
        if (
            c.fallbackOracle != address(0)
                && IFallbackSettlementOracle(c.fallbackOracle).settlementModel() != c.settlementModel
        ) revert Errors.OraclePairInvalid();
        // One fallback per stock: a shared one would settle every stock it serves at one answer.
        if (c.fallbackOracle != address(0) && IFallbackSettlementOracle(c.fallbackOracle).configuredFeedId() != c.feedId) {
            revert Errors.FeedMismatch();
        }
        if ((c.fallbackOracle == address(0)) != (c.fallbackDelay == 0)) {
            revert Errors.InvalidSettlementConfiguration();
        }
    }

    function _requireWithinBounds(ErodoroVault.CreateSeriesParams calldata p)
        internal
        view
        returns (bytes32 configurationId)
    {
        Bounds memory b = bounds;

        SettlementConfigurationParams memory c = SettlementConfigurationParams({
            collateral: p.collateral,
            oracle: p.oracle,
            fallbackOracle: p.fallbackOracle,
            feedId: p.feedId,
            settlementModel: p.settlementModel,
            fallbackDelay: p.fallbackDelay,
            priceDecimals: p.priceDecimals
        });
        configurationId = configurationIdFor(c);
        SettlementConfiguration storage configured = configurationOf[configurationId];
        if (
            activeConfigurationId[p.collateral] != configurationId || !configured.enabled
                || configured.collateral == address(0)
        ) revert Errors.InvalidSettlementConfiguration();

        if (p.maturity < block.timestamp + b.minHorizon) revert Errors.InvalidMaturity();
        if (p.maturity > block.timestamp + b.maxHorizon) revert Errors.InvalidMaturity();

        if (p.settlementDelay < b.minSettlementDelay || p.settlementDelay > b.maxSettlementDelay) {
            revert Errors.InvalidParams();
        }
        if (p.maxPriceLag < b.minPriceLag || p.maxPriceLag > b.maxPriceLag) revert Errors.InvalidParams();

        // Pyth supplies a confidence band. Chainlink does not. Do not apply a
        // Pyth-only quality field to a total-return configuration.
        if (p.settlementModel == SettlementModel.RAW_SHARE) {
            if (p.maxConfBps == 0 || p.maxConfBps > b.maxConfBps) revert Errors.InvalidParams();
        } else if (p.maxConfBps != 0) {
            revert Errors.InvalidParams();
        }

        if (p.feeBps > b.maxFeeBps) revert Errors.InvalidParams();
        if (p.priceDecimals != b.priceDecimals) revert Errors.OracleDecimalsInvalid();
        if (p.strike == 0) revert Errors.InvalidStrike();

        if (p.fallbackOracle != address(0)) {
            uint256 notBefore = uint256(p.maturity) + _max(p.settlementDelay, p.maxPriceLag) + p.fallbackDelay;
            if (notBefore > type(uint64).max) revert Errors.InvalidParams();
            bytes32 expected =
                IFallbackSettlementOracle(p.fallbackOracle).requestIdFor(p.maturity, notBefore.toUint64());
            if (p.fallbackRequestId != expected) revert Errors.InvalidSettlementConfiguration();
        }
    }

    function _max(uint64 a, uint64 b) internal pure returns (uint64) {
        return a > b ? a : b;
    }
}
