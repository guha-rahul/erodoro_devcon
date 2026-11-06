// SPDX-License-Identifier: Apache-2.0
pragma solidity 0.8.28;

import {IB20} from "base-std/interfaces/IB20.sol";
import {IB20Asset} from "base-std/interfaces/IB20Asset.sol";

/// @title TestIssuerControls
/// @notice Lets anyone on a testnet pull the issuer's levers, so the paths that
///         handle them can actually be exercised.
///
/// @dev The issuer controls are the part of this protocol most likely to be
///      wrong, and they are unreachable in normal testing because they belong
///      to the issuer. Holding the roles here lets a tester fire them on demand
///      and watch what the protocol does.
///
///      **What it can simulate:**
///      - a stock split or reverse split, via the multiplier. This is the one
///        that matters most: it is what the strike adjustment exists for, and
///        getting it wrong wipes out one side of a market in an event where
///        nobody lost money.
///      - a transfer pause, which must delay redemption rather than strand it.
///
///      **What it cannot:** a seizure. On this release seizure is `burnBlocked`,
///      which requires the target to be *denied* under `TRANSFER_SENDER_POLICY`
///      first. Arming a policy against the vault would also stop the vault
///      sending to redeemers, so simulating it needs a policy change rather
///      than a role. Left out rather than faked.
///
///      Mainnet-hostile by construction, and the roles it needs can be revoked
///      by the token admin at any time.
contract TestIssuerControls {
    uint256 private constant BASE_MAINNET = 8453;
    uint256 private constant WAD = 1e18;

    IB20Asset public immutable token;

    error NotForMainnet();
    error RatioOutOfRange();

    event SplitSimulated(uint256 oldMultiplier, uint256 newMultiplier);
    event TransfersPaused(bool paused);

    constructor(IB20Asset token_) {
        if (block.chainid == BASE_MAINNET) revert NotForMainnet();
        token = token_;
    }

    /// @notice Apply a corporate action: `numerator/denominator` shares per share.
    /// @dev `2, 1` is a two-for-one split; `1, 2` a one-for-two reverse split.
    ///      Bounded so a fat finger cannot push the multiplier somewhere the
    ///      token would reject and leave the sandbox wedged.
    function simulateSplit(uint256 numerator, uint256 denominator) external {
        if (numerator == 0 || denominator == 0 || numerator > 100 || denominator > 100) {
            revert RatioOutOfRange();
        }
        uint256 current = token.multiplier();
        uint256 next = (current * numerator) / denominator;
        if (next == 0) revert RatioOutOfRange();
        token.updateMultiplier(next);
        emit SplitSimulated(current, next);
    }

    /// @notice Put the multiplier back to unity, whatever it is now.
    function resetMultiplier() external {
        uint256 current = token.multiplier();
        token.updateMultiplier(WAD);
        emit SplitSimulated(current, WAD);
    }

    /// @notice Halt or resume transfers, as the issuer can.
    function setTransfersPaused(bool paused) external {
        IB20.PausableFeature[] memory features = new IB20.PausableFeature[](1);
        features[0] = IB20.PausableFeature.TRANSFER;
        if (paused) {
            IB20(address(token)).pause(features);
        } else {
            IB20(address(token)).unpause(features);
        }
        emit TransfersPaused(paused);
    }

    /// @notice What the sandbox currently has done to the token.
    function state() external view returns (uint256 multiplier, bool transfersPaused) {
        multiplier = token.multiplier();
        transfersPaused = IB20(address(token)).isPaused(IB20.PausableFeature.TRANSFER);
    }
}
