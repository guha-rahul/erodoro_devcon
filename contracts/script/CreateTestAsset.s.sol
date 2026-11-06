// SPDX-License-Identifier: Apache-2.0
pragma solidity 0.8.28;

import {Script} from "forge-std/Script.sol";
import {console2} from "forge-std/console2.sol";

import {IB20} from "base-std/interfaces/IB20.sol";
import {IB20Asset} from "base-std/interfaces/IB20Asset.sol";
import {IB20Factory} from "base-std/interfaces/IB20Factory.sol";
import {B20FactoryLib} from "base-std/lib/B20FactoryLib.sol";
import {B20Constants} from "base-std/lib/B20Constants.sol";
import {StdPrecompiles} from "base-std/StdPrecompiles.sol";

/// @title CreateTestAsset
/// @notice Creates a B20 Asset on a testnet to stand in for a tokenized equity.
///
/// @dev **Why this exists.** There is no real tokenized equity on a testnet, so
///      the full lifecycle cannot be exercised there without one. This creates a
///      token with the same shape as the live article — the asset variant, 8
///      decimals, a unity multiplier — so that everything downstream is
///      exercising the real standard rather than a mock.
///
///      It deliberately mirrors the live token's decimals rather than the 18
///      the spec urges, because the point is to reproduce what actually ships.
///
///      **This must never run against mainnet.** It reverts on chain 8453.
///      Nothing about a self-minted token belongs near real collateral.
contract CreateTestAsset is Script {
    uint256 constant BASE_MAINNET = 8453;

    struct Spec {
        address me;
        string name;
        string symbol;
        uint8 decimals;
        uint256 supply;
        bytes32 salt;
    }

    function run() external {
        require(block.chainid != BASE_MAINNET, "refusing to mint a fake equity on mainnet");

        uint256 pk = vm.envOr("PRIVATE_KEY", uint256(0));
        address deployer = pk == 0 ? vm.envAddress("DEPLOYER_ADDRESS") : vm.addr(pk);
        Spec memory spec = _spec(deployer);

        IB20Factory factory = IB20Factory(StdPrecompiles.B20_FACTORY_ADDRESS);
        address predicted = factory.getB20Address(IB20Factory.B20Variant.ASSET, spec.me, spec.salt);

        console2.log("chain id ", block.chainid);
        console2.log("deployer ", spec.me);
        console2.log("predicted", predicted);

        if (predicted.code.length > 0) {
            console2.log("already created - nothing to do");
            _report(predicted);
            return;
        }

        _create(pk, factory, spec);
        _report(predicted);
    }

    /// @dev Held in a struct so no single frame carries them all on the stack.
    function _spec(address me) internal view returns (Spec memory spec) {
        spec.me = me;
        spec.name = vm.envOr("TEST_ASSET_NAME", string("Apple Inc. (test)"));
        spec.symbol = vm.envOr("TEST_ASSET_SYMBOL", string("tAAPLc"));
        spec.decimals = uint8(vm.envOr("TEST_ASSET_DECIMALS", uint256(8)));
        spec.supply = vm.envOr("TEST_ASSET_SUPPLY", uint256(1_000) * 10 ** uint256(spec.decimals));
        spec.salt = keccak256(abi.encodePacked("erodoro-test-asset", spec.symbol, block.chainid));
    }

    function _create(uint256 pk, IB20Factory factory, Spec memory spec) internal {
        // Every role to the deployer: this is a testnet asset whose whole
        // purpose is to be mintable and seizable on demand.
        bytes[] memory initCalls = B20FactoryLib.buildRoleGrants(
            B20FactoryLib.B20AssetRoleHolders({
                minter: spec.me,
                burner: spec.me,
                burnBlocker: spec.me,
                pauser: spec.me,
                unpauser: spec.me,
                metadataAdmin: spec.me,
                operator: spec.me
            })
        );

        if (pk == 0) vm.startBroadcast();
        else vm.startBroadcast(pk);
        address token = factory.createB20(
            IB20Factory.B20Variant.ASSET,
            spec.salt,
            B20FactoryLib.encodeAssetCreateParams(spec.name, spec.symbol, spec.me, spec.decimals),
            initCalls
        );
        IB20(token).mint(spec.me, spec.supply);
        vm.stopBroadcast();
        console2.log("created  ", token);
    }

    function _report(address token) internal view {
        console2.log("");
        console2.log("=== token ===");
        console2.log("symbol    ", IB20(token).symbol());
        console2.log("decimals  ", IB20(token).decimals());
        console2.log("supply    ", IB20(token).totalSupply());
        console2.log("multiplier", IB20Asset(token).multiplier());
        console2.log("");
        console2.log("Set BASE_COLLATERAL to this address to use it as series collateral.");
    }
}
