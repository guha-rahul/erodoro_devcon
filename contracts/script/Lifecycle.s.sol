// SPDX-License-Identifier: Apache-2.0
pragma solidity 0.8.28;

import {Script} from "forge-std/Script.sol";
import {console2} from "forge-std/console2.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IPyth} from "@pythnetwork/pyth-sdk-solidity/IPyth.sol";

import {ErodoroVault} from "../src/ErodoroVault.sol";
import {ErodoroRFQ} from "../src/ErodoroRFQ.sol";
import {IErodoroVault} from "../src/interfaces/IErodoroVault.sol";
import {TestFaucet} from "../src/periphery/TestFaucet.sol";

/// @title Lifecycle
/// @notice Drives one series end to end with separate pilot accounts.
///
/// @dev Invoked per step with `--sig`, because the steps are separated by real
///      time: a series cannot settle until it has matured, and no amount of
///      scripting compresses that.
///
///        base-forge script script/Lifecycle.s.sol --sig 'claimSeller()' ...
///        base-forge script script/Lifecycle.s.sol --sig 'claimMaker()' ...
///        base-forge script script/Lifecycle.s.sol --sig 'split(uint256)' <raw> ...
///        base-forge script script/Lifecycle.s.sol --sig 'prepareMaker()' ...
///        base-forge script script/Lifecycle.s.sol --sig 'sellN(uint256,uint256,uint256)' <claim> <quote> <ttl> ...
///        base-forge script script/Lifecycle.s.sol --sig 'settle(bytes)' <hermesUpdate> ...
///        base-forge script script/Lifecycle.s.sol --sig 'redeemP()' ...
///        base-forge script script/Lifecycle.s.sol --sig 'redeemN()' ...
///        base-forge script script/Lifecycle.s.sol --sig 'status()'
contract Lifecycle is Script {
    function _vault() internal view returns (ErodoroVault) {
        return ErodoroVault(vm.envAddress("VAULT_ADDRESS"));
    }

    function _seriesId() internal view returns (uint256) {
        return uint256(vm.envBytes32("SERIES_ID"));
    }

    function claimSeller() external {
        _claim("SELLER_PRIVATE_KEY", "SELLER_ADDRESS");
    }

    function claimMaker() external {
        _claim("MAKER_PRIVATE_KEY", "MAKER_ADDRESS");
    }

    function _claim(string memory keyName, string memory addressName) internal {
        (uint256 pk, address account) = _account(keyName, addressName);
        TestFaucet faucet = TestFaucet(vm.envAddress("FAUCET_ADDRESS"));
        _startBroadcast(pk);
        faucet.claim();
        vm.stopBroadcast();
        console2.log("claimed for", account);
    }

    /// @notice Lock collateral and mint equal P and N.
    function split(uint256 amount) external {
        (uint256 pk, address me) = _account("SELLER_PRIVATE_KEY", "SELLER_ADDRESS");
        ErodoroVault vault = _vault();
        uint256 id = _seriesId();
        IErodoroVault.SeriesConfig memory cfg = vault.seriesConfig(id);

        _startBroadcast(pk);
        IERC20(cfg.collateral).approve(address(vault), amount);
        vault.split(id, amount);
        vm.stopBroadcast();

        console2.log("split     ", amount);
        console2.log("P balance ", vault.balanceOf(me, vault.pId(id)));
        console2.log("N balance ", vault.balanceOf(me, vault.nId(id)));
        console2.log("locked    ", vault.lockedOf(id));
    }

    /// @notice The maker funds the atomic payment path once. Signing quotes
    ///         after this remains off-chain.
    function prepareMaker() external {
        (uint256 pk, address maker) = _account("MAKER_PRIVATE_KEY", "MAKER_ADDRESS");
        address rfq = vm.envAddress("RFQ_ADDRESS");
        IERC20 quoteToken = IERC20(vm.envAddress("QUOTE_TOKEN"));
        _startBroadcast(pk);
        quoteToken.approve(rfq, type(uint256).max);
        vm.stopBroadcast();
        console2.log("maker     ", maker);
        console2.log("quote funds", quoteToken.balanceOf(maker));
    }

    /// @notice Sign a firm N bid as the maker and atomically fill it as the seller.
    function sellN(uint256 claimAmount, uint256 quoteAmount, uint256 ttl) external {
        uint256 makerPk = vm.envUint("MAKER_PRIVATE_KEY");
        uint256 sellerPk = vm.envUint("SELLER_PRIVATE_KEY");
        ErodoroVault vault = _vault();
        ErodoroRFQ rfq = ErodoroRFQ(vm.envAddress("RFQ_ADDRESS"));
        ErodoroRFQ.Quote memory q = _quote(
            vault,
            vm.addr(makerPk),
            vm.addr(sellerPk),
            claimAmount,
            quoteAmount,
            block.timestamp + ttl,
            vm.envOr("QUOTE_NONCE", block.timestamp)
        );
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(makerPk, rfq.hashQuote(q));
        bytes memory signature = abi.encodePacked(r, s, v);

        vm.startBroadcast(sellerPk);
        vault.setOperator(address(rfq), true);
        rfq.fill(q, signature);
        vm.stopBroadcast();

        console2.log("N sold    ", claimAmount);
        console2.log("premium   ", quoteAmount);
        console2.log("maker N   ", vault.balanceOf(q.maker, q.claimId));
    }

    /// @notice Return the exact EIP-712 digest that an external maker signs.
    function quoteDigest(uint256 claimAmount, uint256 quoteAmount, uint256 expiry, uint256 nonce)
        external
        view
        returns (bytes32)
    {
        ErodoroVault vault = _vault();
        ErodoroRFQ rfq = ErodoroRFQ(vm.envAddress("RFQ_ADDRESS"));
        ErodoroRFQ.Quote memory q = _quote(
            vault,
            vm.envAddress("MAKER_ADDRESS"),
            vm.envAddress("SELLER_ADDRESS"),
            claimAmount,
            quoteAmount,
            expiry,
            nonce
        );
        return rfq.hashQuote(q);
    }

    /// @notice Fill an EIP-712 quote signed outside this script.
    function sellNSigned(
        uint256 claimAmount,
        uint256 quoteAmount,
        uint256 expiry,
        uint256 nonce,
        bytes calldata signature
    ) external {
        (uint256 sellerPk, address seller) = _account("SELLER_PRIVATE_KEY", "SELLER_ADDRESS");
        ErodoroVault vault = _vault();
        ErodoroRFQ rfq = ErodoroRFQ(vm.envAddress("RFQ_ADDRESS"));
        ErodoroRFQ.Quote memory q =
            _quote(vault, vm.envAddress("MAKER_ADDRESS"), seller, claimAmount, quoteAmount, expiry, nonce);

        _startBroadcast(sellerPk);
        vault.setOperator(address(rfq), true);
        rfq.fill(q, signature);
        vm.stopBroadcast();

        console2.log("N sold    ", claimAmount);
        console2.log("premium   ", quoteAmount);
        console2.log("maker N   ", vault.balanceOf(q.maker, q.claimId));
    }

    function _quote(
        ErodoroVault vault,
        address maker,
        address seller,
        uint256 claimAmount,
        uint256 quoteAmount,
        uint256 expiry,
        uint256 nonce
    ) internal view returns (ErodoroRFQ.Quote memory) {
        uint256 id = _seriesId();
        return ErodoroRFQ.Quote({
            maker: maker,
            taker: seller,
            claims: address(vault),
            claimId: vault.nId(id),
            claimAmount: claimAmount,
            quoteToken: vm.envAddress("QUOTE_TOKEN"),
            quoteAmount: quoteAmount,
            expiry: expiry,
            nonce: nonce
        });
    }

    /// @notice Settle against a signed Pyth update fetched from Hermes.
    /// @dev Payable in the sense that the caller funds the oracle fee — this is
    ///      the step with no counterpart on the chain this was ported from,
    ///      where settlement cost the caller nothing.
    function settle(bytes calldata update) external {
        (uint256 pk,) = _account("SETTLER_PRIVATE_KEY", "SETTLER_ADDRESS");
        ErodoroVault vault = _vault();
        uint256 id = _seriesId();

        bytes[] memory data = new bytes[](1);
        data[0] = update;

        IPyth pyth = IPyth(vm.envAddress("PYTH_ADDRESS"));
        uint256 fee = pyth.getUpdateFee(data);
        console2.log("oracle fee", fee);

        _startBroadcast(pk);
        vault.settle{value: fee}(id, data);
        vm.stopBroadcast();

        _printSettlement(vault, id);
    }

    function redeemP() external {
        _redeem("SELLER_PRIVATE_KEY", "SELLER_ADDRESS", true);
    }

    function redeemN() external {
        _redeem("MAKER_PRIVATE_KEY", "MAKER_ADDRESS", false);
    }

    /// @notice Redeem one claim side from its independent holder account.
    function _redeem(string memory keyName, string memory addressName, bool isP) internal {
        (uint256 pk, address me) = _account(keyName, addressName);
        ErodoroVault vault = _vault();
        uint256 id = _seriesId();
        IErodoroVault.SeriesConfig memory cfg = vault.seriesConfig(id);

        uint256 claim = vault.balanceOf(me, isP ? vault.pId(id) : vault.nId(id));
        uint256 before = IERC20(cfg.collateral).balanceOf(me);

        _startBroadcast(pk);
        if (claim > 0) vault.redeem(id, isP, claim);
        vm.stopBroadcast();

        uint256 got = IERC20(cfg.collateral).balanceOf(me) - before;
        console2.log(isP ? "redeemed P" : "redeemed N", claim);
        console2.log("collateral", got);
        console2.log("locked now", vault.lockedOf(id));
    }

    function _account(string memory keyName, string memory addressName)
        internal
        view
        returns (uint256 pk, address account)
    {
        pk = vm.envOr(keyName, uint256(0));
        account = pk == 0 ? vm.envAddress(addressName) : vm.addr(pk);
    }

    function _startBroadcast(uint256 pk) internal {
        if (pk == 0) vm.startBroadcast();
        else vm.startBroadcast(pk);
    }

    /// @notice Read-only: where the series stands.
    function status() external view {
        ErodoroVault vault = _vault();
        uint256 id = _seriesId();
        IErodoroVault.SeriesConfig memory cfg = vault.seriesConfig(id);

        console2.log("now       ", block.timestamp);
        console2.log("maturity  ", cfg.maturity);
        console2.log("settles at", uint256(cfg.maturity) + cfg.settlementDelay);
        console2.log("window end", uint256(cfg.maturity) + cfg.maxPriceLag);
        console2.log("locked    ", vault.lockedOf(id));
        _printSettlement(vault, id);
    }

    function _printSettlement(ErodoroVault vault, uint256 id) internal view {
        IErodoroVault.Settlement memory st = vault.settlementOf(id);
        if (!st.settled) {
            console2.log("settled   ", false);
            return;
        }
        console2.log("settled   ", true);
        console2.log("price     ", st.price);
        console2.log("eff strike", st.effectiveStrike);
        console2.log("P pool    ", st.pPool);
        console2.log("N pool    ", st.nPool);
        console2.log("shortfall ", st.shortfallObserved);
    }
}
