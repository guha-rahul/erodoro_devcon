// Checks a World ID proof with World's verify API and, if it holds, reports (wallet, nullifier) to Erodoro's
// HumanRegistry on Base Sepolia. The Rips pool and the Uniswap resale hook consult that registry, so no
// Erodoro server key decides who may buy Rips.
import {
  bytesToBase64,
  bytesToHex,
  consensusIdenticalAggregation,
  decodeJson,
  EVMClient,
  getNetwork,
  handler,
  HTTPCapability,
  HTTPClient,
  json,
  ok,
  prepareReportRequest,
  Runner,
  TxStatus,
  type HTTPPayload,
  type HTTPSendRequester,
  type Runtime,
} from "@chainlink/cre-sdk";
import { encodeAbiParameters, isAddress, keccak256, parseAbiParameters, type Address } from "viem";
import { z } from "zod";

const configSchema = z.object({
  worldVerifyUrl: z.string(),
  rpId: z.string(),
  action: z.string(),
  environment: z.enum(["production", "staging"]),
  writeChain: z.string(),
  registry: z.string(),
  gasLimit: z.string(),
});
type Config = z.infer<typeof configSchema>;

type ProofItem = { identifier?: string; issuer_schema_id?: number; nullifier?: string; signal_hash?: string };
type IDKitResult = {
  protocol_version?: string;
  action?: string;
  environment?: string;
  responses?: ProofItem[];
  [key: string]: unknown;
};
type Input = { wallet: string; idkit: IDKitResult };
// Only deterministic fields, so every node agrees: World's `message` changes when a nullifier is reused.
type Verdict = { success: boolean; nullifier: string; action: string; environment: string; protocolVersion: string };

// World hashes an 0x address signal as its raw 20 bytes: keccak256(bytes) >> 8.
const hashSignal = (wallet: Address) => BigInt(keccak256(wallet)) >> 8n;

// Rejects proofs that World's API would accept but Erodoro must not: another action or environment,
// a weaker credential, or a proof made for a different wallet.
function checkProof(config: Config, wallet: Address, result: IDKitResult): string | null {
  if (result.environment !== config.environment) return "environment_mismatch";
  if (result.protocol_version !== "4.0" || result.action !== config.action) return "wrong_request";
  const issuers = config.environment === "production" ? [1] : [1, 128];
  const expected = hashSignal(wallet);
  if (!result.responses?.length) return "no_proof";
  for (const item of result.responses) {
    if (!item.nullifier) return "not_uniqueness_proof";
    if (item.identifier !== "proof_of_human" || !issuers.includes(item.issuer_schema_id ?? -1)) return "wrong_credential";
    if (!item.signal_hash || BigInt(item.signal_hash) !== expected) return "signal_mismatch";
  }
  return null;
}

const callWorld = (sendRequester: HTTPSendRequester, url: string, body: string): Verdict => {
  const response = sendRequester
    .sendRequest({
      url,
      method: "POST",
      body,
      multiHeaders: { "Content-Type": { values: ["application/json"] } },
      timeout: "10s",
      // Only one node needs to call World; the others reuse its answer.
      cacheSettings: { store: true, maxAge: "60s" },
    })
    .result();
  const fail = { success: false, nullifier: "0x0", action: "", environment: "", protocolVersion: "" };
  if (!ok(response)) return fail;
  const body_ = json(response) as {
    success?: boolean;
    nullifier?: string;
    action?: string;
    environment?: string;
    protocol_version?: string;
  };
  if (body_.success !== true || !body_.nullifier) return fail;
  return {
    success: true,
    nullifier: body_.nullifier,
    action: body_.action ?? "",
    environment: body_.environment ?? "",
    protocolVersion: body_.protocol_version ?? "",
  };
};

const onHttp = (runtime: Runtime<Config>, payload: HTTPPayload): string => {
  const config = runtime.config;
  const input = decodeJson(payload.input) as Input;
  if (!isAddress(input.wallet)) throw new Error("bad_wallet");
  const wallet = input.wallet as Address;

  const problem = checkProof(config, wallet, input.idkit);
  if (problem) {
    runtime.log(`rejected before World: ${problem}`);
    return `rejected:${problem}`;
  }

  const body = bytesToBase64(
    new TextEncoder().encode(
      JSON.stringify({ ...input.idkit, environment: config.environment, min_protocol_version: "4.0" }),
    ),
  );
  // World's API can take longer than CRE's 10-second HTTP limit; retry a timed-out call twice.
  let verdict: Verdict | undefined;
  for (let attempt = 1; !verdict; attempt++) {
    try {
      verdict = new HTTPClient()
        .sendRequest(runtime, callWorld, consensusIdenticalAggregation<Verdict>())(`${config.worldVerifyUrl}${config.rpId}`, body)
        .result();
    } catch (e) {
      if (attempt >= 3) throw e;
      runtime.log(`World verify attempt ${attempt} failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  if (
    !verdict.success ||
    verdict.action !== config.action ||
    verdict.environment !== config.environment ||
    verdict.protocolVersion !== "4.0"
  ) {
    runtime.log("rejected by World ID verification");
    return "rejected:verification_failed";
  }

  const encoded = encodeAbiParameters(parseAbiParameters("address wallet, uint256 nullifier"), [
    wallet,
    BigInt(verdict.nullifier),
  ]);
  const report = runtime.report(prepareReportRequest(encoded)).result();
  const network = getNetwork({ chainFamily: "evm", chainSelectorName: config.writeChain });
  if (!network) throw new Error(`unknown chain ${config.writeChain}`);
  const write = new EVMClient(network.chainSelector.selector)
    .writeReport(runtime, { receiver: config.registry, report, gasConfig: { gasLimit: config.gasLimit } })
    .result();
  if (write.txStatus !== TxStatus.SUCCESS) throw new Error(`write failed: ${write.txStatus} ${write.errorMessage ?? ""}`);
  const txHash = bytesToHex(write.txHash ?? new Uint8Array(32));
  runtime.log(`allowlisted ${wallet} in ${txHash}`);
  return `allowlisted:${txHash}`;
};

// An empty trigger config is accepted in simulation; a deployed workflow lists authorized signing keys.
const initWorkflow = (_config: Config) => [handler(new HTTPCapability().trigger({}), onHttp)];

export async function main() {
  const runner = await Runner.newRunner<Config>({ configSchema });
  await runner.run(initWorkflow);
}

main();
