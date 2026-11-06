// SPDX-License-Identifier: Apache-2.0
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {MockPythUnique} from "../harness/MockPythUnique.sol";

import {ErodoroVault} from "../../src/ErodoroVault.sol";
import {Factory} from "../../src/Factory.sol";
import {PythAdapter} from "../../src/oracle/PythAdapter.sol";
import {IPythUnique} from "../../src/oracle/IPythUnique.sol";
import {SettlementModel} from "../../src/oracle/SettlementModel.sol";
import {Errors} from "../../src/libraries/Errors.sol";
import {MockB20Asset} from "../harness/MockB20Asset.sol";
import {MockOracleAdapter} from "../harness/MockOracleAdapter.sol";
import {MockFallbackSettlementOracle} from "../harness/MockFallbackSettlementOracle.sol";

contract FactoryTest is Test {
    MockB20Asset collateral;
    MockPythUnique pyth;
    PythAdapter adapter;
    ErodoroVault vault;
    Factory factory;

    address gov = address(0x60F);
    address alice = address(0xA11CE);

    bytes32 constant FEED = bytes32("AAPLc/USD");
    bytes32 constant NVDA_FEED = bytes32("NVDAc/USD");
    bytes32 constant META_FEED = bytes32("METAc/USD");
    bytes32 constant GOOGL_FEED = bytes32("GOOGLc/USD");
    uint256 constant USD = 1e8;
    uint256 constant STRIKE = 500 * USD;
    uint64 maturity;

    function setUp() public {
        vm.warp(1_700_000_000);
        collateral = new MockB20Asset("Apple Tokenized Stock", "AAPLc", 18, false);
        pyth = new MockPythUnique(60, 1);
        adapter = new PythAdapter(IPythUnique(address(pyth)));
        vault = new ErodoroVault();

        factory = new Factory(
            vault,
            gov,
            Factory.Bounds({
                minHorizon: 7 days,
                maxHorizon: 365 days,
                minSettlementDelay: 60,
                maxSettlementDelay: 1 days,
                minPriceLag: 1,
                maxPriceLag: 25 hours,
                maxConfBps: 500,
                maxFeeBps: 100,
                priceDecimals: 8
            })
        );

        vm.startPrank(gov);
        factory.setSettlementConfiguration(
            _configuration(address(collateral), address(adapter), address(0), FEED, SettlementModel.RAW_SHARE)
        );
        vm.stopPrank();

        maturity = uint64(block.timestamp + 30 days);
    }

    function _configuration(
        address collateral_,
        address oracle_,
        address fallbackOracle_,
        bytes32 feedId_,
        SettlementModel model_
    ) internal pure returns (Factory.SettlementConfigurationParams memory) {
        return Factory.SettlementConfigurationParams({
            collateral: collateral_,
            oracle: oracle_,
            fallbackOracle: fallbackOracle_,
            feedId: feedId_,
            settlementModel: model_,
            fallbackDelay: fallbackOracle_ == address(0) ? 0 : 1 days,
            priceDecimals: 8
        });
    }

    function _params() internal view returns (ErodoroVault.CreateSeriesParams memory) {
        return ErodoroVault.CreateSeriesParams({
            collateral: address(collateral),
            oracle: address(adapter),
            fallbackOracle: address(0),
            feeRecipient: address(0xFEE),
            feedId: FEED,
            fallbackRequestId: bytes32(0),
            settlementModel: SettlementModel.RAW_SHARE,
            strike: STRIKE,
            minSplitAmount: 0,
            maturity: maturity,
            settlementDelay: 300,
            maxPriceLag: 60,
            fallbackDelay: 0,
            maxConfBps: 500,
            feeBps: 0,
            priceDecimals: 8,
            admin: address(0)
        });
    }

    // --- The registry --------------------------------------------------------

    function test_listsCanonicalSeries() public {
        vm.prank(alice);
        uint256 id = factory.createSeries(_params(), gov);

        assertEq(factory.canonicalCount(), 1);
        assertEq(factory.canonicalAt(0), id);
        (uint256 recId, bytes32 configurationId,,,,,,,,, bool canonical) = factory.recordOf(id);
        assertEq(recId, id);
        assertEq(configurationId, factory.activeConfigurationId(address(collateral)));
        assertTrue(canonical);
    }

    /// @notice Every factory series lives in the factory's own id space, so no
    ///         other creator can occupy an address it would have used.
    function test_factorySeriesAreScopedToTheFactory() public {
        vm.prank(alice);
        uint256 viaFactory = factory.createSeries(_params(), gov);

        // The same terms, created directly, land on a different id.
        vm.prank(alice);
        uint256 direct = vault.createSeries(_params());
        assertTrue(viaFactory != direct, "factory id space must be its own");
    }

    /// @notice The factory takes no power over what it creates.
    function test_factoryHoldsNoAdminOverItsSeries() public {
        vm.prank(alice);
        uint256 id = factory.createSeries(_params(), gov);

        // The designated admin can act...
        vm.prank(gov);
        vault.pauseSplits(id);

        // ...the factory itself cannot.
        vm.prank(address(factory));
        vm.expectRevert(Errors.Unauthorized.selector);
        vault.unpauseSplits(id);
    }

    function test_anAdminlessSeriesHasNoAdminSurfaceAtAll() public {
        vm.prank(alice);
        uint256 id = factory.createSeries(_params(), address(0));
        vm.prank(gov);
        vm.expectRevert(Errors.Unauthorized.selector);
        vault.pauseSplits(id);
    }

    // --- Settlement configurations ------------------------------------------

    function test_rejectsUnapprovedCollateral() public {
        MockB20Asset other = new MockB20Asset("Meta", "METAc", 18, false);
        ErodoroVault.CreateSeriesParams memory p = _params();
        p.collateral = address(other);
        vm.prank(alice);
        vm.expectRevert(Errors.InvalidSettlementConfiguration.selector);
        factory.createSeries(p, gov);
    }

    function test_rejectsUnapprovedOracle() public {
        ErodoroVault.CreateSeriesParams memory p = _params();
        p.oracle = address(0xDEAD);
        vm.prank(alice);
        vm.expectRevert(Errors.InvalidSettlementConfiguration.selector);
        factory.createSeries(p, gov);
    }

    /// @notice One adapter serves every Pyth feed, so approving the adapter must
    ///         not approve every price Pyth publishes.
    function test_rejectsUnapprovedFeed() public {
        ErodoroVault.CreateSeriesParams memory p = _params();
        p.feedId = bytes32("DOGE/USD");
        vm.prank(alice);
        vm.expectRevert(Errors.InvalidSettlementConfiguration.selector);
        factory.createSeries(p, gov);
    }

    function test_aaplCannotUseAnyOtherApprovedStockFeed() public {
        bytes32[3] memory wrongFeeds = [NVDA_FEED, META_FEED, GOOGL_FEED];
        for (uint256 i = 0; i < wrongFeeds.length; i++) {
            MockB20Asset other = new MockB20Asset("Other stock", "OTHERc", 18, false);
            vm.prank(gov);
            factory.setSettlementConfiguration(
                _configuration(address(other), address(adapter), address(0), wrongFeeds[i], SettlementModel.RAW_SHARE)
            );

            ErodoroVault.CreateSeriesParams memory p = _params();
            p.feedId = wrongFeeds[i];
            vm.prank(alice);
            vm.expectRevert(Errors.InvalidSettlementConfiguration.selector);
            factory.createSeries(p, gov);
        }
    }

    function test_disabledConfigurationKeepsTheAssetDisabled() public {
        bytes32 configurationId = factory.activeConfigurationId(address(collateral));
        vm.prank(gov);
        factory.setConfigurationEnabled(configurationId, false);

        vm.prank(alice);
        vm.expectRevert(Errors.InvalidSettlementConfiguration.selector);
        factory.createSeries(_params(), gov);

        (, Factory.SettlementConfiguration memory configuration) =
            factory.activeSettlementConfiguration(address(collateral));
        assertFalse(configuration.enabled);
    }

    function test_changingTheAdapterCreatesANewVersionAndDeactivatesTheOldOne() public {
        bytes32 oldId = factory.activeConfigurationId(address(collateral));
        MockOracleAdapter replacement = new MockOracleAdapter(SettlementModel.RAW_SHARE);
        vm.prank(gov);
        bytes32 newId = factory.setSettlementConfiguration(
            _configuration(address(collateral), address(replacement), address(0), FEED, SettlementModel.RAW_SHARE)
        );

        assertTrue(newId != oldId);
        assertEq(factory.activeConfigurationId(address(collateral)), newId);

        vm.prank(alice);
        vm.expectRevert(Errors.InvalidSettlementConfiguration.selector);
        factory.createSeries(_params(), gov);

        ErodoroVault.CreateSeriesParams memory p = _params();
        p.oracle = address(replacement);
        vm.prank(alice);
        factory.createSeries(p, gov);
    }

    function test_fallbackRequestMustMatchTheSeriesRecoveryTime() public {
        MockFallbackSettlementOracle fallbackOracle = new MockFallbackSettlementOracle(SettlementModel.RAW_SHARE, FEED);
        vm.prank(gov);
        factory.setSettlementConfiguration(
            _configuration(
                address(collateral), address(adapter), address(fallbackOracle), FEED, SettlementModel.RAW_SHARE
            )
        );

        ErodoroVault.CreateSeriesParams memory p = _params();
        p.fallbackOracle = address(fallbackOracle);
        p.fallbackDelay = 1 days;
        p.fallbackRequestId = bytes32(uint256(1));
        vm.prank(alice);
        vm.expectRevert(Errors.InvalidSettlementConfiguration.selector);
        factory.createSeries(p, gov);

        uint64 notBefore = p.maturity + p.fallbackDelay + p.settlementDelay;
        p.fallbackRequestId = fallbackOracle.requestIdFor(p.maturity, notBefore);
        vm.prank(alice);
        factory.createSeries(p, gov);
    }

    function test_fallbackForAnotherStockIsRejected() public {
        // A shared fallback keys requests by time only, so it would settle every stock at one answer.
        MockFallbackSettlementOracle nvdaFallback = new MockFallbackSettlementOracle(SettlementModel.RAW_SHARE, NVDA_FEED);
        vm.prank(gov);
        vm.expectRevert(Errors.FeedMismatch.selector);
        factory.setSettlementConfiguration(
            _configuration(
                address(collateral), address(adapter), address(nvdaFallback), FEED, SettlementModel.RAW_SHARE
            )
        );
    }

    function test_fallbackDelayMustMatchTheApprovedConfiguration() public {
        MockFallbackSettlementOracle fallbackOracle = new MockFallbackSettlementOracle(SettlementModel.RAW_SHARE, FEED);
        vm.prank(gov);
        factory.setSettlementConfiguration(
            _configuration(
                address(collateral), address(adapter), address(fallbackOracle), FEED, SettlementModel.RAW_SHARE
            )
        );

        ErodoroVault.CreateSeriesParams memory p = _params();
        p.fallbackOracle = address(fallbackOracle);
        p.fallbackDelay = 2 days;
        uint64 notBefore = p.maturity + p.fallbackDelay + p.settlementDelay;
        p.fallbackRequestId = fallbackOracle.requestIdFor(p.maturity, notBefore);

        vm.prank(alice);
        vm.expectRevert(Errors.InvalidSettlementConfiguration.selector);
        factory.createSeries(p, gov);
    }

    // --- Bounds --------------------------------------------------------------

    function test_rejectsMaturityOutsideTheHorizon() public {
        ErodoroVault.CreateSeriesParams memory p = _params();
        p.maturity = uint64(block.timestamp + 1 days); // inside minHorizon
        vm.prank(alice);
        vm.expectRevert(Errors.InvalidMaturity.selector);
        factory.createSeries(p, gov);

        p.maturity = uint64(block.timestamp + 400 days); // beyond maxHorizon
        vm.prank(alice);
        vm.expectRevert(Errors.InvalidMaturity.selector);
        factory.createSeries(p, gov);
    }

    function test_rejectsAPriceLagOutsideBounds() public {
        ErodoroVault.CreateSeriesParams memory p = _params();
        p.maxPriceLag = 25 hours + 1; // above maxPriceLag
        vm.prank(alice);
        vm.expectRevert(Errors.InvalidParams.selector);
        factory.createSeries(p, gov);
    }

    /// @notice A canonical listing must state a confidence policy. Zero disables
    ///         the gate, which is exactly what a listed series must not do.
    function test_rejectsADisabledConfidenceGate() public {
        ErodoroVault.CreateSeriesParams memory p = _params();
        p.maxConfBps = 0;
        vm.prank(alice);
        vm.expectRevert(Errors.InvalidParams.selector);
        factory.createSeries(p, gov);
    }

    function test_rejectsALaxerConfidencePolicyThanTheCeiling() public {
        ErodoroVault.CreateSeriesParams memory p = _params();
        p.maxConfBps = 5000; // laxer than the 500bp ceiling
        vm.prank(alice);
        vm.expectRevert(Errors.InvalidParams.selector);
        factory.createSeries(p, gov);
    }

    function test_allowsAStricterConfidencePolicy() public {
        ErodoroVault.CreateSeriesParams memory p = _params();
        p.maxConfBps = 50;
        vm.prank(alice);
        uint256 id = factory.createSeries(p, gov);
        assertTrue(id != 0);
    }

    function test_totalReturnConfigurationRequiresZeroConfidenceBps() public {
        MockOracleAdapter totalReturn = new MockOracleAdapter(SettlementModel.TOTAL_RETURN);
        vm.prank(gov);
        factory.setSettlementConfiguration(
            _configuration(address(collateral), address(totalReturn), address(0), FEED, SettlementModel.TOTAL_RETURN)
        );

        ErodoroVault.CreateSeriesParams memory p = _params();
        p.oracle = address(totalReturn);
        p.settlementModel = SettlementModel.TOTAL_RETURN;

        vm.prank(alice);
        vm.expectRevert(Errors.InvalidParams.selector);
        factory.createSeries(p, gov);

        p.maxConfBps = 0;
        vm.prank(alice);
        factory.createSeries(p, gov);
    }

    function test_rejectsMismatchedPriceDecimals() public {
        ErodoroVault.CreateSeriesParams memory p = _params();
        p.priceDecimals = 6;
        vm.prank(alice);
        vm.expectRevert(Errors.InvalidSettlementConfiguration.selector);
        factory.createSeries(p, gov);
    }

    // --- Pause ---------------------------------------------------------------

    /// @notice Pausing the factory stops *listing*. It must not stop anyone from
    ///         opening a series on the vault: creation is permissionless by
    ///         design and the registry only decides what is canonical.
    function test_pauseStopsListingButNotPermissionlessCreation() public {
        vm.prank(gov);
        factory.pauseCreation();

        vm.prank(alice);
        vm.expectRevert(Errors.CreationPaused.selector);
        factory.createSeries(_params(), gov);

        vm.prank(alice);
        uint256 id = vault.createSeries(_params());
        assertTrue(id != 0, "the vault stays permissionless");
        (,,,,,,,,,, bool canonical) = factory.recordOf(id);
        assertFalse(canonical, "but it is not canonical");
    }

    function test_onlyAdminMayChangeSettlementConfigurations() public {
        vm.prank(alice);
        vm.expectRevert(Errors.Unauthorized.selector);
        factory.setSettlementConfiguration(
            _configuration(address(collateral), address(adapter), address(0), FEED, SettlementModel.RAW_SHARE)
        );
    }
}
