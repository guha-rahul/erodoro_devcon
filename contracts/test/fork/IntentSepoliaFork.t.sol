// SPDX-License-Identifier: Apache-2.0
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {stdJson} from "forge-std/StdJson.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

import {ErodoroVault} from "../../src/ErodoroVault.sol";
import {ErodoroIntent} from "../../src/ErodoroIntent.sol";
import {Factory} from "../../src/Factory.sol";
import {SettlementModel} from "../../src/oracle/SettlementModel.sol";
import {IFallbackSettlementOracle} from "../../src/oracle/IFallbackSettlementOracle.sol";

/// @title IntentSepoliaFork
/// @notice The permissionless intent flow against live Base Sepolia state.
///
/// ## What is real
/// - the deployed vault, factory, intent settlement and test quote token from
///   deployments/base-sepolia.json (addresses loaded from that file, not copied);
/// - the live tAAPLc B20 test asset, its decimals, multiplier and policies;
/// - the factory's active settlement configuration and bounds.
/// Writer/buyer are fresh keys funded from the pilot's_completed accounts via
/// plain transfers — no private keys leave the test.
///
/// ## What this cannot establish
/// Maturity settlement against the live Pyth adapter (needs a genuinely signed
/// Hermes update for a timestamp in the window). Settlement/redeem math is
/// proven locally in AuctionFlow.t.sol; the recorded pilot proves live Pyth
/// settlement for this vault.
///
/// ## Running it
/// Requires base-forge (B20 precompiles) and a Sepolia endpoint:
///   BASE_SEPOLIA_RPC_URL=https://sepolia.base.org \
///     FOUNDRY_PROFILE=fork base-forge test --match-contract IntentSepoliaFork -vv
contract IntentSepoliaForkTest is Test {
    using stdJson for string;

    uint256 constant SEPOLIA = 84532;
    uint256 constant WRITER_KEY = 0x5E11E4;
    uint256 constant BUYER_KEY = 0xB0B5EED;
    // Sized to live balances: the pilot seller holds ~0.9 tAAPLc and the
    // pilot maker ~478 tUSDC at the time of writing.
    uint256 constant AMOUNT = 0.5e8;
    uint256 constant FLOOR = 5_000_000; // 5 tUSDC

    bool configured;
    ErodoroVault vault;
    Factory factory;
    IERC20 stock;
    IERC20 quoteToken;
    ErodoroIntent intent;
    address writer;
    address buyer;
    uint256 seriesId;
    uint256 nid;

    function setUp() public {
        string memory rpc = vm.envOr("BASE_SEPOLIA_RPC_URL", string("https://sepolia.base.org"));
        vm.createSelectFork(rpc);
        if (block.chainid != SEPOLIA) return;
        configured = true;

        string memory deployments = vm.readFile("deployments/base-sepolia.json");
        vault = ErodoroVault(deployments.readAddress(".contracts.vault"));
        factory = Factory(deployments.readAddress(".contracts.factory"));
        stock = IERC20(deployments.readAddress(".testAsset.token"));
        quoteToken = IERC20(deployments.readAddress(".contracts.testQuoteToken"));
        address pilotSeller = deployments.readAddress(".accounts.seller");
        address pilotMaker = deployments.readAddress(".accounts.maker");

        writer = vm.addr(WRITER_KEY);
        buyer = vm.addr(BUYER_KEY);
        intent = ErodoroIntent(deployments.readAddress(".contracts.intent"));

        // Fund fresh keys from the completed pilot accounts (fork only).
        vm.prank(pilotSeller);
        require(stock.transfer(writer, AMOUNT), "stock funding failed");
        vm.prank(pilotMaker);
        require(quoteToken.transfer(buyer, 100_000_000), "quote funding failed");

        (bytes32 configId, Factory.SettlementConfiguration memory cfg) =
            factory.activeSettlementConfiguration(address(stock));
        require(cfg.enabled && cfg.collateral != address(0), "no active settlement config");

        uint64 maturity = uint64(block.timestamp + 30 days);
        uint64 maxPriceLag = 3600;
        uint64 notBefore = maturity + 3600 + cfg.fallbackDelay;
        bytes32 fallbackRequestId =
            IFallbackSettlementOracle(cfg.fallbackOracle).requestIdFor(maturity, notBefore);

        ErodoroVault.CreateSeriesParams memory p = ErodoroVault.CreateSeriesParams({
            collateral: address(stock),
            oracle: cfg.oracle,
            fallbackOracle: cfg.fallbackOracle,
            feeRecipient: writer,
            feedId: cfg.feedId,
            fallbackRequestId: fallbackRequestId,
            settlementModel: cfg.settlementModel,
            strike: 340 * 1e8,
            minSplitAmount: 0,
            maturity: maturity,
            settlementDelay: 60,
            maxPriceLag: maxPriceLag,
            fallbackDelay: cfg.fallbackDelay,
            maxConfBps: cfg.settlementModel == SettlementModel.RAW_SHARE ? 500 : 0,
            feeBps: 0,
            priceDecimals: cfg.priceDecimals,
            admin: writer
        });
        vm.prank(writer);
        seriesId = factory.createSeries(p, writer);
        (uint256 rid,,,,,,,,,, bool isCanonical) = factory.recordOf(seriesId);
        require(rid == seriesId && isCanonical, "series not canonical");
        assertEq(configId, _recordConfigId(seriesId));

        vm.startPrank(writer);
        stock.approve(address(vault), AMOUNT);
        vault.split(seriesId, AMOUNT);
        vault.setOperator(address(intent), true);
        vm.stopPrank();
        nid = vault.nId(seriesId);

        vm.prank(buyer);
        quoteToken.approve(address(intent), type(uint256).max);
    }

    function _intent(uint256 nonce) internal view returns (ErodoroIntent.SellIntent memory) {
        (uint256 strike, uint64 maturity) = _terms();
        return ErodoroIntent.SellIntent({
            seller: writer,
            claims: address(vault),
            claimId: nid,
            collateral: address(stock),
            strike: strike,
            maturity: maturity,
            claimAmount: AMOUNT,
            quoteToken: address(quoteToken),
            minPremium: FLOOR,
            nonce: nonce,
            validFrom: block.timestamp - 1,
            validUntil: block.timestamp + 1 days,
            allowPartial: false,
            allowRollover: false
        });
    }

    function _recordConfigId(uint256 id) internal view returns (bytes32 configId) {
        (, configId,,,,,,,,,) = factory.recordOf(id);
    }

    function _terms() internal view returns (uint256 strike, uint64 maturity) {
        // seriesConfig returns the full tuple; strike is word 9, maturity word 12.
        (bool ok, bytes memory data) = address(vault).staticcall(
            abi.encodeWithSignature("seriesConfig(uint256)", seriesId & ~uint256(1))
        );
        require(ok && data.length >= 22 * 32, "seriesConfig unreadable");
        assembly ("memory-safe") {
            strike := mload(add(add(data, 32), mul(9, 32)))
            maturity := mload(add(add(data, 32), mul(12, 32)))
        }
    }

    function _sign(ErodoroIntent.SellIntent memory i) internal view returns (bytes memory) {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(WRITER_KEY, intent.hashIntent(i));
        return abi.encodePacked(r, s, v);
    }

    function test_forkIntentFillAgainstLiveSepoliaStack() public {
        if (!configured) return;
        ErodoroIntent.SellIntent memory i = _intent(1);
        bytes memory sig = _sign(i);

        (bool ok, string memory why) = intent.checkIntent(i, sig, AMOUNT, FLOOR, buyer);
        assertTrue(ok, why);

        uint256 writerQuoteBefore = quoteToken.balanceOf(writer);
        vm.prank(buyer);
        intent.fillIntent(i, sig, AMOUNT, FLOOR);

        assertEq(quoteToken.balanceOf(writer) - writerQuoteBefore, FLOOR, "writer paid floor in tUSDC");
        assertEq(vault.balanceOf(buyer, nid), AMOUNT, "buyer holds upside on the live vault");
        assertEq(vault.balanceOf(writer, vault.pId(seriesId)), AMOUNT, "writer keeps capped claim");
        assertEq(quoteToken.balanceOf(address(intent)), 0, "intent holds nothing");
    }

    function test_forkLowBidCannotFillLiveIntent() public {
        if (!configured) return;
        ErodoroIntent.SellIntent memory i = _intent(1);
        bytes memory sig = _sign(i);
        vm.prank(buyer);
        vm.expectRevert(
            abi.encodeWithSelector(ErodoroIntent.PremiumBelowFloor.selector, FLOOR - 1, FLOOR)
        );
        intent.fillIntent(i, sig, AMOUNT, FLOOR - 1);
    }

    function test_forkCancelledIntentCannotFillLive() public {
        if (!configured) return;
        ErodoroIntent.SellIntent memory i = _intent(1);
        bytes memory sig = _sign(i);
        vm.prank(writer);
        intent.cancelIntent(i);
        vm.prank(buyer);
        vm.expectRevert(abi.encodeWithSelector(ErodoroIntent.IntentAlreadyUsed.selector, uint256(1)));
        intent.fillIntent(i, sig, AMOUNT, FLOOR);
    }
}
