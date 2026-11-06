/**
 * Copies the public addresses of the ETHGlobal Mumbai additions (World ID registry, Chainlink CRE settlement
 * oracle, Uniswap v4 resale hook and pools) from a Base Sepolia fixture manifest into the app.
 * Usage: RIP_TEST_MANIFEST=~/.config/erodoro/ethglobal-fixture.json node scripts/sync-ethglobal.mjs
 * The manifest holds no keys; only addresses and quote sizes are copied.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const manifestFile = process.env.RIP_TEST_MANIFEST;
if (!manifestFile) throw new Error("Set RIP_TEST_MANIFEST to the ETHGlobal fixture manifest.");
const m = JSON.parse(readFileSync(manifestFile, "utf8"));
if (m.chainId !== 84532 || !m.registry || !m.oracle || !m.hook) throw new Error("Run ethglobal-sepolia.mjs deploy first.");

const resale = {};
for (const [positionId, r] of Object.entries(m.resale ?? {})) {
  resale[positionId] = { claimId: r.claimId, seriesId: r.seriesId, wrapper: r.wrapper, currency0: r.currency0, currency1: r.currency1, unitsPerDollar: r.unitsPerDollar };
}
const out = {
  chainId: 84532,
  pool: m.pool,
  poolDeployBlock: m.poolDeployBlock,
  put: m.put,
  registry: m.registry,
  oracle: m.oracle,
  hook: m.hook,
  uniswap: m.uniswap,
  resale,
};
const dest = join(dirname(fileURLToPath(import.meta.url)), "..", "lib", "rips", "ethglobal-deployment.json");
writeFileSync(dest, `${JSON.stringify(out, null, 2)}\n`);
console.log(`Wrote ${dest}: pool ${m.pool}, ${Object.keys(resale).length} resale pools`);
