import { createPublicClient, http, parseAbi } from "viem";
import { readFile, writeFile, rename, mkdir } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

const abi = parseAbi(["event Filled(address indexed maker,address indexed taker,uint256 indexed claimId,uint256 claimAmount,address quoteToken,uint256 quoteAmount,uint256 nonce)"]);

export async function indexFills(client, { chainId, rfq, fromBlock, toBlock }, previous = null) {
  if (!/^0x[0-9a-fA-F]{40}$/.test(rfq) || fromBlock < 0n || toBlock < fromBlock) throw new Error("Invalid index scope");
  if (await client.getChainId() !== chainId) throw new Error("RPC chain does not match requested chain");
  let cursor = fromBlock;
  let events = [];
  if (previous) {
    if (previous.schema !== "erodoro-rfq-index/v1" || previous.chainId !== chainId || previous.rfq !== rfq.toLowerCase() || previous.fromBlock !== fromBlock.toString()) throw new Error("Index scope mismatch");
    const checkpoint = BigInt(previous.toBlock);
    if (checkpoint > toBlock) throw new Error("Requested range precedes checkpoint");
    if ((await client.getBlock({ blockNumber: checkpoint })).hash !== previous.toBlockHash) throw new Error("Checkpoint changed. Rebuild into a new index file.");
    cursor = checkpoint + 1n;
    events = [...previous.events];
  }
  const target = await client.getBlock({ blockNumber: toBlock });
  if (!target.hash) throw new Error("Target block is not mined");
  while (cursor <= toBlock) {
    const end = cursor + 1999n < toBlock ? cursor + 1999n : toBlock;
    const logs = await client.getContractEvents({ address: rfq, abi, eventName: "Filled", fromBlock: cursor, toBlock: end, strict: true });
    const blocks = new Map();
    for (const log of logs) {
      if (log.removed || log.blockNumber < cursor || log.blockNumber > end) throw new Error("Noncanonical or out-of-range log");
      let block = blocks.get(log.blockNumber);
      if (!block) { block = await client.getBlock({ blockNumber: log.blockNumber }); blocks.set(log.blockNumber, block); }
      if (block.hash !== log.blockHash) throw new Error("Log block changed during indexing");
      events.push({ block: log.blockNumber.toString(), blockHash: log.blockHash, timestamp: block.timestamp.toString(),
        transactionHash: log.transactionHash, logIndex: log.logIndex,
        ...Object.fromEntries(Object.entries(log.args).map(([key, value]) => [key, typeof value === "bigint" ? value.toString() : value])),
      });
    }
    cursor = end + 1n;
  }
  if ((await client.getBlock({ blockNumber: toBlock })).hash !== target.hash) throw new Error("Chain changed during indexing; retry");
  const unique = new Map();
  for (const event of events) {
    const key = `${event.block}:${event.logIndex}`;
    if (unique.has(key) && JSON.stringify(unique.get(key)) !== JSON.stringify(event)) throw new Error("Conflicting indexed fill");
    unique.set(key, event);
  }
  return { schema: "erodoro-rfq-index/v1", chainId, rfq: rfq.toLowerCase(), fromBlock: fromBlock.toString(),
    toBlock: toBlock.toString(), toBlockHash: target.hash,
    provenance: "RPC logs checked against block hashes; coverage starts at the explicitly supplied block",
    events: [...unique.values()].sort((a, b) => BigInt(a.block) === BigInt(b.block) ? a.logIndex - b.logIndex : BigInt(a.block) < BigInt(b.block) ? -1 : 1),
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const [chain, rfq, from, to, filename] = process.argv.slice(2);
    if (!process.env.ERODORO_INDEX_RPC_URL || !filename || !/^[0-9]+$/.test(chain ?? "") || !/^[0-9]+$/.test(from ?? "") || !/^[0-9]+$/.test(to ?? "")) throw new Error("Set ERODORO_INDEX_RPC_URL; usage: node scripts/index-rfq.mjs CHAIN RFQ FROM_BLOCK TO_BLOCK FILE");
    let previous = null;
    try { previous = JSON.parse(await readFile(filename, "utf8")); } catch (error) { if (error.code !== "ENOENT") throw error; }
    const result = await indexFills(createPublicClient({ transport: http(process.env.ERODORO_INDEX_RPC_URL) }), { chainId: Number(chain), rfq, fromBlock: BigInt(from), toBlock: BigInt(to) }, previous);
    await mkdir(path.dirname(filename), { recursive: true });
    const temporary = `${filename}.${process.pid}.tmp`;
    await writeFile(temporary, `${JSON.stringify(result, null, 2)}\n`, { flag: "wx" });
    await rename(temporary, filename);
    console.log(`Indexed ${result.events.length} fills through block ${result.toBlock}.`);
  } catch {
    // Transport errors can contain authenticated URLs. Keep those out of logs.
    console.error("Indexing failed. Existing index was not replaced. Check scope, RPC access, and checkpoint consistency.");
    process.exitCode = 1;
  }
}
