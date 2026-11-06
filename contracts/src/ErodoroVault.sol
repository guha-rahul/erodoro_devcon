// SPDX-License-Identifier: Apache-2.0
pragma solidity 0.8.28;

import {ERC6909TokenSupply} from "@openzeppelin/contracts/token/ERC6909/extensions/ERC6909TokenSupply.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";

import {IErodoroVault} from "./interfaces/IErodoroVault.sol";
import {IOracleAdapter} from "./oracle/IOracleAdapter.sol";
import {IFallbackSettlementOracle} from "./oracle/IFallbackSettlementOracle.sol";
import {SettlementModel} from "./oracle/SettlementModel.sol";
import {PayoutMath} from "./libraries/PayoutMath.sol";
import {StrikeMath} from "./libraries/StrikeMath.sol";
import {Errors} from "./libraries/Errors.sol";

/// @title ErodoroVault
/// @notice Tokenized-equity upside markets. Lock a B20 Asset, pick a strike and
///         an expiry, and receive two claims: `P`, a capped equity claim, and
///         `N`, the upside above the strike.
///
///         **This is not downside protection.** Below the entry price the `P`
///         holder takes the full fall in the collateral. Any interface that
///         implies otherwise is wrong.
///
/// @dev Ported from `programs/series/`. Two structural changes come from this
///      being one contract rather than a program with a vault account per
///      series, and both are load-bearing:
///
///      1. **Claims are ERC-6909 ids, not separate mints.** `P` is `seriesId`
///         and `N` is `seriesId | 1`, which is why `seriesId` has its low bit
///         cleared. Holders can still burn their own claims — ERC-6909 has no
///         opinion about that — so finding #1 stands unchanged: settlement
///         records a supply mismatch rather than gating on one.
///
///      2. **One address holds every series' collateral.** On Solana each
///         series owned its own token account, so an issuer seizure hit exactly
///         one series. Here a seizure hits the contract, which holds the
///         collateral of every series written against that token. The drain is
///         therefore socialised pro-rata across those series before §7's
///         within-series haircut applies — two nested floors, both in the
///         holders' favour at each step.
///
///         That is not a workaround. It is the accurate model: the issuer's
///         lever targets an address, not a series, so pretending the loss
///         belongs to one series would be the fiction. It does mean a series is
///         exposed to a seizure aimed at a sibling series over the same token,
///         and that belongs in the UI as a headline risk.
contract ErodoroVault is IErodoroVault, ERC6909TokenSupply, ReentrancyGuard {
    using SafeERC20 for IERC20;

    uint256 internal constant BPS_DENOMINATOR = 10_000;

    /// @dev `effectiveAt()` — ERC-8056 pending-schedule read. Absent pre-Cobalt.
    bytes4 internal constant EFFECTIVE_AT_SELECTOR = 0x97a4064f;
    /// @dev `multiplier()` — canonical B20 Asset name, present from Beryl.
    bytes4 internal constant MULTIPLIER_SELECTOR = 0x1b3ed722;

    mapping(uint256 seriesId => SeriesConfig) private _series;
    mapping(uint256 seriesId => Settlement) private _settlement;

    /// @notice Raw collateral this contract believes it holds for a series.
    mapping(uint256 seriesId => uint256) public lockedOf;
    /// @notice Raw collateral this contract believes it holds for a token,
    ///         summed across every series written against it.
    mapping(address collateral => uint256) public tokenLocked;

    struct CreateSeriesParams {
        address collateral;
        address oracle;
        address fallbackOracle;
        address feeRecipient;
        bytes32 feedId;
        bytes32 fallbackRequestId;
        SettlementModel settlementModel;
        uint256 strike;
        uint256 minSplitAmount;
        uint64 maturity;
        uint64 settlementDelay;
        uint64 maxPriceLag;
        uint64 fallbackDelay;
        uint32 maxConfBps;
        uint16 feeBps;
        uint8 priceDecimals;
        /// @dev `address(0)` opens the series with no admin at all — the whole
        ///      admin surface is dead from birth. The factory uses this for a
        ///      canonical series whose terms nobody should be able to touch.
        address admin;
    }

    // --- Identity ------------------------------------------------------------

    /// @notice Deterministic id for a series.
    /// @dev The creator is in the preimage. Finding #2 on Solana was that a PDA
    ///      seeded only on `(collateral, strike, maturity)` names one address
    ///      protocol-wide, so an attacker could watch for a factory creation,
    ///      front-run it, and occupy that address permanently for the price of
    ///      rent. Every creator gets their own id space instead. Creation stays
    ///      permissionless; the factory's registry decides what is canonical.
    ///
    ///      The low bit is cleared so `P` and `N` can be derived from the id
    ///      without a lookup: `P = seriesId`, `N = seriesId | 1`.
    function seriesIdFor(address creator, CreateSeriesParams memory p) public pure returns (uint256) {
        return uint256(
            keccak256(
            abi.encode(
            creator,
            p.collateral,
            p.oracle,
            p.fallbackOracle,
            p.feedId,
            p.fallbackRequestId,
            p.settlementModel,
            p.strike,
            p.maturity,
            p.settlementDelay,
            p.maxPriceLag,
            p.fallbackDelay,
            p.priceDecimals
        )
        )
        ) & ~uint256(1);
    }

    function pId(uint256 seriesId) public pure returns (uint256) {
        return seriesId & ~uint256(1);
    }

    function nId(uint256 seriesId) public pure returns (uint256) {
        return seriesId | 1;
    }

    function seriesConfig(uint256 seriesId) external view returns (SeriesConfig memory) {
        return _series[seriesId];
    }

    function settlementOf(uint256 seriesId) external view returns (Settlement memory) {
        return _settlement[seriesId];
    }

    // --- Creation ------------------------------------------------------------

    /// @notice Open a series. Permissionless by design.
    function createSeries(CreateSeriesParams calldata p) external returns (uint256 seriesId) {
        if (p.collateral == address(0) || p.oracle == address(0)) revert Errors.InvalidParams();
        if (p.strike == 0) revert Errors.InvalidStrike();
        if (p.maturity <= block.timestamp) revert Errors.InvalidMaturity();
        if (p.maxPriceLag == 0) revert Errors.InvalidParams();
        if (p.feeBps > BPS_DENOMINATOR) revert Errors.InvalidParams();
        if (p.priceDecimals > PayoutMath.MAX_DECIMALS) revert Errors.InvalidDecimals();
        if (IOracleAdapter(p.oracle).settlementModel() != p.settlementModel) revert Errors.OraclePairInvalid();
        bool hasFallback = p.fallbackOracle != address(0);
        if (hasFallback && (p.fallbackRequestId == bytes32(0) || p.fallbackDelay == 0)) revert Errors.InvalidParams();
        if (!hasFallback && (p.fallbackRequestId != bytes32(0) || p.fallbackDelay != 0)) revert Errors.InvalidParams();
        if (hasFallback && IFallbackSettlementOracle(p.fallbackOracle).settlementModel() != p.settlementModel) {
            revert Errors.OraclePairInvalid();
        }

        seriesId = seriesIdFor(msg.sender, p);
        if (_series[seriesId].exists) revert Errors.SeriesExists();

        uint256 multiplier = _readMultiplier(p.collateral);
        StrikeMath.validateMultiplier(multiplier);

        // Refuse to write a series across a known corporate action. Only
        // enforceable where the asset exposes the ERC-8056 pending schedule;
        // `_pendingEffectiveAt` returns 0 where it does not, which makes this a
        // documented no-op rather than a silent pass. See docs/known-limitations.md.
        StrikeMath.requireNoScheduledChange(
            _pendingEffectiveAt(p.collateral),
            block.timestamp,
            uint256(p.maturity) + _max(p.settlementDelay, p.maxPriceLag) + p.fallbackDelay
        );

        _series[seriesId] = SeriesConfig({
            creator: msg.sender,
            collateral: p.collateral,
            oracle: p.oracle,
            fallbackOracle: p.fallbackOracle,
            admin: p.admin,
            feeRecipient: p.feeRecipient,
            feedId: p.feedId,
            fallbackRequestId: p.fallbackRequestId,
            settlementModel: p.settlementModel,
            strike: p.strike,
            multiplierAtCreation: multiplier,
            minSplitAmount: p.minSplitAmount,
            maturity: p.maturity,
            settlementDelay: p.settlementDelay,
            maxPriceLag: p.maxPriceLag,
            fallbackDelay: p.fallbackDelay,
            maxConfBps: p.maxConfBps,
            feeBps: p.feeBps,
            collateralDecimals: IERC20Metadata(p.collateral).decimals(),
            priceDecimals: p.priceDecimals,
            splitsPaused: false,
            exists: true
        });

        emit SeriesCreated(seriesId, msg.sender, p.collateral, p.strike, p.maturity, multiplier, p.settlementModel);
    }

    // --- Split / merge -------------------------------------------------------

    /// @notice Lock `amount` raw collateral units and mint equal P and N.
    function split(uint256 seriesId, uint256 amount) external nonReentrant {
        SeriesConfig storage s = _requireSeries(seriesId);
        if (s.splitsPaused) revert Errors.SeriesPaused();
        if (block.timestamp >= s.maturity) revert Errors.SeriesClosed();
        if (amount == 0) revert Errors.InvalidAmount();
        if (amount < s.minSplitAmount) revert Errors.AmountTooSmall();

        // Measure what actually arrived. A transfer policy or a future fee-on-
        // transfer configuration can deliver less than `amount`, and minting
        // claims against collateral that never landed is how a vault goes short.
        uint256 before = IERC20(s.collateral).balanceOf(address(this));
        IERC20(s.collateral).safeTransferFrom(msg.sender, address(this), amount);
        uint256 received = IERC20(s.collateral).balanceOf(address(this)) - before;
        if (received == 0) revert Errors.InvalidAmount();

        uint256 fee = s.feeBps == 0 ? 0 : PayoutMath.mulDivFloor(received, s.feeBps, BPS_DENOMINATOR);
        uint256 net = received - fee;
        if (net == 0) revert Errors.AmountTooSmall();

        if (fee > 0) IERC20(s.collateral).safeTransfer(s.feeRecipient, fee);

        lockedOf[seriesId] += net;
        tokenLocked[s.collateral] += net;

        _mint(msg.sender, pId(seriesId), net);
        _mint(msg.sender, nId(seriesId), net);

        emit Split(seriesId, msg.sender, net, fee);
    }

    /// @notice Burn equal P and N and take the collateral back.
    /// @dev Deliberately works while splits are paused: a pause must never trap
    ///      collateral behind existing claims. Closed at maturity, like `split`.
    function merge(uint256 seriesId, uint256 amount) external nonReentrant {
        SeriesConfig storage s = _requireSeries(seriesId);
        if (block.timestamp >= s.maturity) revert Errors.SeriesClosed();
        if (amount == 0) revert Errors.InvalidAmount();
        if (amount > lockedOf[seriesId]) revert Errors.InsufficientCollateral();

        _burn(msg.sender, pId(seriesId), amount);
        _burn(msg.sender, nId(seriesId), amount);

        lockedOf[seriesId] -= amount;
        tokenLocked[s.collateral] -= amount;

        IERC20(s.collateral).safeTransfer(msg.sender, amount);
        emit Merge(seriesId, msg.sender, amount);
    }

    // --- Settlement ----------------------------------------------------------

    /// @notice Freeze the payoff against an oracle print. Permissionless, once.
    ///
    /// @dev Payable: Pyth charges to verify an update. Excess is refunded by the
    ///      adapter, so overpaying is safe.
    ///
    ///      The publish window is handed to the oracle as an absolute range
    ///      rather than reconstructed from a delay and two staleness bounds.
    ///      That is what dissolves finding #4: there is no longer an inequality
    ///      between three independently-validated parameters that can be
    ///      satisfied at creation and unsatisfiable at settlement. A window that
    ///      admits no print reverts here and can be retried, rather than
    ///      stranding the series.
    function settle(uint256 seriesId, bytes[] calldata updateData) external payable nonReentrant {
        SeriesConfig storage s = _requireSeries(seriesId);
        Settlement storage st = _settlement[seriesId];

        if (st.settled) revert Errors.AlreadySettled();
        if (block.timestamp < s.maturity) revert Errors.SeriesNotMatured();
        if (block.timestamp < uint256(s.maturity) + s.settlementDelay) revert Errors.SettlementTooEarly();
        // The model was checked at creation. Re-check it here so a price can
        // never be run through the wrong strike-adjustment path — the one bug
        // that would count a corporate action either twice or not at all.
        if (IOracleAdapter(s.oracle).settlementModel() != s.settlementModel) {
            revert Errors.OraclePairInvalid();
        }

        SettleLocals memory L = _quote(seriesId, s, updateData);
        _record(seriesId, st, L);
    }

    /// @notice Settle from the delayed dispute process when the primary path failed.
    function settleFallback(uint256 seriesId, bytes calldata resolutionData) external nonReentrant {
        SeriesConfig storage s = _requireSeries(seriesId);
        Settlement storage st = _settlement[seriesId];

        if (st.settled) revert Errors.AlreadySettled();
        if (s.fallbackOracle == address(0)) revert Errors.InvalidOracle();
        if (IFallbackSettlementOracle(s.fallbackOracle).settlementModel() != s.settlementModel) {
            revert Errors.OraclePairInvalid();
        }
        uint256 opensAt = uint256(s.maturity) + _max(s.settlementDelay, s.maxPriceLag) + s.fallbackDelay;
        if (block.timestamp < opensAt) revert Errors.SettlementTooEarly();

        (uint256 rawPrice, uint8 quoteDecimals, uint64 priceTs, bool finalized) =
            IFallbackSettlementOracle(s.fallbackOracle).finalizedPrice(s.fallbackRequestId, resolutionData);
        if (!finalized) revert Errors.NotSettled();
        if (priceTs != s.maturity) revert Errors.OraclePriceStale();

        SettleLocals memory L = _quoteValue(seriesId, s, rawPrice, quoteDecimals, priceTs);
        st.fallbackUsed = true;
        _record(seriesId, st, L);
        emit FallbackSettled(seriesId, s.fallbackOracle, s.fallbackRequestId);
    }

    /// @dev Intermediates for `settle`, held in memory so no single frame is
    ///      deep enough to exhaust the stack.
    struct SettleLocals {
        uint256 price;
        uint256 effStrike;
        uint256 mSettlement;
        uint256 collateral;
        uint256 pPool;
        uint256 nPool;
        uint256 pSupply;
        uint256 nSupply;
        uint64 priceTs;
    }

    /// @dev Verify a price, resolve the multiplier that was in force when it was
    ///      printed, adjust the strike, and partition the collateral.
    function _quote(uint256 seriesId, SeriesConfig storage s, bytes[] calldata updateData)
        internal
        returns (SettleLocals memory L)
    {
        uint8 quoteDecimals;
        uint256 rawPrice;
        (rawPrice, quoteDecimals, L.priceTs) = IOracleAdapter(s.oracle).settlementPrice{value: msg.value}(
            s.feedId, s.maturity, s.maturity + s.maxPriceLag, s.maxConfBps, updateData
        );

        return _quoteValue(seriesId, s, rawPrice, quoteDecimals, L.priceTs);
    }

    function _quoteValue(
        uint256 seriesId,
        SeriesConfig storage s,
        uint256 rawPrice,
        uint8 quoteDecimals,
        uint64 priceTs
    ) internal view returns (SettleLocals memory L) {
        uint256 currentMultiplier = _readMultiplier(s.collateral);
        uint256 pendingAt = _pendingEffectiveAt(s.collateral);
        L.priceTs = priceTs;

        // Which multiplier was in force when that price was printed. Reverts if
        // a flip landed strictly inside the window — see StrikeMath.
        L.mSettlement = StrikeMath.resolveMultiplier(currentMultiplier, pendingAt, L.priceTs, block.timestamp);

        L.price = PayoutMath.normalizeDecimals(rawPrice, quoteDecimals, s.priceDecimals);
        if (L.price == 0) revert Errors.OraclePriceInvalid();

        // A raw-share price does not include the multiplier, so the strike moves
        // by the same ratio. A total-return price already includes the
        // multiplier and must keep the stored strike. Applying both adjustments
        // counts the same corporate action twice.
        L.effStrike = s.settlementModel == SettlementModel.RAW_SHARE
            ? StrikeMath.effectiveStrike(s.strike, s.multiplierAtCreation, L.mSettlement)
            : s.strike;

        L.collateral = _seriesShare(seriesId, s.collateral);
        (L.pPool, L.nPool) = PayoutMath.computePools(L.collateral, L.effStrike, L.price);

        L.pSupply = totalSupply(pId(seriesId));
        L.nSupply = totalSupply(nId(seriesId));
    }

    /// @dev Freeze the result. Health is recorded, never gated on — see
    ///      SECURITY.md finding #1.
    function _record(uint256 seriesId, Settlement storage st, SettleLocals memory L) internal {
        st.price = L.price;
        st.effectiveStrike = L.effStrike;
        st.multiplierAtSettlement = L.mSettlement;
        st.collateralAtSettlement = L.collateral;
        st.pSupplyAtSettlement = L.pSupply;
        st.nSupplyAtSettlement = L.nSupply;
        st.pPool = L.pPool;
        st.nPool = L.nPool;
        st.priceTs = L.priceTs;
        st.settledTs = uint64(block.timestamp);
        st.settled = true;

        st.supplyMismatch = L.pSupply != L.nSupply;
        st.underCollateralized = L.collateral < (L.pSupply > L.nSupply ? L.pSupply : L.nSupply);

        emit Settled(seriesId, L.price, L.effStrike, L.pPool, L.nPool, L.priceTs);
        emit SettlementHealth(seriesId, st.supplyMismatch, st.underCollateralized);
    }

    // --- Redemption ----------------------------------------------------------

    /// @notice Burn a claim and take its share of the frozen pool.
    function redeem(uint256 seriesId, bool isP, uint256 amount) external nonReentrant returns (uint256 paid) {
        SeriesConfig storage s = _requireSeries(seriesId);
        Settlement storage st = _settlement[seriesId];
        if (!st.settled) revert Errors.NotSettled();
        if (amount == 0) revert Errors.InvalidAmount();

        _burn(msg.sender, isP ? pId(seriesId) : nId(seriesId), amount);

        uint256 quoted = PayoutMath.computeRedeem(
            amount, isP ? st.pPool : st.nPool, isP ? st.pSupplyAtSettlement : st.nSupplyAtSettlement
        );

        // Outstanding is the *quoted* claim still owed across both sides, not
        // the original pools. That is what keeps the ratio stable as redemptions
        // proceed, so a holder arriving late sees the same haircut as one
        // arriving early instead of finding an empty vault.
        uint256 outstanding = (st.pPool - st.pQuoted) + (st.nPool - st.nQuoted);
        uint256 available = _seriesShare(seriesId, s.collateral);

        paid = PayoutMath.applyShortfall(quoted, available, outstanding);
        if (paid > quoted) revert Errors.MathOverflow();

        if (available < outstanding) {
            st.shortfallObserved = true;
            emit ShortfallObserved(seriesId, available, outstanding);
        }

        if (isP) {
            st.pQuoted += quoted;
            st.pPaid += paid;
        } else {
            st.nQuoted += quoted;
            st.nPaid += paid;
        }

        _consumeBelieved(seriesId, s.collateral, paid);
        if (paid > 0) IERC20(s.collateral).safeTransfer(msg.sender, paid);

        emit Redeemed(seriesId, msg.sender, isP, amount, quoted, paid);
    }

    // --- Admin (minimal, renounce-only) --------------------------------------

    function pauseSplits(uint256 seriesId) external {
        SeriesConfig storage s = _requireAdmin(seriesId);
        s.splitsPaused = true;
        emit SplitsPaused(seriesId);
    }

    function unpauseSplits(uint256 seriesId) external {
        SeriesConfig storage s = _requireAdmin(seriesId);
        s.splitsPaused = false;
        emit SplitsUnpaused(seriesId);
    }

    /// @notice Give up the admin key permanently.
    /// @dev The cost is that residual dust can never be swept — it stays in the
    ///      vault forever. That is the right direction for a trade of
    ///      convenience against trust, and it is why renouncing is offered
    ///      rather than forced.
    function renounceAdmin(uint256 seriesId) external {
        SeriesConfig storage s = _requireAdmin(seriesId);
        s.admin = address(0);
        emit AdminRenounced(seriesId);
    }

    /// @notice Sweep whatever is left once both claim supplies are zero.
    /// @dev A holder who burns their claim without redeeming forfeits their
    ///      collateral to the fee recipient. That is intended, but a UI must not
    ///      make burning easy to do by accident.
    function sweepDust(uint256 seriesId) external nonReentrant {
        SeriesConfig storage s = _requireAdmin(seriesId);
        if (totalSupply(pId(seriesId)) != 0 || totalSupply(nId(seriesId)) != 0) {
            revert Errors.DustSweepTooEarly();
        }
        uint256 amount = _seriesShare(seriesId, s.collateral);
        uint256 believed = lockedOf[seriesId];
        lockedOf[seriesId] = 0;
        tokenLocked[s.collateral] -= believed;
        if (amount > 0) IERC20(s.collateral).safeTransfer(s.feeRecipient, amount);
        emit DustSwept(seriesId, s.feeRecipient, amount);
    }

    // --- Internals -----------------------------------------------------------

    function _requireSeries(uint256 seriesId) internal view returns (SeriesConfig storage s) {
        s = _series[seriesId];
        if (!s.exists) revert Errors.SeriesNotFound();
    }

    function _requireAdmin(uint256 seriesId) internal view returns (SeriesConfig storage s) {
        s = _requireSeries(seriesId);
        // A renounced admin is the zero address, which no signer can match.
        if (s.admin == address(0) || msg.sender != s.admin) revert Errors.Unauthorized();
    }

    /// @notice Retire the *believed* collateral a payout consumed.
    ///
    /// @dev Decrementing `lockedOf` by `paid` would be wrong under a shortfall.
    ///      A series whose collateral was partly seized is paid only its share
    ///      `f = actual / tokenLocked` of what it believes it holds, so paying
    ///      `paid` discharges `paid / f` of that belief. Decrementing by the raw
    ///      `paid` leaves the difference behind as a phantom balance which never
    ///      pays out but stays in `tokenLocked` forever — permanently diluting
    ///      every *other* series written against the same token.
    ///
    ///      Scaling by `tokenLocked / actual` keeps `f` invariant across
    ///      redemptions, so a series that redeems in full lands at exactly zero
    ///      and its siblings' shares are untouched by its exit. The ceiling is
    ///      the safe direction: it can only retire belief faster, never leave a
    ///      residue that over-states what the contract holds.
    ///
    ///      Must be called before the transfer, while `actual` still includes
    ///      the amount about to leave.
    function _consumeBelieved(uint256 seriesId, address collateral, uint256 paid) internal {
        uint256 believed = lockedOf[seriesId];
        if (believed == 0) return;

        uint256 total = tokenLocked[collateral];
        uint256 actual = IERC20(collateral).balanceOf(address(this));

        uint256 consumed;
        if (paid == 0) {
            // Nothing was payable, so the vault is empty for this token. The
            // belief is unrecoverable; retire it rather than leave it to dilute.
            consumed = actual == 0 ? believed : 0;
        } else if (actual >= total || actual == 0) {
            consumed = paid;
        } else {
            consumed = PayoutMath.mulDivCeil(paid, total, actual);
        }

        if (consumed > believed) consumed = believed;
        lockedOf[seriesId] = believed - consumed;
        tokenLocked[collateral] = total - consumed;
    }

    /// @notice This series' attributable share of the collateral actually held.
    ///
    /// @dev Both floors favour the holders. The share is capped at what the
    ///      series believes it locked so that a donation to the contract cannot
    ///      inflate one series' pool at another's expense.
    function _seriesShare(uint256 seriesId, address collateral) internal view returns (uint256) {
        uint256 believed = lockedOf[seriesId];
        if (believed == 0) return 0;
        uint256 total = tokenLocked[collateral];
        if (total == 0) return 0;
        uint256 actual = IERC20(collateral).balanceOf(address(this));
        if (actual >= total) return believed;
        uint256 share = PayoutMath.mulDivFloor(actual, believed, total);
        return share < believed ? share : believed;
    }

    /// @dev `multiplier()` is present from Beryl onward. A collateral token that
    ///      does not answer it is not a B20 Asset and cannot be settled against.
    function _readMultiplier(address collateral) internal view returns (uint256) {
        (bool ok, bytes memory data) = collateral.staticcall(abi.encodeWithSelector(MULTIPLIER_SELECTOR));
        if (!ok || data.length < 32) revert Errors.InvalidCollateral();
        return abi.decode(data, (uint256));
    }

    /// @dev `effectiveAt()` is a Cobalt addition. On a chain whose B20 Asset
    ///      predates it the call reverts, and 0 means "no schedule readable" —
    ///      which callers treat as the gate being unavailable, not as a pass.
    function _pendingEffectiveAt(address collateral) internal view returns (uint256) {
        (bool ok, bytes memory data) = collateral.staticcall(abi.encodeWithSelector(EFFECTIVE_AT_SELECTOR));
        if (!ok || data.length < 32) return 0;
        return abi.decode(data, (uint256));
    }

    function _max(uint64 a, uint64 b) internal pure returns (uint64) {
        return a > b ? a : b;
    }
}
