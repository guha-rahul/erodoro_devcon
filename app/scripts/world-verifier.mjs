/**
 * World ID verifier for the Rips app. The app is a static export with no server code, and the Chainlink CRE
 * simulation needs the `cre` CLI, so this small server runs next to it:
 *   POST /rp-context  signs a fresh IDKit request context (the RP signing key never reaches the browser).
 *   POST /verify      checks a proof is for this action, Proof of Human and the caller's wallet, then runs the CRE
 *                     `verify-human` workflow, which asks World's API and reports (wallet, nullifier) to
 *                     HumanRegistry on Base Sepolia. A deployed workflow would be called over HTTP instead.
 * env: WLD_RP_SIGNING_KEY, NEXT_PUBLIC_WLD_APP_ID, NEXT_PUBLIC_WLD_ACTION (buy-rips), NEXT_PUBLIC_WLD_ENV (staging),
 *      WORLD_VERIFIER_PORT (8790), APP_ORIGIN (http://localhost:3300), CRE_PROJECT_DIR (../cre), CRE_BIN (cre),
 *      NEXT_PUBLIC_RPC_URL.
 */
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import http from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { hashSignal } from "@worldcoin/idkit/hashing";
import { signRequest } from "@worldcoin/idkit/signing";
import { createPublicClient, http as httpTransport, isAddress, parseAbi } from "viem";
import { baseSepolia } from "viem/chains";

const here = path.dirname(fileURLToPath(import.meta.url));
try { process.loadEnvFile(path.join(here, "..", ".env.local")); } catch (error) { if (error.code !== "ENOENT") throw error; }
const deployment = JSON.parse(await readFile(path.join(here, "..", "lib", "rips", "ethglobal-deployment.json"), "utf8"));
const port = Number(process.env.WORLD_VERIFIER_PORT ?? 8790);
const origin = process.env.APP_ORIGIN ?? "http://localhost:3300";
const action = process.env.NEXT_PUBLIC_WLD_ACTION ?? "buy-rips";
const environment = process.env.NEXT_PUBLIC_WLD_ENV ?? "staging";
const creProject = path.resolve(process.env.CRE_PROJECT_DIR ?? path.join(here, "..", "..", "cre"));
const creBin = process.env.CRE_BIN ?? "cre";
// Proof of Human. Staging also accepts World's test issuer, 128; production never does.
const issuers = environment === "production" ? [1] : [1, 128];
const client = createPublicClient({ chain: baseSepolia, transport: httpTransport(process.env.NEXT_PUBLIC_RPC_URL ?? "https://sepolia.base.org") });
const registryAbi = parseAbi(["function isVerified(address wallet) view returns (bool)"]);

/** What IDKit can't enforce by itself: our action and environment, Proof of Human, and this wallet as the signal. */
function checkProof(wallet, result) {
  if (!isAddress(wallet)) return "bad_wallet";
  if (result?.environment !== environment) return "environment_mismatch";
  if (result.protocol_version !== "4.0" || result.action !== action) return "wrong_request";
  const items = result.responses;
  if (!items?.length) return "no_proof";
  const expected = BigInt(hashSignal(wallet));
  for (const item of items) {
    if (!item.nullifier) return "not_uniqueness_proof";
    if (item.identifier !== "proof_of_human" || !issuers.includes(item.issuer_schema_id ?? -1)) return "wrong_credential";
    if (!item.signal_hash || BigInt(item.signal_hash) !== expected) return "signal_mismatch";
  }
  return null;
}

/** Runs the workflow in simulation with a real Base Sepolia broadcast: "allowlisted:<tx>" or "rejected:<reason>". */
async function runVerifyWorkflow(wallet, idkit) {
  const dir = await mkdtemp(path.join(tmpdir(), "rips-cre-"));
  const payload = path.join(dir, "payload.json");
  try {
    await writeFile(payload, JSON.stringify({ wallet, idkit }));
    const output = await new Promise((resolve, reject) => {
      execFile(creBin, ["workflow", "simulate", "verify-human", "--target", process.env.CRE_TARGET ?? "staging-settings",
        "--non-interactive", "--trigger-index", "0", "--http-payload", payload, "--broadcast"],
      { cwd: creProject, timeout: 110_000, maxBuffer: 4 * 1024 * 1024 },
      (error, stdout, stderr) => error ? reject(new Error(`cre simulate failed: ${`${stdout}\n${stderr}`.slice(-1500)}`)) : resolve(`${stdout}\n${stderr}`));
    });
    const match = output.match(/(allowlisted:0x[0-9a-fA-F]{64}|rejected:[a-z_]+)/);
    if (!match) throw new Error(`no workflow result: ${output.slice(-1500)}`);
    return match[1];
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

async function body(req) {
  let raw = "";
  for await (const chunk of req) { raw += chunk; if (raw.length > 1_000_000) throw new Error("too large"); }
  return raw ? JSON.parse(raw) : {};
}

const server = http.createServer(async (req, res) => {
  const send = (status, data) => {
    res.writeHead(status, { "content-type": "application/json", "access-control-allow-origin": origin, "access-control-allow-headers": "content-type" });
    res.end(JSON.stringify(data));
  };
  if (req.method === "OPTIONS") return send(204, {});
  if (req.headers.origin && req.headers.origin !== origin) return send(403, { code: "forbidden_origin" });
  try {
    if (req.method === "POST" && req.url === "/rp-context") {
      const signingKeyHex = process.env.WLD_RP_SIGNING_KEY;
      if (!signingKeyHex) return send(500, { code: "rp_not_configured" });
      const { sig, nonce, createdAt, expiresAt } = signRequest({ signingKeyHex, action, ttl: 300 });
      return send(200, { sig, nonce, created_at: createdAt, expires_at: expiresAt });
    }
    if (req.method === "POST" && req.url === "/verify") {
      const { wallet, idkitResponse } = await body(req);
      const problem = checkProof(wallet, idkitResponse);
      if (problem) return send(400, { code: problem });
      const outcome = await runVerifyWorkflow(wallet, idkitResponse);
      if (outcome.startsWith("rejected:")) return send(400, { code: outcome.slice("rejected:".length) });
      // The simulation forwarder doesn't revert when the registry rejects a report, so read the result back.
      const verified = await client.readContract({ address: deployment.registry, abi: registryAbi, functionName: "isVerified", args: [wallet] });
      if (!verified) return send(409, { code: "not_recorded" });
      return send(200, { ok: true, tx: outcome.slice("allowlisted:".length) });
    }
    send(404, { code: "not_found" });
  } catch (e) {
    console.error(new Date().toISOString(), e instanceof Error ? e.message : e);
    send(502, { code: "verification_failed" });
  }
});
server.listen(port, () => console.log(`World ID verifier on http://localhost:${port} (app origin ${origin}, CRE project ${creProject})`));
