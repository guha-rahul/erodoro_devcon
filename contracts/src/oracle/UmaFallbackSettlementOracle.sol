// SPDX-License-Identifier: Apache-2.0
pragma solidity 0.8.28;

import {Strings} from "@openzeppelin/contracts/utils/Strings.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

import {IFallbackSettlementOracle} from "./IFallbackSettlementOracle.sol";
import {IOptimisticOracleV2} from "./IOptimisticOracleV2.sol";
import {SettlementModel} from "./SettlementModel.sol";
import {PayoutMath} from "../libraries/PayoutMath.sol";
import {Errors} from "../libraries/Errors.sol";

/// @notice A delayed, bonded settlement-price assertion through UMA OOv2.
/// @dev UMA resolves whether the human-readable price assertion is true. The
///      asserted candidate becomes Erodoro's price only after a true result.
contract UmaFallbackSettlementOracle is IFallbackSettlementOracle {
    using Strings for uint256;
    using SafeERC20 for IERC20;

    int256 public constant ASSERTION_TRUE = 1e18;

    struct Proposal {
        uint256 candidatePrice;
        uint64 maturity;
        uint64 oracleTimestamp;
        uint32 attempt;
        uint256 totalBond;
        bytes ancillaryData;
    }

    struct Result {
        uint256 price;
        uint64 priceTime;
        bool finalized;
    }

    IOptimisticOracleV2 public immutable optimisticOracle;
    address public immutable bondCurrency;
    bytes32 public immutable identifier;
    uint256 public immutable bond;
    uint64 public immutable liveness;
    uint8 public immutable priceDecimals;
    bytes32 public immutable override configuredFeedId;
    SettlementModel public immutable override settlementModel;
    string public resolutionRules;

    mapping(bytes32 requestId => Proposal) private _proposals;
    mapping(bytes32 requestId => Result) private _results;
    mapping(bytes32 requestId => uint32) public attempts;

    event PriceProposed(
        bytes32 indexed requestId,
        uint32 indexed attempt,
        address indexed proposer,
        uint256 candidatePrice,
        uint64 maturity,
        uint64 oracleTimestamp
    );
    event PriceDisputed(bytes32 indexed requestId, uint32 indexed attempt, address indexed disputer);
    event PriceRejected(bytes32 indexed requestId, uint32 indexed attempt);
    event PriceFinalized(bytes32 indexed requestId, uint32 indexed attempt, uint256 price, uint64 priceTime);

    error InvalidFallbackConfiguration();
    error InvalidFallbackRequest();
    error ProposalAlreadyActive();
    error ProposalNotActive();
    error ProposalNotResolvable();

    constructor(
        IOptimisticOracleV2 optimisticOracle_,
        address bondCurrency_,
        bytes32 identifier_,
        uint256 bond_,
        uint64 liveness_,
        uint8 priceDecimals_,
        SettlementModel model_,
        bytes32 configuredFeedId_,
        string memory resolutionRules_
    ) {
        if (
            address(optimisticOracle_) == address(0) || bondCurrency_ == address(0) || identifier_ == bytes32(0)
                || bond_ == 0 || liveness_ == 0 || priceDecimals_ > PayoutMath.MAX_DECIMALS
                || configuredFeedId_ == bytes32(0) || bytes(resolutionRules_).length == 0
        ) revert InvalidFallbackConfiguration();

        optimisticOracle = optimisticOracle_;
        bondCurrency = bondCurrency_;
        identifier = identifier_;
        bond = bond_;
        liveness = liveness_;
        priceDecimals = priceDecimals_;
        settlementModel = model_;
        configuredFeedId = configuredFeedId_;
        resolutionRules = resolutionRules_;
    }

    function requestIdFor(uint64 maturity, uint64 notBefore) public view override returns (bytes32) {
        return keccak256(abi.encode(address(this), maturity, notBefore));
    }

    function proposePrice(bytes32 requestId, uint64 maturity, uint64 notBefore, uint256 candidatePrice) external {
        if (
            requestId != requestIdFor(maturity, notBefore) || block.timestamp < notBefore || candidatePrice == 0
                || block.timestamp > type(uint64).max
        ) revert InvalidFallbackRequest();
        if (_results[requestId].finalized || _proposals[requestId].oracleTimestamp != 0) {
            revert ProposalAlreadyActive();
        }

        uint32 attempt = attempts[requestId] + 1;
        attempts[requestId] = attempt;
        uint64 oracleTimestamp = uint64(block.timestamp);
        bytes memory ancillaryData = _ancillaryData(requestId, maturity, candidatePrice, attempt);

        optimisticOracle.requestPrice(identifier, oracleTimestamp, ancillaryData, bondCurrency, 0);
        uint256 totalBond = optimisticOracle.setBond(identifier, oracleTimestamp, ancillaryData, bond);
        optimisticOracle.setCustomLiveness(identifier, oracleTimestamp, ancillaryData, liveness);
        _proposals[requestId] = Proposal({
            candidatePrice: candidatePrice,
            maturity: maturity,
            oracleTimestamp: oracleTimestamp,
            attempt: attempt,
            totalBond: totalBond,
            ancillaryData: ancillaryData
        });

        IERC20(bondCurrency).safeTransferFrom(msg.sender, address(this), totalBond);
        IERC20(bondCurrency).forceApprove(address(optimisticOracle), totalBond);
        optimisticOracle.proposePriceFor(
            msg.sender, address(this), identifier, oracleTimestamp, ancillaryData, ASSERTION_TRUE
        );

        emit PriceProposed(requestId, attempt, msg.sender, candidatePrice, maturity, oracleTimestamp);
    }

    function disputePrice(bytes32 requestId) external {
        Proposal storage proposal = _proposals[requestId];
        if (proposal.oracleTimestamp == 0) revert ProposalNotActive();

        IERC20(bondCurrency).safeTransferFrom(msg.sender, address(this), proposal.totalBond);
        IERC20(bondCurrency).forceApprove(address(optimisticOracle), proposal.totalBond);
        optimisticOracle.disputePriceFor(
            msg.sender, address(this), identifier, proposal.oracleTimestamp, proposal.ancillaryData
        );
        emit PriceDisputed(requestId, proposal.attempt, msg.sender);
    }

    function finalizeProposal(bytes32 requestId) external {
        Proposal storage proposal = _proposals[requestId];
        if (proposal.oracleTimestamp == 0) revert ProposalNotActive();
        if (!optimisticOracle.hasPrice(address(this), identifier, proposal.oracleTimestamp, proposal.ancillaryData)) {
            revert ProposalNotResolvable();
        }

        int256 resolved =
            optimisticOracle.settleAndGetPrice(identifier, proposal.oracleTimestamp, proposal.ancillaryData);
        uint32 attempt = proposal.attempt;
        if (resolved != ASSERTION_TRUE) {
            delete _proposals[requestId];
            emit PriceRejected(requestId, attempt);
            return;
        }

        _results[requestId] = Result({price: proposal.candidatePrice, priceTime: proposal.maturity, finalized: true});
        uint256 price = proposal.candidatePrice;
        uint64 priceTime = proposal.maturity;
        delete _proposals[requestId];
        emit PriceFinalized(requestId, attempt, price, priceTime);
    }

    function finalizedPrice(bytes32 requestId, bytes calldata resolutionData)
        external
        view
        returns (uint256 price, uint8 decimals, uint64 priceTime, bool finalized)
    {
        if (resolutionData.length != 0) revert Errors.InvalidParams();
        Result memory result = _results[requestId];
        return (result.price, priceDecimals, result.priceTime, result.finalized);
    }

    function activeProposal(bytes32 requestId)
        external
        view
        returns (
            uint256 candidatePrice,
            uint64 maturity,
            uint64 oracleTimestamp,
            uint32 attempt,
            bytes memory ancillaryData
        )
    {
        Proposal storage proposal = _proposals[requestId];
        return (
            proposal.candidatePrice,
            proposal.maturity,
            proposal.oracleTimestamp,
            proposal.attempt,
            proposal.ancillaryData
        );
    }

    function _ancillaryData(bytes32 requestId, uint64 maturity, uint256 candidatePrice, uint32 attempt)
        internal
        view
        returns (bytes memory)
    {
        return bytes(
            string.concat(
                resolutionRules,
                ", feedId:",
                uint256(configuredFeedId).toHexString(32),
                ", requestId:",
                uint256(requestId).toHexString(32),
                ", maturity:",
                uint256(maturity).toString(),
                ", candidatePrice:",
                candidatePrice.toString(),
                ", priceDecimals:",
                uint256(priceDecimals).toString(),
                ", attempt:",
                uint256(attempt).toString()
            )
        );
    }
}
