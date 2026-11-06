// Reads Chainlink's Coinbase stock feeds on Base mainnet and reports the prices to Erodoro's
// CreSettlementOracle on Base Sepolia, where Rips series settle at the price in effect at maturity.
import {
  bytesToHex,
  CronCapability,
  encodeCallMsg,
  EVMClient,
  getNetwork,
  handler,
  LATEST_BLOCK_NUMBER,
  prepareReportRequest,
  Runner,
  TxStatus,
  type CronPayload,
  type Runtime,
} from "@chainlink/cre-sdk";
import {
  decodeFunctionResult,
  encodeAbiParameters,
  encodeFunctionData,
  parseAbi,
  keccak256,
  parseAbiParameters,
  toHex,
  zeroAddress,
  type Address,
} from "viem";
import { z } from "zod";

const configSchema = z.object({
  schedule: z.string(),
  readChain: z.string(),
  writeChain: z.string(),
  oracle: z.string(),
  gasLimit: z.string(),
  feeds: z.array(z.object({ ticker: z.string(), address: z.string() })),
});
type Config = z.infer<typeof configSchema>;

const aggregatorAbi = parseAbi([
  "function latestRoundData() view returns (uint80 roundId, int256 answer, uint256 startedAt, uint256 updatedAt, uint80 answeredInRound)",
]);

function evmClient(chainSelectorName: string) {
  const network = getNetwork({ chainFamily: "evm", chainSelectorName });
  if (!network) throw new Error(`unknown chain ${chainSelectorName}`);
  return new EVMClient(network.chainSelector.selector);
}

const onCron = (runtime: Runtime<Config>, _payload: CronPayload): string => {
  const config = runtime.config;
  const reader = evmClient(config.readChain);
  const feedIds: `0x${string}`[] = [];
  const answers: bigint[] = [];
  const updatedAts: bigint[] = [];

  // One read per feed: the simulator allows 15 chain reads per run. All the stock feeds use 8 decimals.
  for (const feed of config.feeds) {
    const reply = reader
      .callContract(runtime, {
        call: encodeCallMsg({
          from: zeroAddress,
          to: feed.address as Address,
          data: encodeFunctionData({ abi: aggregatorAbi, functionName: "latestRoundData" }),
        }),
        blockNumber: LATEST_BLOCK_NUMBER,
      })
      .result();
    const [, answer, , updatedAt] = decodeFunctionResult({
      abi: aggregatorAbi,
      functionName: "latestRoundData",
      data: bytesToHex(reply.data),
    });
    if (answer <= 0n) {
      runtime.log(`${feed.ticker}: skipped non-positive answer ${answer}`);
      continue;
    }
    runtime.log(`${feed.ticker}: ${answer} (updated ${updatedAt})`);
    // The feed ID Rips series are configured with (scripts/rips-sepolia.mjs, CRE batches).
    feedIds.push(keccak256(toHex(`chainlink:${feed.ticker}/USD`)));
    answers.push(answer);
    updatedAts.push(updatedAt);
  }

  const encoded = encodeAbiParameters(
    parseAbiParameters("bytes32[] feedIds, uint256[] prices, uint64[] feedUpdatedAts"),
    [feedIds, answers, updatedAts],
  );
  const report = runtime.report(prepareReportRequest(encoded)).result();
  const write = evmClient(config.writeChain)
    .writeReport(runtime, { receiver: config.oracle, report, gasConfig: { gasLimit: config.gasLimit } })
    .result();
  if (write.txStatus !== TxStatus.SUCCESS) throw new Error(`write failed: ${write.txStatus} ${write.errorMessage ?? ""}`);
  const txHash = bytesToHex(write.txHash ?? new Uint8Array(32));
  runtime.log(`reported ${feedIds.length} prices in ${txHash}`);
  return txHash;
};

const initWorkflow = (config: Config) => [handler(new CronCapability().trigger({ schedule: config.schedule }), onCron)];

export async function main() {
  const runner = await Runner.newRunner<Config>({ configSchema });
  await runner.run(initWorkflow);
}

main();
