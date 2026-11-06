// SPDX-License-Identifier: Apache-2.0
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";

import {UmaFallbackSettlementOracle} from "../../src/oracle/UmaFallbackSettlementOracle.sol";
import {SettlementModel} from "../../src/oracle/SettlementModel.sol";
import {MockOptimisticOracleV2} from "../harness/MockOptimisticOracleV2.sol";
import {TestQuoteToken} from "../../src/periphery/TestQuoteToken.sol";

contract UmaFallbackSettlementOracleTest is Test {
    bytes32 constant IDENTIFIER = bytes32("ASSERT_TRUTH");
    bytes32 constant FEED_ID = bytes32("AAPLc/USD");
    uint64 constant MATURITY = 1_700_000_000;
    uint64 constant NOT_BEFORE = MATURITY + 2 days;
    uint256 constant CANDIDATE = 600e8;
    uint256 constant BOND = 100e18;
    uint64 constant LIVENESS = 2 hours;

    MockOptimisticOracleV2 oo;
    UmaFallbackSettlementOracle adapter;
    TestQuoteToken currency;

    function setUp() public {
        oo = new MockOptimisticOracleV2();
        currency = new TestQuoteToken();
        adapter = new UmaFallbackSettlementOracle(
            oo,
            address(currency),
            IDENTIFIER,
            BOND,
            LIVENESS,
            8,
            SettlementModel.RAW_SHARE,
            FEED_ID,
            "Resolve true only if the candidate is the AAPL raw-share price at maturity"
        );
        currency.mint(address(this), BOND * 10);
        currency.approve(address(adapter), type(uint256).max);
    }

    function _proposal()
        internal
        view
        returns (bytes32 requestId, uint64 oracleTimestamp, uint32 attempt, bytes memory ancillaryData)
    {
        requestId = adapter.requestIdFor(MATURITY, NOT_BEFORE);
        (,, oracleTimestamp, attempt, ancillaryData) = adapter.activeProposal(requestId);
    }

    function test_cannotProposeBeforeRecoveryDelay() public {
        bytes32 requestId = adapter.requestIdFor(MATURITY, NOT_BEFORE);
        vm.warp(NOT_BEFORE - 1);
        vm.expectRevert(UmaFallbackSettlementOracle.InvalidFallbackRequest.selector);
        adapter.proposePrice(requestId, MATURITY, NOT_BEFORE, CANDIDATE);
    }

    function test_proposalBindsBondLivenessAndHumanReadableAssertion() public {
        bytes32 requestId = adapter.requestIdFor(MATURITY, NOT_BEFORE);
        vm.warp(NOT_BEFORE);
        adapter.proposePrice(requestId, MATURITY, NOT_BEFORE, CANDIDATE);

        (, uint64 oracleTimestamp, uint32 attempt, bytes memory ancillaryData) = _proposal();
        bytes32 key = oo.keyFor(address(adapter), IDENTIFIER, oracleTimestamp, ancillaryData);
        (address recordedCurrency, uint256 bond, uint256 liveness, address proposer,, int256 proposedPrice,,) =
            oo.requests(key);

        assertEq(recordedCurrency, address(currency));
        assertEq(bond, BOND);
        assertEq(liveness, LIVENESS);
        assertEq(proposer, address(this));
        assertEq(proposedPrice, adapter.ASSERTION_TRUE());
        assertEq(attempt, 1);
        assertTrue(bytes(ancillaryData).length > 0);
    }

    function test_isBoundToOneFeedAndNamesItInTheQuestion() public {
        assertEq(adapter.configuredFeedId(), FEED_ID);
        bytes32 requestId = adapter.requestIdFor(MATURITY, NOT_BEFORE);
        vm.warp(NOT_BEFORE);
        adapter.proposePrice(requestId, MATURITY, NOT_BEFORE, CANDIDATE);
        (,,, bytes memory ancillaryData) = _proposal();
        assertTrue(vm.contains(string(ancillaryData), string.concat(", feedId:", vm.toString(FEED_ID))));
    }

    function test_rejectsAMissingFeed() public {
        vm.expectRevert(UmaFallbackSettlementOracle.InvalidFallbackConfiguration.selector);
        new UmaFallbackSettlementOracle(
            oo, address(currency), IDENTIFIER, BOND, LIVENESS, 8, SettlementModel.RAW_SHARE, bytes32(0), "rules"
        );
    }

    function test_disputeUsesTheCallerAsDisputer() public {
        bytes32 requestId = adapter.requestIdFor(MATURITY, NOT_BEFORE);
        vm.warp(NOT_BEFORE);
        adapter.proposePrice(requestId, MATURITY, NOT_BEFORE, CANDIDATE);
        (, uint64 oracleTimestamp,, bytes memory ancillaryData) = _proposal();

        address disputer = address(0xD15);
        currency.mint(disputer, BOND);
        vm.prank(disputer);
        currency.approve(address(adapter), BOND);
        vm.prank(disputer);
        adapter.disputePrice(requestId);

        bytes32 key = oo.keyFor(address(adapter), IDENTIFIER, oracleTimestamp, ancillaryData);
        (,,,, address recordedDisputer,,,) = oo.requests(key);
        assertEq(recordedDisputer, disputer);
    }

    function test_trueResolutionFinalizesTheCandidateAtMaturity() public {
        bytes32 requestId = adapter.requestIdFor(MATURITY, NOT_BEFORE);
        vm.warp(NOT_BEFORE);
        adapter.proposePrice(requestId, MATURITY, NOT_BEFORE, CANDIDATE);
        (, uint64 oracleTimestamp,, bytes memory ancillaryData) = _proposal();
        oo.resolve(address(adapter), IDENTIFIER, oracleTimestamp, ancillaryData, adapter.ASSERTION_TRUE());

        adapter.finalizeProposal(requestId);
        (uint256 price, uint8 decimals, uint64 priceTime, bool finalized) = adapter.finalizedPrice(requestId, "");
        assertEq(price, CANDIDATE);
        assertEq(decimals, 8);
        assertEq(priceTime, MATURITY);
        assertTrue(finalized);
    }

    function test_falseResolutionRejectsCandidateAndPermitsRetry() public {
        bytes32 requestId = adapter.requestIdFor(MATURITY, NOT_BEFORE);
        vm.warp(NOT_BEFORE);
        adapter.proposePrice(requestId, MATURITY, NOT_BEFORE, CANDIDATE);
        (, uint64 oracleTimestamp,, bytes memory ancillaryData) = _proposal();
        oo.resolve(address(adapter), IDENTIFIER, oracleTimestamp, ancillaryData, 0);

        adapter.finalizeProposal(requestId);
        (,,, bool finalized) = adapter.finalizedPrice(requestId, "");
        assertFalse(finalized);

        vm.warp(NOT_BEFORE + 1);
        adapter.proposePrice(requestId, MATURITY, NOT_BEFORE, CANDIDATE + 1);
        (,, uint32 attempt,) = _proposal();
        assertEq(attempt, 2);
    }

    function test_cannotFinalizeBeforeUmaHasAResult() public {
        bytes32 requestId = adapter.requestIdFor(MATURITY, NOT_BEFORE);
        vm.warp(NOT_BEFORE);
        adapter.proposePrice(requestId, MATURITY, NOT_BEFORE, CANDIDATE);

        vm.expectRevert(UmaFallbackSettlementOracle.ProposalNotResolvable.selector);
        adapter.finalizeProposal(requestId);
    }
}
