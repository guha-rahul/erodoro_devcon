// SPDX-License-Identifier: Apache-2.0
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

import {CoinbaseFeedStatus} from "../../src/oracle/CoinbaseFeedStatus.sol";
import {ICoinbaseOracleRegistry} from "../../src/oracle/ICoinbaseOracleRegistry.sol";
import {IOptimisticOracleV2} from "../../src/oracle/IOptimisticOracleV2.sol";
import {SettlementModel} from "../../src/oracle/SettlementModel.sol";
import {UmaFallbackSettlementOracle} from "../../src/oracle/UmaFallbackSettlementOracle.sol";

interface IUmaAddressWhitelist {
    function isOnWhitelist(address account) external view returns (bool);
}

interface IUmaLiveness {
    function defaultLiveness() external view returns (uint256);
}

contract CoinbaseRegistryBaseForkTest is Test {
    uint256 constant BASE_CHAIN_ID = 8453;
    address constant AAPLC = 0xb200000000000000000000C2e324d24d7eEcd1fb;
    ICoinbaseOracleRegistry constant REGISTRY = ICoinbaseOracleRegistry(0x3f3E8cf41cdd3b1D118c16471aB0113DfDDd5CaD);
    bytes32 constant FEED_ID = keccak256("Coinbase AAPL total return");

    bool configured;

    function setUp() public {
        string memory rpc = vm.envOr("BASE_RPC_URL", string(""));
        if (bytes(rpc).length == 0) return;
        vm.createSelectFork(rpc);
        assertEq(block.chainid, BASE_CHAIN_ID);
        configured = true;
    }

    function test_liveRegistryReportsAaplOperational() public {
        if (!configured) vm.skip(true);

        CoinbaseFeedStatus status = new CoinbaseFeedStatus(REGISTRY, AAPLC, FEED_ID);
        (uint256 multiplier, bool paused) = status.oracleParams();
        assertGt(multiplier, 0);
        assertFalse(paused);
        assertTrue(status.isOperational(FEED_ID));
    }
}

contract UmaBaseSepoliaForkTest is Test {
    uint256 constant BASE_SEPOLIA_CHAIN_ID = 84532;
    IOptimisticOracleV2 constant OO = IOptimisticOracleV2(0x99EC530a761E68a377593888D9504002Bd191717);
    IUmaAddressWhitelist constant CURRENCY_WHITELIST = IUmaAddressWhitelist(0xF2D5614BD8D6246AACa5a6841aCfCA210B0CbC19);
    address constant BOND_CURRENCY = 0x7E6d9618Ba8a87421609352d6e711958A97e2512;
    bytes32 constant IDENTIFIER = bytes32("ASSERT_TRUTH");
    uint256 constant BOND = 100e18;

    bool configured;

    function setUp() public {
        string memory rpc = vm.envOr("BASE_SEPOLIA_RPC_URL", string(""));
        if (bytes(rpc).length == 0) return;
        vm.createSelectFork(rpc);
        assertEq(block.chainid, BASE_SEPOLIA_CHAIN_ID);
        configured = true;
    }

    function test_liveUndisputedProposalFinalizes() public {
        if (!configured) vm.skip(true);
        uint64 liveness = uint64(IUmaLiveness(address(OO)).defaultLiveness());
        assertEq(liveness, 2 hours);
        assertTrue(CURRENCY_WHITELIST.isOnWhitelist(BOND_CURRENCY));

        UmaFallbackSettlementOracle adapter = _adapter(liveness);
        deal(BOND_CURRENCY, address(this), BOND * 2);
        IERC20(BOND_CURRENCY).approve(address(adapter), type(uint256).max);
        assertEq(IERC20(BOND_CURRENCY).allowance(address(this), address(adapter)), type(uint256).max);

        uint64 maturity = uint64(block.timestamp - 1 days);
        uint64 notBefore = uint64(block.timestamp);
        bytes32 requestId = adapter.requestIdFor(maturity, notBefore);
        adapter.proposePrice(requestId, maturity, notBefore, 600e8);

        vm.warp(block.timestamp + liveness + 1);
        adapter.finalizeProposal(requestId);
        (uint256 price, uint8 decimals, uint64 priceTime, bool finalized) = adapter.finalizedPrice(requestId, "");
        assertEq(price, 600e8);
        assertEq(decimals, 8);
        assertEq(priceTime, maturity);
        assertTrue(finalized);
    }

    function test_liveDisputeCallPostsTheDisputerBond() public {
        if (!configured) vm.skip(true);
        uint64 liveness = uint64(IUmaLiveness(address(OO)).defaultLiveness());
        UmaFallbackSettlementOracle adapter = _adapter(liveness);
        deal(BOND_CURRENCY, address(this), BOND * 3);
        IERC20(BOND_CURRENCY).approve(address(adapter), type(uint256).max);
        assertEq(IERC20(BOND_CURRENCY).allowance(address(this), address(adapter)), type(uint256).max);

        uint64 maturity = uint64(block.timestamp - 1 days);
        uint64 notBefore = uint64(block.timestamp);
        bytes32 requestId = adapter.requestIdFor(maturity, notBefore);
        adapter.proposePrice(requestId, maturity, notBefore, 600e8);

        uint256 before = IERC20(BOND_CURRENCY).balanceOf(address(this));
        adapter.disputePrice(requestId);
        assertLt(IERC20(BOND_CURRENCY).balanceOf(address(this)), before);
    }

    function _adapter(uint64 liveness) internal returns (UmaFallbackSettlementOracle) {
        return new UmaFallbackSettlementOracle(
            OO,
            BOND_CURRENCY,
            IDENTIFIER,
            BOND,
            liveness,
            8,
            SettlementModel.RAW_SHARE,
            keccak256("AAPL"),
            "Resolve true only if candidatePrice is the AAPL raw-share closing price at maturity. Use primary exchange data and split-adjusted USD per share."
        );
    }
}
