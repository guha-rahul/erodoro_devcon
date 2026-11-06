// SPDX-License-Identifier: Apache-2.0
pragma solidity 0.8.28;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {IERC165} from "@openzeppelin/contracts/utils/introspection/IERC165.sol";

/// @notice Interface the Chainlink CRE forwarder calls with a DON-signed workflow report.
interface IReceiver is IERC165 {
    function onReport(bytes calldata metadata, bytes calldata report) external;
}

/// @notice Accepts reports only from the configured Chainlink CRE forwarder.
/// @dev The forwarder differs between `cre workflow simulate` (MockKeystoneForwarder) and the live DON
///      (KeystoneForwarder), so the owner can switch it. The mock forwarder relays reports from anyone without
///      checking signatures, so while it is in use `simulationSender` pins the account that runs the
///      simulation. Set it to zero with the live forwarder, which verifies the DON's signatures itself.
abstract contract CreReceiver is IReceiver, Ownable {
    address public forwarder;
    address public simulationSender;

    event ForwarderSet(address forwarder, address simulationSender);

    error NotForwarder(address caller);
    error NotSimulationSender(address origin);

    constructor(address forwarder_, address simulationSender_) {
        forwarder = forwarder_;
        simulationSender = simulationSender_;
        emit ForwarderSet(forwarder_, simulationSender_);
    }

    function setForwarder(address forwarder_, address simulationSender_) external onlyOwner {
        forwarder = forwarder_;
        simulationSender = simulationSender_;
        emit ForwarderSet(forwarder_, simulationSender_);
    }

    function onReport(bytes calldata, bytes calldata report) external {
        if (msg.sender != forwarder) revert NotForwarder(msg.sender);
        // solhint-disable-next-line avoid-tx-origin
        if (simulationSender != address(0) && tx.origin != simulationSender) revert NotSimulationSender(tx.origin);
        _processReport(report);
    }

    function supportsInterface(bytes4 interfaceId) public view virtual returns (bool) {
        return interfaceId == type(IReceiver).interfaceId || interfaceId == type(IERC165).interfaceId;
    }

    function _processReport(bytes calldata report) internal virtual;
}
