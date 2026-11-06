// SPDX-License-Identifier: Apache-2.0
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

import {ErodoroVault} from "../../src/ErodoroVault.sol";
import {Factory} from "../../src/Factory.sol";
import {MarketRipPool} from "../../src/MarketRipPool.sol";
import {MarketRipPut} from "../../src/MarketRipPut.sol";
import {ChainlinkTotalReturnAdapter} from "../../src/oracle/ChainlinkTotalReturnAdapter.sol";
import {CoinbaseFeedStatus} from "../../src/oracle/CoinbaseFeedStatus.sol";
import {IAggregatorV3} from "../../src/oracle/IAggregatorV3.sol";
import {ICoinbaseOracleRegistry} from "../../src/oracle/ICoinbaseOracleRegistry.sol";
import {SettlementModel} from "../../src/oracle/SettlementModel.sol";
import {MockFallbackSettlementOracle} from "../harness/MockFallbackSettlementOracle.sol";

interface ILatestRound {
    function latestRoundData() external view returns (uint80, int256, uint256, uint256, uint80);
}

/// @notice Mainnet dry run of a whole Rips batch on a Base fork: real USDC,
///         ten real Coinbase tokenized stocks, their real Chainlink feeds and
///         Coinbase's real oracle registry. Stock is borrowed from Uniswap v4's
///         PoolManager, which holds all ten. Only the fallback oracle is a mock,
///         standing in for UMA so settlement can be driven after maturity.
///
/// Requires base-forge (B20 precompiles) and a Base mainnet endpoint:
///   BASE_RPC_URL=https://mainnet.base.org FOUNDRY_PROFILE=fork \
///     base-forge test --match-contract RipsMainnetFork -vv
contract RipsMainnetForkTest is Test {
    address constant USDC = 0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913;
    ICoinbaseOracleRegistry constant REGISTRY = ICoinbaseOracleRegistry(0x3f3E8cf41cdd3b1D118c16471aB0113DfDDd5CaD);
    address constant POOL_MANAGER = 0x498581fF718922c3f8e6A244956aF099B2652b2b;

    /// Token, Chainlink "Coinbase <TICKER>" proxy. From contracts/deployments/base-stocks.json.
    address[10] TOKENS = [
        0xb20000000000000000000078ee7ce2fE4908108C, // NVDAc
        0xb2000000000000000000008bC8786B856E61707C, // METAc
        0xb200000000000000000000C2e324d24d7eEcd1fb, // AAPLc
        0xb2000000000000000000002D0BA3164cc74f58B7, // GOOGLc
        0xb200000000000000000000d9192b6B456483C2E8, // AMZNc
        0xB200000000000000000000Ab99cFa739E253872B, // MSFTc
        0xb2000000000000000000004884b426556b92883d, // MSTRc
        0xb200000000000000000000397293Cb8cda9a10c5, // SNDKc
        0xb2000000000000000000007b9fcbd005511aCBd5, // SPCXc
        0xb2000000000000000000001e800a7f5189430cD0 // TSLAc
    ];
    address[10] FEEDS = [
        0x04689a41629776563E6822F76f2e57D148d28513,
        0x6526aE6797A76123638b863AeE4dD27Ba4E4b27D,
        0x787f13dEa48Db0897CbCDD985de77809D837F988,
        0x5bF49E0ffA937CE2FfF033c739aD7C634c4D34F2,
        0x06A8E4b3aBB3B7543d8396FB2B763d22820cB295,
        0xeB10A6c9aa7E537aEd766C08c35Dae35B321b18c,
        0xB3cE282CD188b35DA0E38D8Bc7d58e33173D202a,
        0x388b0dC46C0Fb05A74BeE0994fa5b02c6Fcca2eA,
        0x6A634B235903C4ad6376892180d6fF8612e3Fa68,
        0xFaf869185383a24F8cb00e27BdA6b63B9905DCb4
    ];

    uint256 constant UNITS_PER_RIP = 5e6; // 0.05 token per $1
    uint64 constant SETTLEMENT_DELAY = 60;
    uint64 constant MAX_PRICE_LAG = 4 hours;
    uint64 constant FALLBACK_DELAY = 1 days;

    ErodoroVault vault;
    Factory factory;
    MarketRipPool pool;
    /// @dev One fallback per stock, as the Factory requires.
    MockFallbackSettlementOracle[10] fallbackOracles;
    address buyer = address(0xB0B);
    uint64 expiry;
    uint256 batchId;
    uint256[10] seriesIds;
    bool configured;

    function setUp() public {
        string memory rpc = vm.envOr("BASE_RPC_URL", string(""));
        if (bytes(rpc).length == 0) return;
        vm.createSelectFork(rpc);
        assertEq(block.chainid, 8453, "BASE_RPC_URL is not Base mainnet");
        configured = true;

        vault = new ErodoroVault();
        factory = new Factory(vault, address(this), Factory.Bounds({
            minHorizon: 7 days, maxHorizon: 45 days, minSettlementDelay: 60,
            maxSettlementDelay: 1 days, minPriceLag: 1, maxPriceLag: 25 hours,
            maxConfBps: 500, maxFeeBps: 0, priceDecimals: 8
        }));
        MarketRipPut put = new MarketRipPut(IERC20(USDC), address(this));
        pool = new MarketRipPool(IERC20(USDC), vault, factory, put, address(this));
        vault.setOperator(address(pool), true);

        expiry = uint64(block.timestamp + 30 days);
        batchId = pool.createBatch(expiry);
        uint64 notBefore = expiry + MAX_PRICE_LAG + FALLBACK_DELAY;

        for (uint256 i; i < 10; ++i) {
            bytes32 feedId = keccak256(abi.encode("COINBASE", TOKENS[i]));
            CoinbaseFeedStatus status = new CoinbaseFeedStatus(REGISTRY, TOKENS[i], feedId);
            ChainlinkTotalReturnAdapter adapter = new ChainlinkTotalReturnAdapter(IAggregatorV3(FEEDS[i]), status, feedId);
            fallbackOracles[i] = new MockFallbackSettlementOracle(SettlementModel.TOTAL_RETURN, feedId);
            assertTrue(status.isOperational(feedId), "Coinbase registry reports the feed down");

            factory.setSettlementConfiguration(Factory.SettlementConfigurationParams({
                collateral: TOKENS[i], oracle: address(adapter), fallbackOracle: address(fallbackOracles[i]),
                feedId: feedId, settlementModel: SettlementModel.TOTAL_RETURN,
                fallbackDelay: FALLBACK_DELAY, priceDecimals: 8
            }));

            (, int256 answer,, uint256 updatedAt,) = ILatestRound(FEEDS[i]).latestRoundData();
            assertGt(answer, 0, "feed has no price");
            assertGt(updatedAt, 0, "feed never updated");
            uint256 spot = uint256(answer);
            uint256 strike = (spot * 105 + 99) / 100;

            seriesIds[i] = factory.createSeries(ErodoroVault.CreateSeriesParams({
                collateral: TOKENS[i], oracle: address(adapter), fallbackOracle: address(fallbackOracles[i]),
                feeRecipient: address(this), feedId: feedId,
                fallbackRequestId: fallbackOracles[i].requestIdFor(expiry, notBefore),
                settlementModel: SettlementModel.TOTAL_RETURN, strike: strike, minSplitAmount: 0,
                maturity: expiry, settlementDelay: SETTLEMENT_DELAY, maxPriceLag: MAX_PRICE_LAG,
                fallbackDelay: FALLBACK_DELAY, maxConfBps: 0, feeBps: 0, priceDecimals: 8, admin: address(this)
            }), address(this));

            // Real B20 transfers: PoolManager -> operator -> vault (split) -> pool.
            uint256 lot = UNITS_PER_RIP * pool.INITIAL_VALUE() / pool.RIP_PRICE();
            vm.prank(POOL_MANAGER);
            assertTrue(IERC20(TOKENS[i]).transfer(address(this), lot));
            IERC20(TOKENS[i]).approve(address(vault), lot);
            vault.split(seriesIds[i], lot);

            pool.addPosition(MarketRipPool.AddPositionParams({
                batchId: batchId, stock: TOKENS[i], direction: MarketRipPool.Direction.UP,
                claimId: vault.nId(seriesIds[i]), spotAtCreation: spot, unitsPerRip: UNITS_PER_RIP,
                quoteValidUntil: uint64(block.timestamp + 5 minutes), quoteRef: keccak256(abi.encode("fork", i))
            }));
        }
        pool.activateBatch(batchId);

        deal(USDC, buyer, 10e6);
        vm.prank(buyer);
        IERC20(USDC).approve(address(pool), type(uint256).max);
    }

    modifier onlyConfigured() {
        if (!configured) vm.skip(true);
        _;
    }

    function test_packBuysRealStockUpsideAndSettlesThroughTheFallback() public onlyConfigured {
        uint256 houseBefore = IERC20(USDC).balanceOf(address(this));
        bytes32 hash = pool.upInventoryHash();
        vm.prank(buyer);
        (uint256[] memory ids, uint256[] memory units) = pool.ripPack(hash);
        assertEq(IERC20(USDC).balanceOf(buyer), 9e6, "pack did not cost exactly $1");
        assertEq(IERC20(USDC).balanceOf(address(this)) - houseBefore, 1e6, "house was not paid");
        for (uint256 i; i < 10; ++i) {
            assertEq(units[i], UNITS_PER_RIP / 10);
            assertEq(vault.balanceOf(buyer, pool.position(ids[i]).claimId), UNITS_PER_RIP / 10);
        }

        // After maturity no Chainlink round exists on a fork, as on a feed that
        // went quiet. The fallback opens at maturity + max(delay, lag) + fallbackDelay.
        uint256 s = seriesIds[0];
        address nvda = TOKENS[0];
        uint256 strike = vault.seriesConfig(s).strike;
        uint64 notBefore = expiry + MAX_PRICE_LAG + FALLBACK_DELAY;
        vm.warp(notBefore - 1);
        vm.expectRevert();
        vault.settleFallback(s, "");
        vm.warp(notBefore);
        fallbackOracles[0].setResult(strike * 2, 8, expiry, true);
        vault.settleFallback(s, "");

        // Price ended at 2x the strike, so each N unit is worth half a share.
        uint256 before = IERC20(nvda).balanceOf(buyer);
        vm.prank(buyer);
        uint256 paid = vault.redeem(s, false, UNITS_PER_RIP / 10);
        assertEq(IERC20(nvda).balanceOf(buyer) - before, paid);
        assertApproxEqAbs(paid, UNITS_PER_RIP / 20, 1, "N payout is not (price - strike) / price");
    }

    function test_overpricedSellerListingIsSkippedByPacksOnMainnet() public onlyConfigured {
        // A seller lists AAPLc at a worse price than the house: packs must not reach it.
        address seller = address(0x5E11);
        uint256 templateId = pool.housePosition(batchId, TOKENS[2]);
        uint256 lot = UNITS_PER_RIP * 5;
        vm.prank(POOL_MANAGER);
        assertTrue(IERC20(TOKENS[2]).transfer(seller, lot));
        vm.startPrank(seller);
        IERC20(TOKENS[2]).approve(address(pool), lot);
        (uint256 listing,) = pool.lockAndList(templateId, lot, UNITS_PER_RIP / 2);
        vm.stopPrank();

        for (uint256 r; r < 5; ++r) {
            vm.roll(block.number + 1);
            bytes32 hash = pool.upInventoryHash();
            vm.prank(buyer);
            (uint256[] memory ids,) = pool.ripPack(hash);
            for (uint256 i; i < 10; ++i) assertTrue(ids[i] != listing, "pack drew an overpriced listing");
        }
        assertEq(pool.position(listing).amountSold, 0);
    }
}
