// Capture the landing page's product shots from the built export.
//
// A landing page that shows a mockup is making a claim it stops honouring the
// first time the interface changes. These come from the real build, against
// real Base Sepolia state, so they are the actual product at this commit.
//
//   NEXT_PUBLIC_RPC_URL=https://sepolia.base.org pnpm build
//   node scripts/capture-showcase.mjs
//
// The env var matters. `lib/chain.ts` sends browser reads to `/rpc`, which is
// a Cloudflare Worker route and does not exist under a plain static server —
// without it every screen captures its empty state, which is a worse landing
// page than no screenshots at all.
//
// Run it after a change that alters either surface, and commit the result.
// `components/showcase.tsx` renders nothing until both files exist, so a
// missing capture degrades to a shorter page rather than a broken one.

import fs from "node:fs";
import http from "node:http";
import path from "node:path";

const app = path.resolve(import.meta.dirname, "..");
const OUT = path.join(app, "public", "showcase");
const DIR = path.join(app, "out");
const PORT = 4331;
const BASE = `http://localhost:${PORT}`;

let chromium;
try {
  ({ chromium } = await import("playwright"));
} catch {
  console.error(
    "playwright is not installed, and this script cannot capture without it.\n" +
      "It is deliberately not a dependency of this app — the browser download is\n" +
      "large and nothing else here needs it. To enable the captures:\n\n" +
      "  pnpm add -D playwright && pnpm exec playwright install chromium\n",
  );
  process.exit(1);
}

if (!fs.existsSync(path.join(DIR, "index.html"))) {
  console.error(`No build at ${path.relative(process.cwd(), DIR)}. Run \`pnpm build\` first.`);
  process.exit(1);
}

const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".avif": "image/avif",
  ".woff2": "font/woff2",
  ".ico": "image/x-icon",
};

/** Serves `out/` the way the asset binding does: try the path, then `.html`. */
const server = http.createServer((req, res) => {
  const url = new URL(req.url, BASE);
  const candidates = [
    path.join(DIR, url.pathname),
    path.join(DIR, `${url.pathname}.html`),
    path.join(DIR, url.pathname, "index.html"),
  ];
  const file = candidates.find((c) => c.startsWith(DIR) && fs.existsSync(c) && fs.statSync(c).isFile());
  if (!file) {
    res.writeHead(404).end("not found");
    return;
  }
  res.writeHead(200, { "content-type": TYPES[path.extname(file)] ?? "application/octet-stream" });
  fs.createReadStream(file).pipe(res);
});
await new Promise((resolve) => server.listen(PORT, resolve));

fs.mkdirSync(OUT, { recursive: true });
const browser = await chromium.launch();

/**
 * Shots are taken at 2x on a wide viewport and cropped to the top of the
 * document. The panel that displays them clips the bottom anyway, so capturing
 * a full page would only be pixels nobody sees.
 */
async function shoot(name, route, settleMs = 2_500) {
  const context = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    deviceScaleFactor: 2,
    colorScheme: "light",
  });
  await context.addInitScript(() => {
    try {
      // The guide would otherwise offer itself over the shot.
      localStorage.setItem("erodoro:tour-seen", "1");
      localStorage.setItem("erodoro.theme", "light");
    } catch {
      /* a private context just gets the defaults */
    }
  });

  const page = await context.newPage();
  await page.goto(`${BASE}${route}`, { waitUntil: "domcontentloaded" });
  // Long enough for the contract reads to land and the table to stop being a
  // row of skeletons.
  await page.waitForTimeout(settleMs);

  const file = path.join(OUT, `${name}.png`);
  await page.screenshot({ path: file, clip: { x: 0, y: 0, width: 1440, height: 856 } });
  await context.close();
  const kb = Math.round(fs.statSync(file).size / 1024);
  console.log(`  ${name.padEnd(10)} ${String(kb).padStart(5)} KB`);
}

console.log("capturing:");
await shoot("markets", "/app");
await shoot("portfolio", "/portfolio");

await browser.close();
server.close();
console.log(`wrote ${path.relative(process.cwd(), OUT)}`);
