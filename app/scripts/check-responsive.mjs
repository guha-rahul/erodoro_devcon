// Responsive smoke test for the built static application.
//
// This deliberately uses the installed system Chrome through playwright-core.
// It does not download another browser, and it tests the exported files rather
// than a development server with different routing behavior.

import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { chromium } from "playwright-core";

const app = path.resolve(import.meta.dirname, "..");
const output = path.join(app, "out");
const host = "127.0.0.1";
const port = 4332;
const base = `http://${host}:${port}`;

const chromeCandidates = [
  process.env.CHROME_PATH,
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/Applications/Chromium.app/Contents/MacOS/Chromium",
  "/usr/bin/google-chrome",
  "/usr/bin/chromium",
  "/usr/bin/chromium-browser",
].filter(Boolean);
const executablePath = chromeCandidates.find((candidate) => fs.existsSync(candidate));

if (!executablePath) {
  console.error("No Chrome/Chromium executable found. Set CHROME_PATH to run responsive checks.");
  process.exit(1);
}
if (!fs.existsSync(path.join(output, "index.html"))) {
  console.error("No static export found. Run `pnpm build` before `pnpm check:responsive`.");
  process.exit(1);
}

const contentTypes = {
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

const server = http.createServer((request, response) => {
  const url = new URL(request.url, base);
  const pathname = decodeURIComponent(url.pathname);
  const candidates = [
    path.join(output, pathname),
    path.join(output, `${pathname}.html`),
    path.join(output, pathname, "index.html"),
  ];
  const file = candidates.find(
    (candidate) =>
      candidate.startsWith(output) && fs.existsSync(candidate) && fs.statSync(candidate).isFile(),
  );
  if (!file) {
    response.writeHead(404).end("not found");
    return;
  }
  response.writeHead(200, {
    "content-type": contentTypes[path.extname(file)] ?? "application/octet-stream",
  });
  fs.createReadStream(file).pipe(response);
});

await new Promise((resolve, reject) => {
  server.once("error", reject);
  server.listen(port, host, resolve);
});

const browser = await chromium.launch({ executablePath, headless: true });
const widths = [375, 390, 430, 768, 1440];
const routes = ["/", "/earn", "/app", "/auctions", "/portfolio", "/rewards", "/market-rip", "/rips", "/rips/position", "/rips/sell"];
const failures = [];

try {
  for (const width of widths) {
    for (const route of routes) {
      const page = await browser.newPage({ viewport: { width, height: 1000 } });
      await page.addInitScript(() => {
        localStorage.setItem("erodoro:tour-seen", "1");
        localStorage.setItem("erodoro.theme", "light");
      });
      // Wallet SDKs keep background requests alive. Layout needs the loaded
      // document and fonts, rather than an idle network connection.
      await page.goto(`${base}${route}`, { waitUntil: "load" });
      await page.locator("h1").waitFor({ state: "visible" });
      await page.evaluate(async () => {
        await document.fonts.ready;
        await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      });

      const result = await page.evaluate(() => {
        const root = document.documentElement;
        const main = document.querySelector("main");
        const mainRect = main?.getBoundingClientRect();
        return {
          viewport: window.innerWidth,
          documentWidth: root.scrollWidth,
          mainLeft: mainRect?.left ?? 0,
          mainRight: mainRect?.right ?? 0,
          heading: document.querySelector("h1")?.textContent?.trim() ?? "",
        };
      });

      if (!result.heading) failures.push(`${route} at ${width}px has no H1`);
      if (route === "/") {
        const headline = page.getByRole("heading", { name: "Buy a stock’s upside for $1.", exact: true });
        const headlineBox = await headline.boundingBox();
        if (!headlineBox || headlineBox.y + headlineBox.height > 1000) {
          failures.push(`Homepage headline is outside the first viewport at ${width}px`);
        }
        if (await page.locator("form[data-waitlist]").count() !== 1) {
          failures.push(`Homepage lacks its waitlist form at ${width}px`);
        }
      }
      if (result.documentWidth > result.viewport + 1) {
        failures.push(
          `${route} at ${width}px overflows horizontally: ${result.documentWidth}px > ${result.viewport}px`,
        );
      }
      if (result.mainLeft < -1 || result.mainRight > result.viewport + 1) {
        failures.push(`${route} at ${width}px clips the primary content`);
      }

      console.log(
        `${route.padEnd(6)} ${String(width).padStart(4)}px  document ${result.documentWidth}px  ${result.heading}`,
      );
      if (route === "/app" && (width === 375 || width === 1440)) {
        const compact = page.getByRole("navigation", { name: "App sections", exact: true });
        const navigation = await compact.isVisible() ? compact : page.getByRole("navigation", { name: "App", exact: true });
        // The header offers exactly the Rips tabs; each target is verified
        // with a full load because the static server has no flight runtime.
        for (const name of ["Deposit stock", "Buy Rips", "My Rips", "Buy stocks"]) await navigation.getByRole("link", { name, exact: true }).waitFor();
        if (await navigation.getByRole("link", { name: "Earn", exact: true }).count() !== 0) {
          failures.push(`Header still links Earn at ${width}px`);
        }
        await page.goto(`${base}/rips/sell`, { waitUntil: "load" });
        await page.getByRole("heading", { name: "Deposit stock", exact: true }).waitFor();
      }
      await page.close();
    }
  }
} finally {
  await browser.close();
  await new Promise((resolve) => server.close(resolve));
}

if (failures.length > 0) {
  console.error(`\nResponsive check failed:\n- ${failures.join("\n- ")}`);
  process.exit(1);
}

console.log(`Responsive check passed: ${routes.length} routes at ${widths.length} widths.`);
