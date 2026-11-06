import { createServer } from "node:http";
import { spawn } from "node:child_process";
import worker from "../../cloudflare/worker.mjs";
import { MAX_ACCESS_REQUESTS } from "../../cloudflare/access-requests.mjs";

try { process.loadEnvFile(".env.local"); } catch (error) { if (error.code !== "ENOENT") throw error; }

/** Minimal development-only D1 adapter for the access-request route. */
function createLocalAccessDb() {
  const usernames = new Map();
  return {
    exec: async () => {},
    prepare: () => {
      let values = [];
      const statement = {
        bind: (...next) => { values = next; return statement; },
        run: async () => {
          const [key, display, requestedAt] = values;
          const existing = usernames.get(key);
          if (!existing && usernames.size >= MAX_ACCESS_REQUESTS) return { meta: { changes: 0 } };
          usernames.set(key, {
            display,
            firstRequestedAt: existing?.firstRequestedAt ?? requestedAt,
            lastRequestedAt: requestedAt,
            requestCount: (existing?.requestCount ?? 0) + 1,
          });
          return { meta: { changes: 1 } };
        },
      };
      return statement;
    },
  };
}

const accessDb = createLocalAccessDb();
// LOCAL_API_PORT moves the shim off 8787 when another project's Worker has it.
const API_PORT = Number(process.env.LOCAL_API_PORT ?? 8787);

// Only local development. Secrets, if provided, stay in this process.
const server = createServer(async (incoming, outgoing) => {
  const origin = incoming.headers.origin;
  if (origin && !/^http:\/\/(localhost|127\.0\.0\.1):\d+$/.test(origin)) { outgoing.writeHead(403).end(); return; }
  if (origin) outgoing.setHeader("access-control-allow-origin", origin);
  outgoing.setHeader("access-control-allow-headers", "content-type");
  outgoing.setHeader("access-control-allow-methods", "GET, POST, OPTIONS");
  if (incoming.method === "OPTIONS") { outgoing.writeHead(204).end(); return; }
  try {
    const chunks = [];
    for await (const chunk of incoming) { chunks.push(chunk); if (chunks.reduce((n, c) => n + c.length, 0) > 1000000) throw new Error("Body too large"); }
    const response = await worker.fetch(new Request(`http://localhost:${API_PORT}${incoming.url}`, {
      method: incoming.method, headers: incoming.headers,
      ...(["GET", "HEAD"].includes(incoming.method) ? {} : { body: Buffer.concat(chunks) }),
    }), {
      BASE_MAINNET_RPC_URL: process.env.BASE_MAINNET_RPC_URL,
      // Stock quotes: the same key and pinned quote token the production Worker uses.
      ZEROX_API_KEY: process.env.ZEROX_API_KEY,
      ZEROX_USDC: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
      INTENT_ADDRESS: process.env.NEXT_PUBLIC_INTENT_ADDRESS ?? "0x8c63bbC4b077a73e67258A0F384186c316855Cd8",
      INTENT_CHAIN_ID: "84532",
      FAST_AUCTION_SECONDS: "600",
      SETTLEMENT_EXCLUSIVITY_SECONDS: "45",
      DISCOVERY_AUCTION_SECONDS: "600",
      AUCTION_STORE_FILE: "/tmp/erodoro-auction-store.json",
      ACCESS_DB: accessDb,
      ASSETS: { fetch: () => new Response("Not found", { status: 404 }) },
    });
    outgoing.writeHead(response.status, Object.fromEntries(response.headers));
    outgoing.end(Buffer.from(await response.arrayBuffer()));
  } catch { outgoing.writeHead(502, { "content-type": "application/json" }).end(JSON.stringify({ error: "Local API request failed" })); }
});
server.on("error", (error) => { console.error("Local API:", error.message); process.exit(1); });
server.listen(API_PORT, "127.0.0.1", () => {
  console.log(`Local stock catalog and read-only mainnet RPC: http://localhost:${API_PORT}`);
  const env = { ...process.env, NEXT_PUBLIC_SWAP_API: `http://localhost:${API_PORT}` };
  const next = spawn(process.execPath, ["node_modules/next/dist/bin/next", "dev", ...process.argv.slice(2)], { stdio: "inherit", env });
  for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => { next.kill(signal); server.close(); });
  next.on("exit", (code) => { server.close(); process.exit(code ?? 0); });
});
