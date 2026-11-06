// SPDX-License-Identifier: Apache-2.0
pragma solidity 0.8.28;

import {IB20} from "base-std/interfaces/IB20.sol";
import {TestQuoteToken} from "./TestQuoteToken.sol";

/// @title TestFaucet
/// @notice Hands out test collateral and test quote so anyone can try the flow.
///
/// @dev Without this, a test network is only usable by whoever holds the mint
///      role — which is one address, which is nobody.
///
///      The collateral it hands out is a **real B20 asset**, not a plain ERC-20
///      stand-in. That matters: the multiplier, the pause flag and the transfer
///      policies are the parts of this protocol most likely to be wrong, and a
///      simplified token would let all three go untested by the people trying it.
///
///      **Mainnet-hostile by construction.** The constructor refuses to deploy
///      on mainnet rather than relying on nobody making a mistake, and the mint
///      role it needs can be revoked by the token admin at any time.
contract TestFaucet {
    uint256 private constant BASE_MAINNET = 8453;

    IB20 public immutable stock;
    TestQuoteToken public immutable quote;
    uint256 public immutable stockAmount;
    uint256 public immutable quoteAmount;
    uint256 public immutable cooldown;

    mapping(address => uint256) public lastClaim;

    error NotForMainnet();
    error TooSoon(uint256 claimableAt);

    event Claimed(address indexed who, uint256 stockAmount, uint256 quoteAmount);

    constructor(IB20 stock_, TestQuoteToken quote_, uint256 stockAmount_, uint256 quoteAmount_, uint256 cooldown_) {
        if (block.chainid == BASE_MAINNET) revert NotForMainnet();
        stock = stock_;
        quote = quote_;
        stockAmount = stockAmount_;
        quoteAmount = quoteAmount_;
        cooldown = cooldown_;
    }

    /// @notice When this address may claim again. Zero means now.
    function claimableAt(address who) public view returns (uint256) {
        uint256 last = lastClaim[who];
        if (last == 0) return 0;
        uint256 next = last + cooldown;
        return next <= block.timestamp ? 0 : next;
    }

    /// @notice Mint one allocation of each to the caller.
    /// @dev Reverts with the exact timestamp rather than a bare "too soon", so
    ///      the interface can say when instead of asking the user to guess.
    function claim() external {
        uint256 at = claimableAt(msg.sender);
        if (at != 0) revert TooSoon(at);
        lastClaim[msg.sender] = block.timestamp;

        stock.mint(msg.sender, stockAmount);
        quote.mint(msg.sender, quoteAmount);

        emit Claimed(msg.sender, stockAmount, quoteAmount);
    }
}
