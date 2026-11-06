// SPDX-License-Identifier: Apache-2.0
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {RequireSafe} from "../../script/RequireSafe.sol";

contract FakeSafe {
    uint256 public getThreshold;
    constructor(uint256 t) { getThreshold = t; }
}

contract NotSafe {}

/// @dev External wrapper so `vm.expectRevert` sees the library's revert.
contract Checker {
    function check(address who) external view { RequireSafe.check(who, "OPERATOR"); }
}

contract RequireSafeTest is Test {
    Checker internal checker = new Checker();

    function test_anyAddressPassesOffMainnet() public {
        vm.chainId(84532);
        checker.check(address(0xBEEF));
    }

    function test_mainnetRefusesAKey() public {
        vm.chainId(8453);
        vm.expectRevert(bytes("OPERATOR must be a Safe on Base mainnet, not a single key"));
        checker.check(address(0xBEEF));
    }

    function test_mainnetRefusesOneSignatureSafe() public {
        vm.chainId(8453);
        address safe = address(new FakeSafe(1));
        vm.expectRevert(bytes("OPERATOR Safe must require at least 2 signatures"));
        checker.check(safe);
    }

    function test_mainnetRefusesOtherContracts() public {
        vm.chainId(8453);
        address other = address(new NotSafe());
        vm.expectRevert(bytes("OPERATOR is a contract but not a Safe"));
        checker.check(other);
    }

    function test_mainnetAcceptsTwoOfNSafe() public {
        vm.chainId(8453);
        checker.check(address(new FakeSafe(2)));
    }
}
