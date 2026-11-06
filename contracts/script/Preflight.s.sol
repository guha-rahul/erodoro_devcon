// SPDX-License-Identifier: Apache-2.0
pragma solidity 0.8.28;

import {Script} from "forge-std/Script.sol";
import {console2} from "forge-std/console2.sol";
import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";

import {IB20} from "base-std/interfaces/IB20.sol";
import {IPolicyRegistry} from "base-std/interfaces/IPolicyRegistry.sol";
import {StdPrecompiles} from "base-std/StdPrecompiles.sol";

import {StrikeMath} from "../src/libraries/StrikeMath.sol";

/// @title Preflight
/// @notice Read the live chain and report what a deployment would be walking
///         into. Run with `make preflight`.
///
/// @dev Two kinds of output. **FAIL** is a blocker: something is wrong or
///      unreadable and a deployment against it would be unsafe. **WARN** is a
///      fact you must have decided about — it does not stop a deployment, it
///      stops an *unconsidered* one.
///
///      What this does NOT establish, and no script can: that an equity market
///      was open, that the confidence policy chosen is the right one, or that an
///      unannounced instant multiplier change will not land inside a future
///      settlement window. See `docs/known-limitations.md`.
contract Preflight is Script {
    uint256 constant BASE_CHAIN_ID = 8453;

    uint256 fails;
    uint256 warns;

    function _fail(string memory what) internal {
        fails++;
        console2.log(string.concat("  FAIL  ", what));
    }

    function _warn(string memory what) internal {
        warns++;
        console2.log(string.concat("  WARN  ", what));
    }

    function _ok(string memory what) internal pure {
        console2.log(string.concat("  ok    ", what));
    }

    function run() external {
        address collateral = vm.envAddress("BASE_COLLATERAL");
        address vaultAddr = vm.envOr("BASE_VAULT", address(0));

        console2.log("=== erodoro-base preflight ===");
        console2.log("chain id:", block.chainid);
        if (block.chainid != BASE_CHAIN_ID) {
            _fail("not Base mainnet - refusing to report on the wrong chain");
            _summary();
            return;
        }

        _checkCollateral(collateral);
        _checkPause(collateral);
        _checkPolicies(collateral, vaultAddr);
        _checkSeizeSurface(collateral);
        _checkSchedule(collateral);
        _checkPriceDecimals();

        _summary();
    }

    // --- Collateral identity -------------------------------------------------

    function _checkCollateral(address collateral) internal {
        console2.log("");
        console2.log("[collateral]", collateral);

        (bool ok, bytes memory data) = collateral.staticcall(abi.encodeWithSignature("multiplier()"));
        if (!ok || data.length < 32) {
            _fail("does not answer multiplier() - this is not a B20 Asset");
            return;
        }
        uint256 m = abi.decode(data, (uint256));
        console2.log("  multiplier (WAD):", m);
        if (m == 0 || m > type(uint128).max) {
            _fail("multiplier is zero or above the B20 ceiling");
        } else if (m != StrikeMath.WAD) {
            _warn("a corporate action has already rebased this token - strikes are quoted per UI unit");
        } else {
            _ok("multiplier is unity");
        }

        uint8 dec = IERC20Metadata(collateral).decimals();
        console2.log("  decimals:", dec);
        if (dec < 6 || dec > 18) {
            _fail("decimals outside B20's [6,18]");
        } else if (dec != 18) {
            _warn("not 18 decimals - the B20 spec urges 18 for equities so reverse-split dust stays noise");
        } else {
            _ok("18 decimals");
        }
    }

    // --- Pause ---------------------------------------------------------------

    function _checkPause(address collateral) internal {
        console2.log("");
        console2.log("[pause]");
        if (IB20(collateral).isPaused(IB20.PausableFeature.TRANSFER)) {
            _fail("TRANSFER is paused - split, merge and redeem all revert right now");
        } else {
            _ok("TRANSFER is live");
        }
        if (IB20(collateral).isPaused(IB20.PausableFeature.BURN)) {
            _warn("BURN is paused");
        }
    }

    // --- Transfer policies ---------------------------------------------------

    /// @dev A policy id of 0 is `ALWAYS_ALLOW`, the creation default. Anything
    ///      else means the issuer has armed a policy that this vault is subject
    ///      to — and a *receiver* policy stops `split` while a *sender* policy
    ///      stops `redeem`, separately.
    function _checkPolicies(address collateral, address vaultAddr) internal {
        console2.log("");
        console2.log("[transfer policies]");

        _policy(collateral, vaultAddr, "TRANSFER_SENDER_POLICY", "redeem and merge would be blocked");
        _policy(collateral, vaultAddr, "TRANSFER_RECEIVER_POLICY", "split would be blocked");
        _policy(collateral, vaultAddr, "TRANSFER_EXECUTOR_POLICY", "transferFrom on split would be blocked");
    }

    function _policy(address collateral, address vaultAddr, string memory scopeName, string memory consequence)
        internal
    {
        (bool ok, bytes memory data) = collateral.staticcall(abi.encodeWithSignature(string.concat(scopeName, "()")));
        if (!ok || data.length < 32) {
            _warn(string.concat(scopeName, " is not readable on this release"));
            return;
        }
        bytes32 scope = abi.decode(data, (bytes32));
        uint64 id = IB20(collateral).policyId(scope);

        if (id == 0) {
            _ok(string.concat(scopeName, ": ALWAYS_ALLOW (unarmed)"));
            return;
        }

        console2.log(string.concat("  ", scopeName, " is ARMED, policy id:"), id);
        if (vaultAddr == address(0)) {
            _warn(string.concat(scopeName, " is armed; set BASE_VAULT to check the vault against it"));
            return;
        }
        bool authorized =
            IPolicyRegistry(StdPrecompiles.POLICY_REGISTRY_ADDRESS).isAuthorized(id, vaultAddr);
        if (!authorized) {
            _fail(string.concat("the vault is NOT authorized under ", scopeName, " - ", consequence));
        } else {
            _warn(string.concat(scopeName, " is armed but the vault is currently authorized - it can be revoked"));
        }
    }

    // --- Which seizure path exists ------------------------------------------

    function _checkSeizeSurface(address collateral) internal {
        console2.log("");
        console2.log("[seizure surface]");
        (bool cobalt,) = collateral.staticcall(abi.encodeWithSignature("SEIZE_ROLE()"));
        if (cobalt) {
            _warn("seizeWithMemo is live - the issuer can reassign vault collateral directly");
        } else {
            _warn(
                "pre-Cobalt: seizure is burnBlocked + re-mint, gated by TRANSFER_SENDER_POLICY. A drain and a redemption freeze arrive together"
            );
        }
    }

    // --- Scheduled corporate actions ----------------------------------------

    function _checkSchedule(address collateral) internal {
        console2.log("");
        console2.log("[scheduled corporate actions]");
        (bool ok, bytes memory data) = collateral.staticcall(abi.encodeWithSignature("effectiveAt()"));
        if (!ok || data.length < 32) {
            _warn(
                "no ERC-8056 pending surface (Beryl). The creation-time corporate-action gate is UNAVAILABLE, not passing"
            );
            return;
        }
        uint256 at = abi.decode(data, (uint256));
        if (at > block.timestamp) {
            console2.log("  pending multiplier change effective at:", at);
            _fail("a corporate action is scheduled - do not open a series maturing after it");
        } else {
            _ok("no live pending multiplier change");
        }
    }

    // --- Price units ---------------------------------------------------------

    /// @notice The configured `priceDecimals` against the live feed's exponent.
    ///
    /// @dev A strike is only meaningful in the units its series declares. Pyth's
    ///      `Equity.US.AAPL/USD` publishes at `expo = -5`; a strike quoted in
    ///      those units against a series declaring 8 understates it by 1000x and
    ///      hands the whole position to N. Nothing downstream catches it: the
    ///      pools still sum to the collateral, because conservation holds for any
    ///      strike. This is the only place the mismatch is visible.
    function _checkPriceDecimals() internal {
        console2.log("");
        console2.log("[price units]");
        uint256 configured = vm.envOr("BASE_PRICE_DECIMALS", uint256(0));
        uint256 feedExpo = vm.envOr("BASE_FEED_EXPO_ABS", uint256(0));
        if (configured == 0 || feedExpo == 0) {
            _warn("set BASE_PRICE_DECIMALS and BASE_FEED_EXPO_ABS to check strike units against the live feed");
            return;
        }
        console2.log("  series priceDecimals:", configured);
        console2.log("  live feed decimals:  ", feedExpo);
        if (configured == feedExpo) {
            _ok("strike units match the feed natively");
        } else {
            _warn(
                "priceDecimals differs from the feed exponent - strikes MUST be quoted in the series' units, not the feed's"
            );
        }
    }

    function _summary() internal view {
        console2.log("");
        console2.log("=== summary ===");
        console2.log("fails:", fails);
        console2.log("warns:", warns);
        if (fails > 0) {
            console2.log("BLOCKED - resolve every FAIL before deploying.");
        } else {
            console2.log("No blockers. Every WARN above is a decision you must have made deliberately.");
        }
    }
}
