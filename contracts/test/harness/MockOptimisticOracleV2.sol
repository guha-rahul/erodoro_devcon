// SPDX-License-Identifier: Apache-2.0
pragma solidity 0.8.28;

import {IOptimisticOracleV2} from "../../src/oracle/IOptimisticOracleV2.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

contract MockOptimisticOracleV2 is IOptimisticOracleV2 {
    using SafeERC20 for IERC20;

    struct Request {
        address currency;
        uint256 bond;
        uint256 liveness;
        address proposer;
        address disputer;
        int256 proposedPrice;
        int256 resolvedPrice;
        bool ready;
    }

    mapping(bytes32 key => Request) public requests;

    function keyFor(address requester, bytes32 identifier, uint256 timestamp, bytes memory ancillaryData)
        public
        pure
        returns (bytes32)
    {
        return keccak256(abi.encode(requester, identifier, timestamp, ancillaryData));
    }

    function requestPrice(bytes32 identifier, uint256 timestamp, bytes memory ancillaryData, address currency, uint256)
        external
        returns (uint256)
    {
        requests[keyFor(msg.sender, identifier, timestamp, ancillaryData)].currency = currency;
        return 0;
    }

    function setBond(bytes32 identifier, uint256 timestamp, bytes memory ancillaryData, uint256 bond)
        external
        returns (uint256)
    {
        requests[keyFor(msg.sender, identifier, timestamp, ancillaryData)].bond = bond;
        return bond;
    }

    function setCustomLiveness(
        bytes32 identifier,
        uint256 timestamp,
        bytes memory ancillaryData,
        uint256 customLiveness
    ) external {
        requests[keyFor(msg.sender, identifier, timestamp, ancillaryData)].liveness = customLiveness;
    }

    function proposePriceFor(
        address proposer,
        address requester,
        bytes32 identifier,
        uint256 timestamp,
        bytes memory ancillaryData,
        int256 proposedPrice
    ) external returns (uint256) {
        Request storage request = requests[keyFor(requester, identifier, timestamp, ancillaryData)];
        IERC20(request.currency).safeTransferFrom(msg.sender, address(this), request.bond);
        request.proposer = proposer;
        request.proposedPrice = proposedPrice;
        return request.bond;
    }

    function disputePriceFor(
        address disputer,
        address requester,
        bytes32 identifier,
        uint256 timestamp,
        bytes memory ancillaryData
    ) external returns (uint256) {
        Request storage request = requests[keyFor(requester, identifier, timestamp, ancillaryData)];
        IERC20(request.currency).safeTransferFrom(msg.sender, address(this), request.bond);
        request.disputer = disputer;
        return request.bond;
    }

    function hasPrice(address requester, bytes32 identifier, uint256 timestamp, bytes memory ancillaryData)
        external
        view
        returns (bool)
    {
        return requests[keyFor(requester, identifier, timestamp, ancillaryData)].ready;
    }

    function settleAndGetPrice(bytes32 identifier, uint256 timestamp, bytes memory ancillaryData)
        external
        returns (int256)
    {
        Request storage request = requests[keyFor(msg.sender, identifier, timestamp, ancillaryData)];
        require(request.ready, "not ready");
        return request.resolvedPrice;
    }

    function resolve(
        address requester,
        bytes32 identifier,
        uint256 timestamp,
        bytes memory ancillaryData,
        int256 resolvedPrice
    ) external {
        Request storage request = requests[keyFor(requester, identifier, timestamp, ancillaryData)];
        request.resolvedPrice = resolvedPrice;
        request.ready = true;
    }
}
