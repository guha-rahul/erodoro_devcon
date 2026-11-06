// SPDX-License-Identifier: Apache-2.0
pragma solidity 0.8.28;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {CreReceiver} from "../cre/CreReceiver.sol";
import {IHumanGate} from "./IHumanGate.sol";

/// @title HumanRegistry
/// @notice One wallet per World ID verified human, and a per-human spending cap on each Rips batch.
///         A Chainlink CRE workflow checks the World ID proof against World's API and reports
///         (wallet, nullifier) here. The nullifier is the same for a human whichever wallet they use, so the
///         cap holds across wallets: Rips inventory is small, and one person can't sweep it with many wallets.
contract HumanRegistry is IHumanGate, CreReceiver {
    struct Human {
        uint256 nullifier;
        uint64 verifiedAt;
        uint64 expiresAt;
    }

    /// @notice How long a verification lasts before the user must verify again.
    uint64 public validity = 30 days;
    /// @notice USDC (6 decimals) one human may spend on each batch of each pool. Zero means no cap.
    uint256 public maxSpendPerBatch;

    mapping(address wallet => Human) public humans;
    mapping(uint256 nullifier => address wallet) public walletOf;
    /// @notice Humans removed by the owner. A banned nullifier can't verify any wallet again.
    mapping(uint256 nullifier => bool) public banned;
    mapping(address pool => bool) public isPool;
    mapping(uint256 nullifier => mapping(address pool => mapping(uint256 batchId => uint256))) public spent;
    /// @notice Optional backend key for when CRE isn't available. Zero disables it.
    address public attestor;

    event HumanVerified(address indexed wallet, uint256 indexed nullifier, uint64 expiresAt);
    event WalletRevoked(address indexed wallet, uint256 indexed nullifier);
    event HumanBanned(uint256 indexed nullifier);
    event PurchaseRecorded(
        address indexed buyer, uint256 indexed nullifier, address indexed pool, uint256 batchId, uint256 usdcAmount
    );
    event PoolSet(address indexed pool, bool allowed);
    event MaxSpendPerBatchSet(uint256 maxSpendPerBatch);
    event ValiditySet(uint64 validity);
    event AttestorSet(address attestor);

    error InvalidReport();
    error WalletBelongsToAnotherHuman(address wallet);
    error Banned(uint256 nullifier);
    error NotPool(address caller);
    error NotVerified(address buyer);
    error HumanCapReached(address buyer, uint256 remaining);
    error NotAttestor(address caller);

    constructor(address owner_, address forwarder_, address simulationSender_, uint256 maxSpendPerBatch_)
        Ownable(owner_)
        CreReceiver(forwarder_, simulationSender_)
    {
        maxSpendPerBatch = maxSpendPerBatch_;
        emit MaxSpendPerBatchSet(maxSpendPerBatch_);
    }

    function isVerified(address wallet) public view returns (bool) {
        return humans[wallet].expiresAt > block.timestamp;
    }

    /// @inheritdoc IHumanGate
    function recordPurchase(address buyer, uint256 batchId, uint256 usdcAmount) external {
        if (!isPool[msg.sender]) revert NotPool(msg.sender);
        if (!isVerified(buyer)) revert NotVerified(buyer);
        uint256 nullifier = humans[buyer].nullifier;
        uint256 total = spent[nullifier][msg.sender][batchId] + usdcAmount;
        uint256 cap = maxSpendPerBatch;
        if (cap != 0 && total > cap) revert HumanCapReached(buyer, cap - spent[nullifier][msg.sender][batchId]);
        spent[nullifier][msg.sender][batchId] = total;
        emit PurchaseRecorded(buyer, nullifier, msg.sender, batchId, usdcAmount);
    }

    /// @notice How much more `wallet`'s human may spend on `batchId` of `pool`.
    function remainingSpend(address wallet, address pool, uint256 batchId) external view returns (uint256) {
        if (!isVerified(wallet)) return 0;
        uint256 cap = maxSpendPerBatch;
        if (cap == 0) return type(uint256).max;
        uint256 used = spent[humans[wallet].nullifier][pool][batchId];
        return used >= cap ? 0 : cap - used;
    }

    function setPool(address pool, bool allowed) external onlyOwner {
        isPool[pool] = allowed;
        emit PoolSet(pool, allowed);
    }

    function setMaxSpendPerBatch(uint256 maxSpendPerBatch_) external onlyOwner {
        maxSpendPerBatch = maxSpendPerBatch_;
        emit MaxSpendPerBatchSet(maxSpendPerBatch_);
    }

    function setValidity(uint64 validity_) external onlyOwner {
        validity = validity_;
        emit ValiditySet(validity_);
    }

    function setAttestor(address attestor_) external onlyOwner {
        attestor = attestor_;
        emit AttestorSet(attestor_);
    }

    /// @notice Removes the human behind `wallet` for good: any wallet they verify later is refused too.
    function ban(address wallet) external onlyOwner {
        uint256 nullifier = humans[wallet].nullifier;
        if (nullifier == 0) revert NotVerified(wallet);
        banned[nullifier] = true;
        delete humans[wallet];
        delete walletOf[nullifier];
        emit WalletRevoked(wallet, nullifier);
        emit HumanBanned(nullifier);
    }

    /// @notice Fallback when CRE isn't available: a backend that verified the proof with World's API records it.
    function attest(address wallet, uint256 nullifier) external {
        if (msg.sender != attestor || attestor == address(0)) revert NotAttestor(msg.sender);
        _register(wallet, nullifier);
    }

    /// @dev Report: abi.encode(address wallet, uint256 nullifier).
    function _processReport(bytes calldata report) internal override {
        (address wallet, uint256 nullifier) = abi.decode(report, (address, uint256));
        _register(wallet, nullifier);
    }

    /// @dev A human who verifies a new wallet moves their access to it; the old wallet loses it.
    function _register(address wallet, uint256 nullifier) internal {
        if (wallet == address(0) || nullifier == 0) revert InvalidReport();
        if (banned[nullifier]) revert Banned(nullifier);
        uint256 current = humans[wallet].nullifier;
        if (current != 0 && current != nullifier) revert WalletBelongsToAnotherHuman(wallet);

        address previous = walletOf[nullifier];
        if (previous != address(0) && previous != wallet) {
            delete humans[previous];
            emit WalletRevoked(previous, nullifier);
        }

        uint64 expiresAt = uint64(block.timestamp) + validity;
        walletOf[nullifier] = wallet;
        humans[wallet] = Human({nullifier: nullifier, verifiedAt: uint64(block.timestamp), expiresAt: expiresAt});
        emit HumanVerified(wallet, nullifier, expiresAt);
    }
}
