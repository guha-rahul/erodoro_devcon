// SPDX-License-Identifier: Apache-2.0
pragma solidity 0.8.28;

import {Script} from "forge-std/Script.sol";
import {console2} from "forge-std/console2.sol";
import {SafeCast} from "@openzeppelin/contracts/utils/math/SafeCast.sol";

import {ErodoroVault} from "../src/ErodoroVault.sol";
import {Factory} from "../src/Factory.sol";
import {SettlementModel} from "../src/oracle/SettlementModel.sol";
import {IFallbackSettlementOracle} from "../src/oracle/IFallbackSettlementOracle.sol";

/// @title ListSeries
/// @notice Activates one complete settlement configuration, then lists a
///         canonical series through the factory.
///
/// @dev Listing is deliberately separate from deployment. Nothing is canonical
///      until someone decides it is, and that decision is what this script is.
///
///      **Testnet bounds.** On a testnet this relaxes `minHorizon` to zero so a
///      series can mature in minutes and the settle/redeem path can actually be
///      exercised. On mainnet a seven-day floor exists so nobody writes a series
///      that expires before anyone can trade it — do not carry this relaxation
///      across. The script refuses to run on mainnet at all.
contract ListSeries is Script {
    using SafeCast for uint256;

    uint256 constant BASE_MAINNET = 8453;

    struct Listing {
        address collateral;
        address oracle;
        address fallbackOracle;
        bytes32 feedId;
        SettlementModel model;
        uint64 fallbackDelay;
        uint64 maturity;
        uint256 strike;
    }

    function run() external {
        require(block.chainid != BASE_MAINNET, "testnet bounds - not for mainnet");

        uint256 pk = vm.envOr("PRIVATE_KEY", uint256(0));
        address me = pk == 0 ? vm.envAddress("DEPLOYER_ADDRESS") : vm.addr(pk);

        Factory factory = Factory(vm.envAddress("FACTORY_ADDRESS"));
        Listing memory listing;
        listing.collateral = vm.envAddress("BASE_COLLATERAL");
        listing.oracle = vm.envAddress("ADAPTER_ADDRESS");
        listing.fallbackOracle = vm.envOr("FALLBACK_ADAPTER_ADDRESS", address(0));
        listing.feedId = vm.envBytes32("FEED_ID");
        listing.model = SettlementModel(vm.envOr("SETTLEMENT_MODEL", uint256(0)));
        listing.fallbackDelay =
            listing.fallbackOracle == address(0) ? 0 : vm.envOr("FALLBACK_DELAY", uint256(1 days)).toUint64();

        // Near the money, quoted in the series' own decimals. Getting these
        // units wrong is silent: the pools still sum to the collateral for any
        // strike, so nothing downstream complains.
        listing.strike = vm.envOr("SERIES_STRIKE", uint256(280) * 1e8);
        listing.maturity = (block.timestamp + vm.envOr("SERIES_HORIZON", uint256(600))).toUint64();

        if (pk == 0) vm.startBroadcast();
        else vm.startBroadcast(pk);

        // A fresh deployment needs its admin-owned bounds and settlement tuple
        // activated first. Later listings can reuse the active tuple without
        // requiring the listing wallet to be the factory admin.
        if (vm.envOr("CONFIGURE_FACTORY", true)) {
            factory.setBounds(
                Factory.Bounds({
                    minHorizon: 0,
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

            factory.setSettlementConfiguration(
                Factory.SettlementConfigurationParams({
                    collateral: listing.collateral,
                    oracle: listing.oracle,
                    fallbackOracle: listing.fallbackOracle,
                    feedId: listing.feedId,
                    settlementModel: listing.model,
                    fallbackDelay: listing.fallbackDelay,
                    priceDecimals: 8
                })
            );
        }

        uint64 settlementDelay = 60;
        uint64 maxPriceLag = 60;
        uint64 notBefore =
            listing.maturity + (settlementDelay > maxPriceLag ? settlementDelay : maxPriceLag) + listing.fallbackDelay;
        bytes32 fallbackRequestId = listing.fallbackOracle == address(0)
            ? bytes32(0)
            : IFallbackSettlementOracle(listing.fallbackOracle).requestIdFor(listing.maturity, notBefore);

        uint256 seriesId = factory.createSeries(
            ErodoroVault.CreateSeriesParams({
                collateral: listing.collateral,
                oracle: listing.oracle,
                fallbackOracle: listing.fallbackOracle,
                feeRecipient: me,
                feedId: listing.feedId,
                fallbackRequestId: fallbackRequestId,
                settlementModel: listing.model,
                strike: listing.strike,
                minSplitAmount: 0,
                maturity: listing.maturity,
                settlementDelay: settlementDelay,
                maxPriceLag: maxPriceLag,
                fallbackDelay: listing.fallbackDelay,
                maxConfBps: listing.model == SettlementModel.RAW_SHARE ? 500 : 0,
                feeBps: 0,
                priceDecimals: 8,
                admin: me
            }),
            me
        );

        vm.stopBroadcast();

        ErodoroVault vault = factory.vault();
        console2.log("=== listed ===");
        console2.log("seriesId  ", seriesId);
        console2.log("hex       ", vm.toString(bytes32(seriesId)));
        console2.log("P id      ", vault.pId(seriesId));
        console2.log("N id      ", vault.nId(seriesId));
        console2.log("strike    ", listing.strike);
        console2.log("maturity  ", listing.maturity);
        console2.log("settles at", uint256(listing.maturity) + 60);
        console2.log("canonical ", factory.canonicalCount());
    }
}
