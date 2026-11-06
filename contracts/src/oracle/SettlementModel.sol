// SPDX-License-Identifier: Apache-2.0
pragma solidity 0.8.28;

/// @notice The meaning of the price returned by a settlement adapter.
///
/// @dev The two modes exist so the same corporate action is never counted
///      twice. The names below are the canonical ones from the Phase 1 plan;
///      `RAW_SHARE`/`TOTAL_RETURN` are the historical member names, kept to
///      avoid a churn-only source change. The mapping is exact:
///
///      - `RAW_SHARE` = `RAW_UNDERLYING_PRICE`. The price is the underlying
///        share price and excludes the B20 multiplier, so settlement scales the
///        stored strike by the multiplier in force at the print
///        (`StrikeMath.effectiveStrike`).
///      - `TOTAL_RETURN` = `MULTIPLIER_ADJUSTED_TOKEN_PRICE`. The price already
///        includes the multiplier, so settlement keeps the stored strike. The
///        adapter must not apply the multiplier again.
///
///      A series stores its model at creation and rejects an adapter whose
///      `settlementModel()` disagrees, at creation and again at settlement.
enum SettlementModel {
    /// @dev = RAW_UNDERLYING_PRICE.
    RAW_SHARE,
    /// @dev = MULTIPLIER_ADJUSTED_TOKEN_PRICE.
    TOTAL_RETURN
}
