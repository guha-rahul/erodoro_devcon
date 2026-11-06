// SPDX-License-Identifier: Apache-2.0
pragma solidity 0.8.28;

import {ERC6909TokenSupply} from "@openzeppelin/contracts/token/ERC6909/extensions/ERC6909TokenSupply.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {IOracleAdapter} from "./oracle/IOracleAdapter.sol";
import {IFallbackSettlementOracle} from "./oracle/IFallbackSettlementOracle.sol";
import {SettlementModel} from "./oracle/SettlementModel.sol";
import {PayoutMath} from "./libraries/PayoutMath.sol";

/// @notice Separate, cash-settled put claims for Market Rip. Does not alter the
///         stock-collateralized P/N vault. One claim unit is one raw underlying
///         token unit; a whole-share equivalent is 10**unitDecimals units.
/// @dev Only TOTAL_RETURN feeds are accepted. Their multiplier-adjusted price
///      keeps the strike and the fixed claim unit meaningful across B20 splits.
contract MarketRipPut is ERC6909TokenSupply, ReentrancyGuard {
    using SafeERC20 for IERC20;

    address public constant BASE_USDC = 0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913;

    struct Series {
        address underlying;
        address oracle;
        address fallbackOracle;
        bytes32 feedId;
        bytes32 fallbackRequestId;
        uint256 strike;
        uint64 maturity;
        uint64 settlementDelay;
        uint64 maxPriceLag;
        uint64 fallbackDelay;
        uint32 maxConfBps;
        uint8 priceDecimals;
        uint8 unitDecimals;
        bool exists;
        bool settled;
        uint256 settlementPrice;
        uint256 payoutPerShare;
        uint256 collateralSupplied;
        uint256 collateralRemaining;
        uint256 unitsMinted;
    }

    IERC20 public immutable usdc;
    address public immutable erodoro;
    uint8 public immutable usdcDecimals;
    uint256 public nextSeriesId = 1;
    mapping(uint256 => Series) private _series;

    event SeriesCreated(uint256 indexed seriesId, address indexed underlying, uint256 strike, uint64 maturity);
    event Funded(uint256 indexed seriesId, uint256 units, uint256 collateral);
    event Settled(uint256 indexed seriesId, uint256 price, uint256 payoutPerShare, bool fallbackUsed);
    event Redeemed(uint256 indexed seriesId, address indexed holder, uint256 units, uint256 usdcPaid);
    event SurplusWithdrawn(uint256 indexed seriesId, uint256 amount);

    error Unauthorized();
    error InvalidSeries();
    error InvalidTerms();
    error AlreadySettled();
    error NotSettled();
    error TooEarly();
    error TooLate();
    error BadOraclePrice();
    error TransferShortfall();

    constructor(IERC20 usdc_, address erodoro_) {
        if (address(usdc_) == address(0) || erodoro_ == address(0)) revert InvalidTerms();
        if (block.chainid == 8453 && address(usdc_) != BASE_USDC) revert InvalidTerms();
        uint8 decimals = IERC20Metadata(address(usdc_)).decimals();
        if (decimals == 0 || decimals > 18) revert InvalidTerms();
        usdc = usdc_;
        erodoro = erodoro_;
        usdcDecimals = decimals;
    }

    modifier onlyErodoro() {
        if (msg.sender != erodoro) revert Unauthorized();
        _;
    }

    function series(uint256 id) external view returns (Series memory) {
        return _series[id];
    }

    function createSeries(
        address underlying,
        address oracle,
        address fallbackOracle,
        bytes32 feedId,
        bytes32 fallbackRequestId,
        uint256 strike,
        uint64 maturity,
        uint64 settlementDelay,
        uint64 maxPriceLag,
        uint64 fallbackDelay,
        uint32 maxConfBps,
        uint8 priceDecimals
    ) external onlyErodoro returns (uint256 id) {
        if (underlying == address(0) || oracle == address(0) || feedId == bytes32(0) || strike == 0) revert InvalidTerms();
        if (maturity <= block.timestamp || maxPriceLag == 0 || settlementDelay > maxPriceLag) revert InvalidTerms();
        if (uint256(maturity) + maxPriceLag + fallbackDelay > type(uint64).max) revert InvalidTerms();
        // The existing total-return Chainlink adapter requires zero here.
        if (priceDecimals > 18 || maxConfBps != 0) revert InvalidTerms();
        if (IOracleAdapter(oracle).settlementModel() != SettlementModel.TOTAL_RETURN) revert InvalidTerms();
        if (fallbackOracle == address(0)) {
            if (fallbackRequestId != bytes32(0) || fallbackDelay != 0) revert InvalidTerms();
        } else {
            if (fallbackRequestId == bytes32(0) || fallbackDelay == 0) revert InvalidTerms();
            if (IFallbackSettlementOracle(fallbackOracle).settlementModel() != SettlementModel.TOTAL_RETURN) revert InvalidTerms();
        }
        uint8 unitDecimals = IERC20Metadata(underlying).decimals();
        if (unitDecimals > 18) revert InvalidTerms();
        id = nextSeriesId++;
        Series storage s = _series[id];
        s.underlying = underlying;
        s.oracle = oracle;
        s.fallbackOracle = fallbackOracle;
        s.feedId = feedId;
        s.fallbackRequestId = fallbackRequestId;
        s.strike = strike;
        s.maturity = maturity;
        s.settlementDelay = settlementDelay;
        s.maxPriceLag = maxPriceLag;
        s.fallbackDelay = fallbackDelay;
        s.maxConfBps = maxConfBps;
        s.priceDecimals = priceDecimals;
        s.unitDecimals = unitDecimals;
        s.exists = true;
        emit SeriesCreated(id, underlying, strike, maturity);
    }

    /// @notice Mint transferable put units only after their maximum cash payout
    ///         has arrived. Cumulative ceiling avoids underfunding on repeats.
    function fundAndMint(uint256 id, uint256 units) external onlyErodoro nonReentrant {
        Series storage s = _requireSeries(id);
        if (block.timestamp >= s.maturity) revert TooLate();
        if (units == 0) revert InvalidTerms();
        uint256 nextUnits = s.unitsMinted + units;
        uint256 required = _liability(s.strike, nextUnits, s.priceDecimals, s.unitDecimals);
        uint256 added = required - s.collateralSupplied;
        uint256 beforeBalance = usdc.balanceOf(address(this));
        usdc.safeTransferFrom(msg.sender, address(this), added);
        if (usdc.balanceOf(address(this)) != beforeBalance + added) revert TransferShortfall();
        s.unitsMinted = nextUnits;
        s.collateralSupplied = required;
        s.collateralRemaining += added;
        _mint(msg.sender, id, units);
        emit Funded(id, units, added);
    }

    function settle(uint256 id, bytes[] calldata updateData) external nonReentrant {
        Series storage s = _requireSeries(id);
        if (s.settled) revert AlreadySettled();
        if (block.timestamp < uint256(s.maturity) + s.settlementDelay) revert TooEarly();
        if (IOracleAdapter(s.oracle).settlementModel() != SettlementModel.TOTAL_RETURN) revert InvalidTerms();
        (uint256 price, uint8 decimals, uint64 timestamp) = IOracleAdapter(s.oracle).settlementPrice(
            s.feedId, s.maturity, s.maturity + s.maxPriceLag, s.maxConfBps, updateData
        );
        _recordSettlement(s, id, price, decimals, timestamp, false);
    }

    function settleFallback(uint256 id, bytes calldata resolutionData) external nonReentrant {
        Series storage s = _requireSeries(id);
        if (s.settled) revert AlreadySettled();
        if (s.fallbackOracle == address(0)) revert InvalidTerms();
        if (block.timestamp < uint256(s.maturity) + s.maxPriceLag + s.fallbackDelay) revert TooEarly();
        if (IFallbackSettlementOracle(s.fallbackOracle).settlementModel() != SettlementModel.TOTAL_RETURN) revert InvalidTerms();
        (uint256 price, uint8 decimals, uint64 timestamp, bool finalized) =
            IFallbackSettlementOracle(s.fallbackOracle).finalizedPrice(s.fallbackRequestId, resolutionData);
        if (!finalized) revert BadOraclePrice();
        _recordSettlement(s, id, price, decimals, timestamp, true);
    }

    function redeem(uint256 id, uint256 units) external nonReentrant returns (uint256 paid) {
        Series storage s = _requireSeries(id);
        if (!s.settled) revert NotSettled();
        if (units == 0) revert InvalidTerms();
        _burn(msg.sender, id, units);
        // Redemption rounds down. `_liability` rounds up for funding, so use
        // a separate floor here to preserve aggregate solvency.
        paid = _payout(s.payoutPerShare, units, s.priceDecimals, s.unitDecimals);
        s.collateralRemaining -= paid;
        if (paid > 0) usdc.safeTransfer(msg.sender, paid);
        emit Redeemed(id, msg.sender, units, paid);
    }

    /// @notice Release collateral that cannot be owed after settlement, or
    ///         after every claim has been burned. Other series stay isolated.
    function withdrawSurplus(uint256 id) external onlyErodoro nonReentrant returns (uint256 amount) {
        Series storage s = _requireSeries(id);
        if (!s.settled) revert NotSettled();
        uint256 maximumOwed = _liability(s.payoutPerShare, totalSupply(id), s.priceDecimals, s.unitDecimals);
        amount = s.collateralRemaining - maximumOwed;
        if (amount > 0) {
            s.collateralRemaining = maximumOwed;
            usdc.safeTransfer(erodoro, amount);
            emit SurplusWithdrawn(id, amount);
        }
    }

    function _recordSettlement(Series storage s, uint256 id, uint256 rawPrice, uint8 decimals, uint64 timestamp, bool fallbackUsed) internal {
        if (timestamp < s.maturity || timestamp > s.maturity + s.maxPriceLag) revert BadOraclePrice();
        if (rawPrice == 0 || decimals > 18) revert BadOraclePrice();
        uint256 price = PayoutMath.normalizeDecimals(rawPrice, decimals, s.priceDecimals);
        if (price == 0) revert BadOraclePrice();
        s.settlementPrice = price;
        s.payoutPerShare = price < s.strike ? s.strike - price : 0;
        s.settled = true;
        emit Settled(id, price, s.payoutPerShare, fallbackUsed);
    }

    function _liability(uint256 perShare, uint256 units, uint8 priceDecimals, uint8 unitDecimals) internal view returns (uint256) {
        return Math.mulDiv(perShare, units * 10 ** usdcDecimals, 10 ** uint256(priceDecimals) * 10 ** uint256(unitDecimals), Math.Rounding.Ceil);
    }

    function _payout(uint256 perShare, uint256 units, uint8 priceDecimals, uint8 unitDecimals) internal view returns (uint256) {
        return Math.mulDiv(perShare, units * 10 ** usdcDecimals, 10 ** uint256(priceDecimals) * 10 ** uint256(unitDecimals), Math.Rounding.Floor);
    }

    function _requireSeries(uint256 id) internal view returns (Series storage s) {
        s = _series[id];
        if (!s.exists) revert InvalidSeries();
    }
}
