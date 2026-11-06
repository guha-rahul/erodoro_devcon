import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import ts from "typescript";

// Exercise the real hooks with controlled clock and query snapshots.
let now = 1000n;
let results = [];
const exports = {};
const source = fs.readFileSync(new URL("../lib/use-market-rows.ts", import.meta.url), "utf8");
const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
vm.runInNewContext(compiled, { exports, require(name) {
  if (name === "@tanstack/react-query") return { useQueries: () => results };
  if (name === "./use-now") return { useNow: () => now };
  if (name === "./hermes") return { printToUsd: (p) => Number(p.price) * 10 ** p.expo };
  if (name === "./deployment") return { DEPLOYMENT: { contracts: { vault: "0x1" }, quote: {} } };
  return {};
} });
const series = { id: 2n, config: { feedId: "feed", collateral: "token", settlementModel: 0, maxPriceLag: 60n, maxConfBps: 100, maturity: 2000n } };
const print = { publishTime: 950, price: 10000n, conf: 10n, expo: -2 };
results = [{ data: print }];
assert.equal(exports.useReferencePrices([series]).spotFor(series), 100);
now = 1011n;
assert.equal(exports.useReferencePrices([series]).spotFor(series), null);
now = 1000n;
for (const patch of [{ publishTime: 1001 }, { price: 0n }, { conf: 101n }]) {
  results = [{ data: { ...print, ...patch } }];
  assert.equal(exports.useReferencePrices([series]).spotFor(series), null);
}
results = [{ data: print, isError: true }];
assert.equal(exports.useReferencePrices([series]).spotFor(series), null);
results = [{ data: print }];
assert.equal(exports.useReferencePrices([series]).spotFor({ ...series, config: { ...series.config, settlementModel: 1 } }), null);
const bid = { premium: 1, expiry: 1001n };
results = [{ data: bid }];
assert.equal(exports.useMarketPremiums([series]).bidFor(series), bid);
now = 1001n;
assert.equal(exports.useMarketPremiums([series]).bidFor(series), null);
assert.equal(exports.annualizedPremiumPct(series, bid, 100, now, 10n ** 18n), null);
now = 1000n;
results = [{ data: bid, isError: true }];
assert.equal(exports.useMarketPremiums([series]).bidFor(series), null);
console.log("Market freshness checks passed: aging, future timestamps, confidence, zero prices, refresh failures, feed model, expired bids.");
const adjusted = { ...series, config: { ...series.config, strike: 101n, priceDecimals: 0, multiplierAtCreation: 10n ** 18n } };
assert.equal(exports.effectiveStrikeUsd(adjusted, 2n * 10n ** 18n), 51);
assert.equal(exports.distanceToStrike(adjusted, 50, 2n * 10n ** 18n), 2);
assert.equal(exports.effectiveStrikeUsd(adjusted, null), null);
assert.equal(exports.effectiveStrikeUsd({ ...adjusted, settlement: { settled: true, effectiveStrike: 48n } }, null), 48);
console.log("Corporate-action display checks passed: ceiling rounding, strike distance, missing multiplier, frozen settlement.");
results = [{ data: 10n ** 18n }];
assert.equal(exports.useCollateralMultipliers([series]).multiplierFor(series), 10n ** 18n);
results = [{ data: 10n ** 18n, isError: true }];
assert.equal(exports.useCollateralMultipliers([series]).multiplierFor(series), null);
results = [{ data: 0n }];
assert.equal(exports.useCollateralMultipliers([series]).multiplierFor(series), null);
