// SPDX-License-Identifier: Apache-2.0
pragma solidity 0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import {IERC6909} from "@openzeppelin/contracts/interfaces/IERC6909.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {ErodoroVault} from "./ErodoroVault.sol";
import {Factory} from "./Factory.sol";
import {IErodoroVault} from "./interfaces/IErodoroVault.sol";
import {MarketRipPut} from "./MarketRipPut.sol";
import {SettlementModel} from "./oracle/SettlementModel.sol";

/// @notice Blind $1 sale of real vault N or cash-backed put units.
/// @dev Erodoro seeds each batch's markets and supplies their $1 quotes. Any
///      seller can then lock stock into one of those markets with `lockAndList`:
///      the seller keeps P, lists N at their own price, and is paid directly for
///      every unit bought. The Erodoro operator supplies each house $1 quote. A quote is the
///      exact number of claim base units sold for 1e6 USDC and has an expiry.
///      The quote defines purchase quantity, not an executable resale mark. Random
///      selection uses block entropy: adequate for this tiny trusted-house MVP,
///      but block builders can bias it and it is not cryptographic randomness.
contract MarketRipPool is ReentrancyGuard {
    using SafeERC20 for IERC20;

    address public constant BASE_USDC = 0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913;

    uint256 public constant RIP_PRICE = 1_000_000;
    uint256 public constant INITIAL_VALUE = 5_000_000;
    /// @dev The operator picks each batch's expiry inside these bounds, so it can
    ///      land while the stock market is open and settlement feeds are updating.
    uint256 public constant MIN_BATCH_DURATION = 7 days;
    uint256 public constant MAX_BATCH_DURATION = 45 days;
    uint256 public constant MAX_POSITIONS = 10;
    uint256 public constant MAX_QUOTE_AGE = 5 minutes;
    /// @dev Bounds ripUp's scan of a batch: 10 house markets plus seller listings.
    uint256 public constant MAX_BATCH_POSITIONS = 40;
    /// @notice A $1 pack buys PACK_SLICE of upside on each of PACK_SIZE different stocks.
    uint256 public constant PACK_SIZE = 10;
    uint256 public constant PACK_SLICE = RIP_PRICE / PACK_SIZE;
    /// @notice Most packs one `ripPacks` call may buy, keeping its gas bounded.
    uint256 public constant MAX_PACKS = 10;
    /// @notice A seller listing must hold at least this many dollars of N at the
    ///         house quote, so a handful of dust listings cannot fill a batch.
    uint256 public constant MIN_LISTING_DOLLARS = 5;

    enum Direction { UP, DOWN }
    enum State { ACTIVE, SOLD_OUT, EXPIRED, UNQUOTED }

    struct Position {
        uint256 batchId;
        address stock;
        address claims;
        uint256 claimId;
        Direction direction;
        uint256 spotAtCreation;
        uint256 strike;
        uint8 priceDecimals;
        uint64 expiry;
        uint256 totalInventoryUnits;
        uint256 remainingUnits;
        uint256 collateralSupplied;
        uint256 unitsPerRip;
        uint64 quoteValidUntil;
        bytes32 quoteRef;
        uint256 amountSold;
        uint256 buyerCount;
        address seller;
    }

    struct AddPositionParams {
        uint256 batchId;
        address stock;
        Direction direction;
        uint256 claimId;
        uint256 spotAtCreation;
        uint256 unitsPerRip;
        uint64 quoteValidUntil;
        bytes32 quoteRef;
    }

    IERC20 public immutable usdc;
    ErodoroVault public immutable vault;
    Factory public immutable factory;
    MarketRipPut public immutable put;
    address public immutable erodoro;
    /// @notice Hot key allowed to refresh house quotes and pause sales. Set by
    ///         `erodoro`, which on mainnet is a multisig; zero means none.
    address public quoter;
    /// @notice While paused no purchase or new listing goes through. Sellers can
    ///         still withdraw and expired inventory can still be returned.
    bool public paused;
    uint256 public nextBatchId = 1;
    uint256 public nextPositionId = 1;
    uint256 public activeBatchId;
    uint256 public purchaseNonce;
    mapping(uint256 => uint64) public batchCreatedAt;
    mapping(uint256 => uint64) public batchExpiry;
    mapping(uint256 => uint256[]) private _batchPositions;
    /// @notice The house position for each stock in a batch.
    mapping(uint256 => mapping(address => uint256)) public housePosition;
    mapping(uint256 => mapping(address => bool)) public stockInBatch;
    mapping(uint256 => mapping(address => bool)) public hasBought;
    mapping(address => uint256[]) private _buyerPositions;
    mapping(address => mapping(uint256 => uint256)) public purchasedValue;
    mapping(address => mapping(uint256 => uint256)) public purchasedUnits;
    mapping(uint256 => Position) private _positions;
    mapping(address => uint256[]) private _sellerPositions;
    uint256 public listingNonce;
    uint256 public packNonce;

    event BatchCreated(uint256 indexed batchId, uint64 createdAt, uint64 expiry);
    event BatchActivated(uint256 indexed batchId);
    event PositionAdded(uint256 indexed positionId, uint256 indexed batchId, address indexed stock, Direction direction, uint256 claimId, uint256 units, uint256 collateral);
    event QuoteSet(uint256 indexed positionId, uint256 unitsPerRip, uint64 validUntil, bytes32 quoteRef);
    event RipPurchased(address indexed buyer, uint256 indexed batchId, uint256 indexed positionId, address claims, uint256 claimId, uint256 units, uint256 usdcPaid, bytes32 quoteRef);
    event InventoryReturned(uint256 indexed positionId, uint256 units);
    event Listed(uint256 indexed positionId, address indexed seller, uint256 indexed templateId, uint256 collateral, uint256 units);
    event ListingWithdrawn(uint256 indexed positionId, address indexed seller, uint256 units);
    event QuoterSet(address indexed quoter);
    event Paused(bool paused);
    event PackPurchased(address indexed buyer, uint256 indexed batchId, uint256 indexed packId, uint256[] positionIds);

    error Unauthorized();
    error InvalidPosition();
    error InvalidBatch();
    error InvalidTerms();
    error NoInventory();
    error ClaimTransferFailed();
    error PaymentShortfall();
    error TooEarly();
    error QuoteChanged();
    error OwnListing();
    error SalesPaused();

    /// @notice Feature probe: older pool deployments cannot perform these buys.
    function supportsDirectedBuys() external pure returns (bool) { return true; }

    /// @notice Feature probe: this pool sells $1 packs across PACK_SIZE stocks.
    function supportsPacks() external pure returns (bool) { return true; }

    /// @notice Binds a blind upside purchase to the exact displayed inventory:
    ///         which listings are eligible, how much each has left and its price.
    ///         A quote refresh at the same price (new ref and expiry only) leaves
    ///         it unchanged, so routine refreshes do not fail buys in flight.
    function upInventoryHash() public view returns (bytes32 result) {
        result = keccak256(abi.encode(activeBatchId));
        uint256[] storage ids = _batchPositions[activeBatchId];
        for (uint256 i; i < ids.length; ++i) {
            Position storage p = _positions[ids[i]];
            if (p.direction == Direction.UP && _blindEligible(p)) {
                result = keccak256(abi.encode(result, ids[i], p.remainingUnits, p.unitsPerRip));
            }
        }
    }

    /// @notice Blind $1 purchase of N only. P and put inventory is excluded,
    ///         and so are the caller's own listings: a seller cannot pay themselves.
    function ripUp(bytes32 expectedInventory) external nonReentrant whenNotPaused returns (uint256 positionId, uint256 units) {
        if (expectedInventory != upInventoryHash()) revert QuoteChanged();
        uint256[] storage ids = _batchPositions[activeBatchId];
        uint256 eligible;
        for (uint256 i; i < ids.length; ++i) {
            Position storage c = _positions[ids[i]];
            if (c.direction == Direction.UP && c.seller != msg.sender && _blindEligible(c)) ++eligible;
        }
        if (eligible == 0) revert NoInventory();
        uint256 pick = uint256(keccak256(abi.encode(block.prevrandao, blockhash(block.number - 1), msg.sender, purchaseNonce++))) % eligible;
        for (uint256 i; i < ids.length; ++i) {
            Position storage p = _positions[ids[i]];
            if (p.direction != Direction.UP || p.seller == msg.sender || !_blindEligible(p)) continue;
            if (pick == 0) { positionId = ids[i]; break; }
            --pick;
        }
        units = _purchase(positionId, 1);
    }

    /// @notice Buy a selected N position, at the quantity and reference reviewed by the buyer.
    function buyPosition(uint256 positionId, uint256 dollars, uint256 expectedUnitsPerRip, bytes32 expectedQuoteRef)
        external nonReentrant whenNotPaused returns (uint256 units)
    {
        Position storage p = _positions[positionId];
        if (dollars == 0 || dollars > 20 || p.batchId != activeBatchId || p.direction != Direction.UP) revert InvalidTerms();
        if (p.unitsPerRip != expectedUnitsPerRip || p.quoteRef != expectedQuoteRef) revert QuoteChanged();
        if (p.seller == msg.sender) revert OwnListing();
        units = _purchase(positionId, dollars);
    }

    /// @notice One $1 pack: PACK_SLICE of N on each of PACK_SIZE different
    ///         stocks, one transaction. Each stock's slice comes from one of that
    ///         stock's eligible listings (house or seller) chosen at random, never
    ///         the caller's own. Bound to the same inventory hash as `ripUp`.
    function ripPack(bytes32 expectedInventory)
        external nonReentrant whenNotPaused returns (uint256[] memory positionIds, uint256[] memory units)
    {
        if (expectedInventory != upInventoryHash()) revert QuoteChanged();
        return _ripPack();
    }

    /// @notice `count` $1 packs in one transaction, each as `ripPack`. The
    ///         inventory hash is checked once, before the first pack: every
    ///         later pack moves it. Returns all packs' slices in order.
    function ripPacks(bytes32 expectedInventory, uint256 count)
        external nonReentrant whenNotPaused returns (uint256[] memory positionIds, uint256[] memory units)
    {
        if (count == 0 || count > MAX_PACKS) revert InvalidTerms();
        if (expectedInventory != upInventoryHash()) revert QuoteChanged();
        positionIds = new uint256[](count * PACK_SIZE);
        units = new uint256[](count * PACK_SIZE);
        for (uint256 r; r < count; ++r) {
            (uint256[] memory ids, uint256[] memory got) = _ripPack();
            for (uint256 k; k < PACK_SIZE; ++k) {
                positionIds[r * PACK_SIZE + k] = ids[k];
                units[r * PACK_SIZE + k] = got[k];
            }
        }
    }

    function _ripPack() internal returns (uint256[] memory positionIds, uint256[] memory units) {
        (address[] memory stocks, uint256[] memory counts, uint256 n) = _packStocks(msg.sender);
        if (n < PACK_SIZE) revert NoInventory();
        uint256 seed = uint256(keccak256(abi.encode(block.prevrandao, blockhash(block.number - 1), msg.sender, purchaseNonce++)));
        // Partial Fisher-Yates over stock indexes: distinct stocks when more than PACK_SIZE are on offer.
        uint256[] memory order = new uint256[](n);
        for (uint256 i; i < n; ++i) order[i] = i;
        positionIds = new uint256[](PACK_SIZE);
        units = new uint256[](PACK_SIZE);
        for (uint256 k; k < PACK_SIZE; ++k) {
            uint256 j = k + uint256(keccak256(abi.encode(seed, k))) % (n - k);
            (order[k], order[j]) = (order[j], order[k]);
            uint256 s = order[k];
            uint256 id = _packCandidate(stocks[s], uint256(keccak256(abi.encode(seed, k, s))) % counts[s], msg.sender);
            positionIds[k] = id;
            units[k] = _fill(id, _positions[id].unitsPerRip / PACK_SIZE, PACK_SLICE);
        }
        emit PackPurchased(msg.sender, activeBatchId, ++packNonce, positionIds);
    }

    /// @dev A listing a pack may draw from: open upside, not the buyer's own, and
    ///      priced finely enough that a tenth of its $1 quantity is non-zero.
    function _packable(Position storage p, address buyer) internal view returns (bool) {
        return p.direction == Direction.UP && p.seller != buyer && _blindEligible(p) && p.unitsPerRip >= PACK_SIZE;
    }

    /// @dev Distinct stocks with packable inventory, and how many listings each has.
    function _packStocks(address buyer) internal view returns (address[] memory stocks, uint256[] memory counts, uint256 n) {
        uint256[] storage ids = _batchPositions[activeBatchId];
        stocks = new address[](ids.length);
        counts = new uint256[](ids.length);
        for (uint256 i; i < ids.length; ++i) {
            Position storage c = _positions[ids[i]];
            if (!_packable(c, buyer)) continue;
            uint256 s;
            while (s < n && stocks[s] != c.stock) ++s;
            if (s == n) stocks[n++] = c.stock;
            ++counts[s];
        }
    }

    /// @dev The `pick`-th packable listing of `stock`, in batch order.
    function _packCandidate(address stock, uint256 pick, address buyer) internal view returns (uint256) {
        uint256[] storage ids = _batchPositions[activeBatchId];
        for (uint256 i; i < ids.length; ++i) {
            Position storage c = _positions[ids[i]];
            if (c.stock != stock || !_packable(c, buyer)) continue;
            if (pick == 0) return ids[i];
            --pick;
        }
        revert NoInventory();
    }

    function _purchase(uint256 positionId, uint256 dollars) internal returns (uint256 units) {
        Position storage p = _positions[positionId];
        units = _fill(positionId, p.unitsPerRip * dollars, RIP_PRICE * dollars);
    }

    /// @dev Moves `units` of N to the buyer for `cost` USDC paid straight to the listing's seller.
    function _fill(uint256 positionId, uint256 units, uint256 cost) internal returns (uint256) {
        Position storage p = _positions[positionId];
        if (!_eligible(p)) revert NoInventory();
        if (units == 0 || p.remainingUnits < units) revert NoInventory();
        p.remainingUnits -= units;
        p.amountSold += cost;
        if (!hasBought[positionId][msg.sender]) {
            hasBought[positionId][msg.sender] = true;
            p.buyerCount += 1;
            _buyerPositions[msg.sender].push(positionId);
        }
        purchasedValue[msg.sender][positionId] += cost;
        purchasedUnits[msg.sender][positionId] += units;
        // The seller who locked this inventory is paid directly.
        uint256 beforeBalance = usdc.balanceOf(p.seller);
        usdc.safeTransferFrom(msg.sender, p.seller, cost);
        if (usdc.balanceOf(p.seller) != beforeBalance + cost) revert PaymentShortfall();
        if (!IERC6909(p.claims).transfer(msg.sender, p.claimId, units)) revert ClaimTransferFailed();
        emit RipPurchased(msg.sender, p.batchId, positionId, p.claims, p.claimId, units, cost, p.quoteRef);
        return units;
    }

    constructor(IERC20 usdc_, ErodoroVault vault_, Factory factory_, MarketRipPut put_, address erodoro_) {
        if (address(usdc_) == address(0) || address(vault_) == address(0) || address(factory_) == address(0) || address(put_) == address(0) || erodoro_ == address(0)) revert InvalidTerms();
        if (address(put_.usdc()) != address(usdc_)) revert InvalidTerms();
        if (block.chainid == 8453 && address(usdc_) != BASE_USDC) revert InvalidTerms();
        if (address(factory_.vault()) != address(vault_)) revert InvalidTerms();
        if (IERC20Metadata(address(usdc_)).decimals() != 6) revert InvalidTerms();
        usdc = usdc_;
        vault = vault_;
        factory = factory_;
        put = put_;
        erodoro = erodoro_;
    }

    modifier onlyErodoro() {
        if (msg.sender != erodoro) revert Unauthorized();
        _;
    }

    modifier onlyQuoter() {
        if (msg.sender != erodoro && (msg.sender != quoter || quoter == address(0))) revert Unauthorized();
        _;
    }

    modifier whenNotPaused() {
        if (paused) revert SalesPaused();
        _;
    }

    function setQuoter(address quoter_) external onlyErodoro {
        quoter = quoter_;
        emit QuoterSet(quoter_);
    }

    /// @notice The quoter can stop sales fast; only `erodoro` resumes them.
    function setPaused(bool paused_) external onlyQuoter {
        if (!paused_ && msg.sender != erodoro) revert Unauthorized();
        paused = paused_;
        emit Paused(paused_);
    }

    /// @param expiry When the batch and every series in it mature. Chosen off
    ///        chain to fall inside US market hours.
    function createBatch(uint64 expiry) external onlyErodoro returns (uint256 id) {
        uint64 nowTs = uint64(block.timestamp);
        if (expiry < nowTs + MIN_BATCH_DURATION || expiry > nowTs + MAX_BATCH_DURATION) revert InvalidTerms();
        id = nextBatchId++;
        batchCreatedAt[id] = nowTs;
        batchExpiry[id] = expiry;
        emit BatchCreated(id, nowTs, expiry);
    }

    function activateBatch(uint256 id) external onlyErodoro {
        if (id != nextBatchId - 1 || block.timestamp >= batchExpiry[id] || _batchPositions[id].length != MAX_POSITIONS) revert InvalidBatch();
        for (uint256 i; i < MAX_POSITIONS; ++i) {
            if (!_eligible(_positions[_batchPositions[id][i]])) revert NoInventory();
        }
        activeBatchId = id;
        emit BatchActivated(id);
    }

    function batchPositions(uint256 id) external view returns (uint256[] memory) {
        return _batchPositions[id];
    }

    function buyerPositions(address buyer) external view returns (uint256[] memory) {
        return _buyerPositions[buyer];
    }

    function sellerPositions(address seller) external view returns (uint256[] memory) {
        return _sellerPositions[seller];
    }

    function position(uint256 id) external view returns (Position memory) {
        return _positions[id];
    }

    function remainingInventoryValue(uint256 id) public view returns (uint256) {
        Position storage p = _positions[id];
        if (p.unitsPerRip == 0) return 0;
        return Math.mulDiv(p.remainingUnits, RIP_PRICE, p.unitsPerRip, Math.Rounding.Floor);
    }

    function totalInventoryValue(uint256 id) external view returns (uint256) {
        Position storage p = _positions[id];
        if (p.unitsPerRip == 0) return 0;
        return Math.mulDiv(p.totalInventoryUnits, RIP_PRICE, p.unitsPerRip, Math.Rounding.Floor);
    }

    function state(uint256 id) external view returns (State) {
        Position storage p = _positions[id];
        if (p.batchId == 0) revert InvalidPosition();
        if (block.timestamp >= p.expiry) return State.EXPIRED;
        if (p.unitsPerRip == 0 || block.timestamp > p.quoteValidUntil) return State.UNQUOTED;
        if (p.remainingUnits < p.unitsPerRip) return State.SOLD_OUT;
        return State.ACTIVE;
    }

    /// @notice Stock spot and quote are supplied by Erodoro's reviewed feed.
    ///         The pool checks the strike against that spot and the actual
    ///         series, but cannot independently attest the spot timestamp.
    function addPosition(AddPositionParams calldata a) external onlyErodoro nonReentrant returns (uint256 id) {
        if (a.batchId != nextBatchId - 1 || block.timestamp >= batchExpiry[a.batchId]) revert InvalidBatch();
        if (a.stock == address(0) || stockInBatch[a.batchId][a.stock] || _batchPositions[a.batchId].length >= MAX_POSITIONS) revert InvalidTerms();
        if (a.spotAtCreation == 0 || a.unitsPerRip == 0 || a.quoteRef == bytes32(0)) revert InvalidTerms();
        if (a.quoteValidUntil < block.timestamp || a.quoteValidUntil > block.timestamp + MAX_QUOTE_AGE || a.quoteValidUntil > batchExpiry[a.batchId]) revert InvalidTerms();

        uint256 units = Math.mulDiv(a.unitsPerRip, INITIAL_VALUE, RIP_PRICE);
        (address claims, uint256 strike, uint256 collateral, uint8 priceDecimals) =
            _validateBacking(a.batchId, a.stock, a.direction, a.claimId, a.spotAtCreation, units);

        // The pool receives the actual tokenized economic claim before it can
        // advertise inventory. A failed or fee-bearing transfer cannot list.
        uint256 beforeBalance = IERC6909(claims).balanceOf(address(this), a.claimId);
        if (!IERC6909(claims).transferFrom(msg.sender, address(this), a.claimId, units)) revert ClaimTransferFailed();
        if (IERC6909(claims).balanceOf(address(this), a.claimId) != beforeBalance + units) revert ClaimTransferFailed();

        id = nextPositionId++;
        Position storage p = _positions[id];
        p.batchId = a.batchId;
        p.stock = a.stock;
        p.claims = claims;
        p.claimId = a.claimId;
        p.direction = a.direction;
        p.spotAtCreation = a.spotAtCreation;
        p.strike = strike;
        p.priceDecimals = priceDecimals;
        p.expiry = batchExpiry[a.batchId];
        p.totalInventoryUnits = units;
        p.remainingUnits = units;
        p.collateralSupplied = collateral;
        p.unitsPerRip = a.unitsPerRip;
        p.quoteValidUntil = a.quoteValidUntil;
        p.quoteRef = a.quoteRef;
        p.seller = erodoro;
        stockInBatch[a.batchId][a.stock] = true;
        housePosition[a.batchId][a.stock] = id;
        _batchPositions[a.batchId].push(id);
        emit PositionAdded(id, a.batchId, a.stock, a.direction, a.claimId, units, collateral);
        emit QuoteSet(id, a.unitsPerRip, a.quoteValidUntil, a.quoteRef);
    }

    function _validateBacking(
        uint256 batchId, address stock, Direction direction, uint256 claimId, uint256 spotAtCreation, uint256 units
    ) internal view returns (address claims, uint256 strike, uint256 collateral, uint8 priceDecimals) {
        if (direction == Direction.UP) {
            uint256 seriesId = claimId & ~uint256(1);
            if (claimId != vault.nId(seriesId)) revert InvalidTerms();
            IErodoroVault.SeriesConfig memory cfg = vault.seriesConfig(seriesId);
            // Only TOTAL_RETURN series: the Coinbase Chainlink feeds, which price
            // the token itself (share price times multiplier).
            if (!cfg.exists || cfg.creator != address(factory) || cfg.settlementModel != SettlementModel.TOTAL_RETURN || cfg.collateral != stock || cfg.maturity != batchExpiry[batchId]) revert InvalidTerms();
            // On mainnet every series needs a fallback settlement path, so a
            // feed that stays silent after maturity cannot strand buyers.
            if (block.chainid == 8453 && cfg.fallbackOracle == address(0)) revert InvalidTerms();
            strike = cfg.strike;
            priceDecimals = cfg.priceDecimals;
            if (strike != Math.mulDiv(spotAtCreation, 105, 100, Math.Rounding.Ceil)) revert InvalidTerms();
            collateral = units; // one locked stock token unit backs one N unit
            if (vault.lockedOf(seriesId) < collateral) revert InvalidTerms();
            claims = address(vault);
        } else {
            MarketRipPut.Series memory s = put.series(claimId);
            if (!s.exists || s.underlying != stock || s.maturity != batchExpiry[batchId]) revert InvalidTerms();
            strike = s.strike;
            priceDecimals = s.priceDecimals;
            if (strike != Math.mulDiv(spotAtCreation, 95, 100, Math.Rounding.Floor)) revert InvalidTerms();
            if (put.totalSupply(claimId) != units) revert InvalidTerms();
            collateral = s.collateralSupplied;
            claims = address(put);
        }
    }

    /// @notice Refresh the claim quantity sold for each $1. The supplied
    ///         quantity must be based on a firm external market quote.
    function setQuote(uint256 id, uint256 unitsPerRip, uint64 validUntil, bytes32 quoteRef) external onlyQuoter {
        Position storage p = _positions[id];
        if (p.batchId == 0 || block.timestamp >= p.expiry) revert InvalidPosition();
        if (p.seller != erodoro) revert Unauthorized();
        if (unitsPerRip == 0 || quoteRef == bytes32(0) || validUntil < block.timestamp || validUntil > block.timestamp + MAX_QUOTE_AGE || validUntil > p.expiry) revert InvalidTerms();
        p.unitsPerRip = unitsPerRip;
        p.quoteValidUntil = validUntil;
        p.quoteRef = quoteRef;
        emit QuoteSet(id, unitsPerRip, validUntil, quoteRef);
    }

    /// @notice Exactly 1 USDC leaves the buyer and real claim units arrive in
    ///         the same transaction. Selection is uniform over eligible house
    ///         rows, UP or DOWN. Seller listings are excluded: this call does
    ///         not bind to reviewed inventory, so it must not reach seller prices.
    function rip() external nonReentrant whenNotPaused returns (uint256 positionId, uint256 units) {
        uint256 batchId = activeBatchId;
        positionId = _selectPosition(batchId, msg.sender, purchaseNonce++);
        Position storage p = _positions[positionId];
        units = p.unitsPerRip;
        p.remainingUnits -= units;
        p.amountSold += RIP_PRICE;
        if (!hasBought[positionId][msg.sender]) {
            hasBought[positionId][msg.sender] = true;
            p.buyerCount += 1;
            _buyerPositions[msg.sender].push(positionId);
        }
        purchasedValue[msg.sender][positionId] += RIP_PRICE;
        purchasedUnits[msg.sender][positionId] += units;

        uint256 beforeBalance = usdc.balanceOf(p.seller);
        usdc.safeTransferFrom(msg.sender, p.seller, RIP_PRICE);
        if (usdc.balanceOf(p.seller) != beforeBalance + RIP_PRICE) revert PaymentShortfall();
        if (!IERC6909(p.claims).transfer(msg.sender, p.claimId, units)) revert ClaimTransferFailed();
        emit RipPurchased(msg.sender, batchId, positionId, p.claims, p.claimId, units, RIP_PRICE, p.quoteRef);
    }

    /// @dev The selection policy lives here so a later inventory-weighted or
    ///      verifiable random mechanism can replace it without touching fills.
    function _selectPosition(uint256 batchId, address buyer, uint256 nonce) internal view returns (uint256 positionId) {
        uint256[] storage ids = _batchPositions[batchId];
        uint256 eligible;
        for (uint256 i; i < ids.length; ++i) {
            if (_positions[ids[i]].seller == erodoro && _positions[ids[i]].seller != buyer && _eligible(_positions[ids[i]])) ++eligible;
        }
        if (eligible == 0) revert NoInventory();

        uint256 pick = uint256(keccak256(abi.encode(block.prevrandao, blockhash(block.number - 1), buyer, nonce))) % eligible;
        for (uint256 i; i < ids.length; ++i) {
            Position storage candidate = _positions[ids[i]];
            if (candidate.seller != erodoro || candidate.seller == buyer || !_eligible(candidate)) continue;
            if (pick == 0) { positionId = ids[i]; break; }
            --pick;
        }
    }

    /// @notice After expiry, unsold units go back to whoever supplied them.
    function returnExpiredInventory(uint256 id) external nonReentrant returns (uint256 units) {
        Position storage p = _positions[id];
        if (p.batchId == 0) revert InvalidPosition();
        if (msg.sender != erodoro && msg.sender != p.seller) revert Unauthorized();
        if (block.timestamp < p.expiry) revert TooEarly();
        units = p.remainingUnits;
        p.remainingUnits = 0;
        if (units > 0) {
            if (!IERC6909(p.claims).transfer(p.seller, p.claimId, units)) revert ClaimTransferFailed();
            emit InventoryReturned(id, units);
        }
    }

    // --- Seller listings -----------------------------------------------------

    /// @notice Lock `collateral` stock into the same series as house market
    ///         `templateId`, keep the P claim, and list every N unit at
    ///         `unitsPerRip` N units per $1. Buyers pay the seller directly.
    function lockAndList(uint256 templateId, uint256 collateral, uint256 unitsPerRip)
        external nonReentrant whenNotPaused returns (uint256 id, uint256 units)
    {
        Position storage t = _positions[templateId];
        if (t.batchId == 0 || t.batchId != activeBatchId || t.direction != Direction.UP || t.seller != erodoro) revert InvalidPosition();
        if (block.timestamp >= t.expiry) revert InvalidPosition();
        if (collateral == 0 || unitsPerRip == 0) revert InvalidTerms();
        if (_batchPositions[t.batchId].length >= MAX_BATCH_POSITIONS) revert InvalidBatch();

        uint256 received;
        (received, units) = _lockForSeller(t, collateral);
        if (units < unitsPerRip || units < t.unitsPerRip * MIN_LISTING_DOLLARS) revert InvalidTerms();
        id = _recordListing(t, units, unitsPerRip);
        emit PositionAdded(id, t.batchId, t.stock, Direction.UP, t.claimId, units, units);
        emit Listed(id, msg.sender, templateId, received, units);
    }

    /// @dev Splits the seller's stock in the template's series. N stays here as
    ///      inventory; P (same id, low bit cleared) goes straight to the seller.
    function _lockForSeller(Position storage t, uint256 collateral) internal returns (uint256 received, uint256 units) {
        uint256 seriesId = t.claimId & ~uint256(1);
        IERC20 stock = IERC20(t.stock);
        uint256 stockBefore = stock.balanceOf(address(this));
        stock.safeTransferFrom(msg.sender, address(this), collateral);
        received = stock.balanceOf(address(this)) - stockBefore;
        uint256 nBefore = vault.balanceOf(address(this), t.claimId);
        uint256 pBefore = vault.balanceOf(address(this), seriesId);
        stock.forceApprove(address(vault), received);
        vault.split(seriesId, received);
        units = vault.balanceOf(address(this), t.claimId) - nBefore;
        uint256 pUnits = vault.balanceOf(address(this), seriesId) - pBefore;
        if (!vault.transfer(msg.sender, seriesId, pUnits)) revert ClaimTransferFailed();
    }

    function _recordListing(Position storage t, uint256 units, uint256 unitsPerRip) internal returns (uint256 id) {
        id = nextPositionId++;
        Position storage p = _positions[id];
        p.batchId = t.batchId;
        p.stock = t.stock;
        p.claims = t.claims;
        p.claimId = t.claimId;
        p.direction = Direction.UP;
        p.spotAtCreation = t.spotAtCreation;
        p.strike = t.strike;
        p.priceDecimals = t.priceDecimals;
        p.expiry = t.expiry;
        p.totalInventoryUnits = units;
        p.remainingUnits = units;
        p.collateralSupplied = units;
        p.seller = msg.sender;
        _setListingPrice(id, p, unitsPerRip);
        _batchPositions[t.batchId].push(id);
        _sellerPositions[msg.sender].push(id);
    }

    /// @notice A seller reprices their own listing. In-flight selected buys
    ///         bound to the old price revert rather than fill at the new one.
    function setListingPrice(uint256 id, uint256 unitsPerRip) external {
        Position storage p = _positions[id];
        if (p.batchId == 0 || p.seller == erodoro || msg.sender != p.seller) revert Unauthorized();
        if (block.timestamp >= p.expiry) revert InvalidPosition();
        if (unitsPerRip == 0) revert InvalidTerms();
        _setListingPrice(id, p, unitsPerRip);
    }

    /// @notice A seller takes back unsold N at any time. With their P, the
    ///         vault's merge then returns the locked stock.
    function withdrawListing(uint256 id, uint256 units) external nonReentrant {
        Position storage p = _positions[id];
        if (p.batchId == 0 || p.seller == erodoro || msg.sender != p.seller) revert Unauthorized();
        if (units == 0 || units > p.remainingUnits) revert InvalidTerms();
        p.remainingUnits -= units;
        if (!IERC6909(p.claims).transfer(msg.sender, p.claimId, units)) revert ClaimTransferFailed();
        emit ListingWithdrawn(id, msg.sender, units);
    }

    /// @dev Seller prices stand until changed or expiry; each change gets a new
    ///      reference so buyers' reviewed quotes can bind to it.
    function _setListingPrice(uint256 id, Position storage p, uint256 unitsPerRip) internal {
        p.unitsPerRip = unitsPerRip;
        p.quoteValidUntil = p.expiry;
        p.quoteRef = keccak256(abi.encode(address(this), id, p.seller, unitsPerRip, ++listingNonce));
        emit QuoteSet(id, unitsPerRip, p.expiry, p.quoteRef);
    }

    /// @dev Blind buys (ripUp, ripPack) reach a seller listing only while the
    ///      house quote for that stock is live and the seller gives at least as
    ///      many units per $1. A stale house quote, for example over a weekend
    ///      when feeds stop, pauses blind sales of that stock entirely.
    function _blindEligible(Position storage p) internal view returns (bool) {
        if (!_eligible(p)) return false;
        if (p.seller == erodoro) return true;
        Position storage h = _positions[housePosition[p.batchId][p.stock]];
        return _eligible(h) && p.unitsPerRip >= h.unitsPerRip;
    }

    function _eligible(Position storage p) internal view returns (bool) {
        return p.batchId != 0 && block.timestamp < p.expiry && block.timestamp <= p.quoteValidUntil
            && p.unitsPerRip != 0 && p.remainingUnits >= p.unitsPerRip;
    }
}
