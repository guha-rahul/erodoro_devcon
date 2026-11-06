// SPDX-License-Identifier: Apache-2.0
pragma solidity 0.8.28;

interface ISafeThreshold {
    function getThreshold() external view returns (uint256);
}

/// @notice On Base mainnet, the roles that move house funds or change
///         settlement must sit behind a Safe that needs at least two
///         signatures. Deploy scripts call this before broadcasting, so a
///         single hot key can never be wired in by mistake; the pool's
///         operator is immutable, so the mistake could not be undone.
library RequireSafe {
    uint256 internal constant BASE_MAINNET = 8453;

    function check(address who, string memory role) internal view {
        if (block.chainid != BASE_MAINNET) return;
        require(who.code.length > 0, string.concat(role, " must be a Safe on Base mainnet, not a single key"));
        try ISafeThreshold(who).getThreshold() returns (uint256 threshold) {
            require(threshold >= 2, string.concat(role, " Safe must require at least 2 signatures"));
        } catch {
            revert(string.concat(role, " is a contract but not a Safe"));
        }
    }
}
