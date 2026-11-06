import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { balanceSeconds, fillVolumes } from "./reward-accounting.mjs";
import { loyaltyProgress } from "./loyalty-accounting.mjs";

function integer(value) {
  if (typeof value !== "string" || !/^(0|[1-9][0-9]*)$/.test(value)) throw new Error("Snapshot integers must be decimal strings");
  return BigInt(value);
}
function address(value) {
  if (typeof value !== "string" || !/^0x[0-9a-fA-F]{40}$/.test(value)) throw new Error("Invalid snapshot address");
  return value.toLowerCase();
}

// This verifies arithmetic and input consistency, not canonical chain provenance.
export function replaySnapshot(source) {
  const input = JSON.parse(source);
  if (input.schema !== "erodoro-accounting-input/v1") throw new Error("Unsupported snapshot schema");
  const chainId = integer(input.chainId);
  if (chainId === 0n) throw new Error("Invalid chain id");
  const start = integer(input.start), end = integer(input.end);
  if (end <= start) throw new Error("Invalid accounting window");
  const fromBlock = integer(input.fromBlock), toBlock = integer(input.toBlock);
  if (toBlock < fromBlock) throw new Error("Invalid block range");
  if (!/^0x[0-9a-fA-F]{64}$/.test(input.toBlockHash ?? "")) throw new Error("Missing coverage block hash");
  const vault = address(input.vault), rfq = address(input.rfq);
  const claims = new Set();
  const inRange = (event) => {
    const block = integer(event.block);
    if (block < fromBlock || block > toBlock) throw new Error("Event outside covered blocks");
    return block;
  };
  const ownership = input.claims.map((claim) => {
    const claimId = integer(claim.claimId);
    if (claims.has(claimId)) throw new Error("Duplicate claim snapshot");
    claims.add(claimId);
    return { claimId, rows: balanceSeconds({
      start, end,
      openingBalances: claim.openingBalances.map(([owner, amount]) => [owner, integer(amount)]),
      transfers: claim.transfers.map((event) => ({ ...event, block: inRange(event), timestamp: integer(event.timestamp), amount: integer(event.amount) })),
    }) };
  });
  const fills = input.fills.map((fill) => {
    const timestamp = integer(fill.timestamp);
    if (timestamp < start || timestamp >= end) throw new Error("Fill outside accounting window");
    return { ...fill, block: inRange(fill), quoteAmount: integer(fill.quoteAmount) };
  });
  let loyalty = null;
  if (input.loyalty !== undefined) {
    if (typeof input.loyalty.policyId !== "string" || !input.loyalty.policyId.trim()) throw new Error("Missing loyalty policy id");
    const asOf = integer(input.loyalty.asOf);
    if (asOf < start || asOf >= end) throw new Error("Loyalty observation outside accounting window");
    loyalty = {
      policyId: input.loyalty.policyId,
      asOf,
      provenance: "Qualifying completions supplied by snapshot author; eligibility not verified",
      rows: loyaltyProgress({
        asOf,
        schedule: input.loyalty.schedule.map((entry) => ({ ...entry, maturity: integer(entry.maturity) })),
        milestones: input.loyalty.milestones,
        completions: input.loyalty.completions,
      }),
    };
  }
  const result = {
    schema: "erodoro-accounting-output/v1",
    inputSha256: createHash("sha256").update(source).digest("hex"),
    coverage: { chainId, vault, rfq, start, end, fromBlock, toBlock, toBlockHash: input.toBlockHash },
    provenance: "Unverified input snapshot; no RPC verification performed",
    pointsActive: false,
    ownership,
    fillVolumes: fillVolumes(fills),
    loyalty,
  };
  return JSON.parse(JSON.stringify(result, (_, value) => typeof value === "bigint" ? value.toString() : value));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    if (process.argv.length !== 3) throw new Error("Usage: node cloudflare/reward-replay.mjs snapshot.json");
    process.stdout.write(`${JSON.stringify(replaySnapshot(readFileSync(process.argv[2], "utf8")), null, 2)}\n`);
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
