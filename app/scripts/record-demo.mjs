/**
 * Records the Rips demo against the running dev app (Base Sepolia, real transactions), driven like a person:
 * a visible cursor that eases to each target, short hesitations, smooth scrolling, and a caption bar.
 *
 *   node scripts/record-demo.mjs <out-dir> [warm|main|settle]
 *
 * `warm` records nothing: it loads the pool and connects the wallet in a persistent browser profile
 * (DEMO_PROFILE, default <out-dir>/../demo-profile), so the takes start from a warm app the way a returning user's
 * browser would, instead of re-reading the pool's history for two minutes.
 *
 * Writes one video per page plus timeline.json (when each segment starts and ends, and which waits to speed up),
 * which scripts/cut-demo.mjs turns into the final cut. Uses the dev test wallets, so `next dev` must be running
 * with them (see ~/.config/erodoro/bin/run-ethglobal.sh) and the World ID verifier must be up.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { chromium } from "playwright-core";

const OUT = path.resolve(process.argv[2] ?? "demo-recording");
const MODE = process.argv[3] ?? "main";
const BASE = process.env.DEMO_BASE_URL ?? "http://localhost:3500";
const WALLET = process.env.DEMO_WALLET ?? "Test seller (dev)";
const SIZE = { width: 1280, height: 800 };
mkdirSync(OUT, { recursive: true });

// A cursor and a caption bar drawn into every page, so the recording shows what a person would see.
const overlay = () => {
  const install = () => {
    if (document.getElementById("__demo_cursor")) return;
    const cursor = document.createElement("div");
    cursor.id = "__demo_cursor";
    cursor.innerHTML = `<svg width="22" height="22" viewBox="0 0 22 22"><path d="M3 2l15 8-6.5 1.7L9 18z" fill="#111" stroke="#fff" stroke-width="1.6" stroke-linejoin="round"/></svg>`;
    Object.assign(cursor.style, { position: "fixed", left: "-40px", top: "-40px", zIndex: 2147483647, pointerEvents: "none", transition: "transform 80ms" });
    const ring = document.createElement("div");
    Object.assign(ring.style, { position: "fixed", width: "34px", height: "34px", marginLeft: "-17px", marginTop: "-17px", borderRadius: "50%", border: "2px solid rgba(204,85,51,.85)", zIndex: 2147483646, pointerEvents: "none", opacity: "0", transform: "scale(.4)", transition: "opacity 380ms, transform 380ms" });
    const caption = document.createElement("div");
    caption.id = "__demo_caption";
    Object.assign(caption.style, { position: "fixed", left: "50%", bottom: "26px", transform: "translateX(-50%)", maxWidth: "86%", padding: "11px 20px", borderRadius: "14px", background: "rgba(20,20,22,.88)", color: "#fff", font: "500 19px/1.35 -apple-system, Helvetica, sans-serif", letterSpacing: "-.01em", zIndex: 2147483645, pointerEvents: "none", opacity: "0", transition: "opacity 260ms", textAlign: "center" });
    const hide = document.createElement("style");
    hide.textContent = "nextjs-portal { display: none !important; }"; // the dev-mode badge
    document.documentElement.append(hide, caption, ring, cursor);
    addEventListener("mousemove", (e) => { cursor.style.left = `${e.clientX - 3}px`; cursor.style.top = `${e.clientY - 2}px`; }, true);
    addEventListener("mousedown", (e) => {
      cursor.style.transform = "scale(.86)";
      Object.assign(ring.style, { left: `${e.clientX}px`, top: `${e.clientY}px`, transition: "none", opacity: "1", transform: "scale(.4)" });
      requestAnimationFrame(() => Object.assign(ring.style, { transition: "opacity 420ms, transform 420ms", opacity: "0", transform: "scale(1.5)" }));
    }, true);
    addEventListener("mouseup", () => { cursor.style.transform = ""; }, true);
    window.__caption = (text) => { caption.textContent = text ?? ""; caption.style.opacity = text ? "1" : "0"; };
  };
  if (document.readyState === "loading") addEventListener("DOMContentLoaded", install); else install();
};

const rand = (a, b) => a + Math.random() * (b - a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const hesitate = (a = 350, b = 900) => sleep(rand(a, b));
const ease = (t) => (t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2);

const profile = process.env.DEMO_PROFILE ?? path.join(OUT, "..", "demo-profile");
const context = await chromium.launchPersistentContext(profile, {
  headless: true,
  viewport: SIZE,
  ...(MODE === "warm" ? {} : { recordVideo: { dir: OUT, size: SIZE } }),
});
await context.addInitScript(overlay);
const started = Date.now();
const pages = new Map(); // page -> { name, createdAt }
const segments = []; // { page, from, to, speed }
const pointer = new Map(); // page -> { x, y }

async function newPage(name) {
  const page = await context.newPage();
  pages.set(page, { name, createdAt: Date.now() });
  pointer.set(page, { x: SIZE.width * rand(0.45, 0.6), y: SIZE.height * rand(0.55, 0.7) });
  return page;
}
/** The part of the final cut that shows `page` from now until the next cut, at `speed`. */
let current = null;
function cut(page, speed = 1) {
  const now = Date.now();
  if (current) segments.push({ ...current, to: now });
  current = { page: pages.get(page).name, video: null, from: now, speed };
}
/** The World ID panel's "$X of $Y left this batch", as numbers. */
async function allowanceLeft(page) {
  const text = await page.getByText(/left this batch/).first().innerText({ timeout: 30_000 }).catch(() => "");
  const m = text.match(/\$([\d.]+) of \$([\d.]+) left/);
  return m ? { left: Number(m[1]), cap: Number(m[2]) } : null;
}
const caption = (page, text) => page.evaluate((t) => window.__caption?.(t), text).catch(() => {});

/** Moves along a gently curved, eased path, as a hand on a trackpad would. */
async function moveTo(page, x, y) {
  const from = pointer.get(page);
  const dx = x - from.x, dy = y - from.y;
  const dist = Math.hypot(dx, dy);
  const steps = Math.max(12, Math.min(48, Math.round(dist / 14)));
  const bend = rand(-0.18, 0.18) * dist;
  const cx = from.x + dx / 2 - (dy / (dist || 1)) * bend, cy = from.y + dy / 2 + (dx / (dist || 1)) * bend;
  for (let i = 1; i <= steps; i++) {
    const t = ease(i / steps);
    const px = (1 - t) ** 2 * from.x + 2 * (1 - t) * t * cx + t * t * x;
    const py = (1 - t) ** 2 * from.y + 2 * (1 - t) * t * cy + t * t * y;
    await page.mouse.move(px, py);
    await sleep(rand(7, 15));
  }
  pointer.set(page, { x, y });
}
async function click(page, locator, { settle = true } = {}) {
  await locator.waitFor({ state: "visible", timeout: 120_000 });
  await locator.scrollIntoViewIfNeeded().catch(() => {});
  const box = await locator.boundingBox();
  if (!box) throw new Error("Nothing to click");
  await moveTo(page, box.x + box.width * rand(0.38, 0.62), box.y + box.height * rand(0.4, 0.6));
  await hesitate(140, 360);
  await page.mouse.down();
  await sleep(rand(60, 120));
  await page.mouse.up();
  if (settle) await hesitate();
}
async function scrollBy(page, total) {
  const steps = Math.max(6, Math.round(Math.abs(total) / 60));
  for (let i = 0; i < steps; i++) { await page.mouse.wheel(0, total / steps); await sleep(rand(16, 34)); }
  await hesitate(300, 600);
}

const app = await newPage("app");
cut(app, 6); // loading
await app.goto(`${BASE}/market-rip`, { waitUntil: "domcontentloaded" });
await caption(app, "Erodoro Rips: buy the upside of a stock in $1 slices · Base Sepolia");
// The app is interactive once it has read the pool.
await app.getByText("Reading the pool").first().waitFor({ state: "hidden", timeout: 300_000 });
cut(app);
await sleep(1500);

// Connect the dev wallet, as anyone would pick a wallet.
const connect = app.getByRole("button", { name: "Connect wallet" });
if (await connect.isVisible().catch(() => false)) {
  await click(app, connect);
  await sleep(800);
  console.log("wallet options:", (await app.getByRole("menuitem").allInnerTexts()).join(" | ") || (await app.getByRole("button").allInnerTexts()).join(" | "));
  await click(app, app.getByText(WALLET, { exact: true }).first());
  await sleep(2000);
}
if (MODE === "warm") {
  // Dev wallets auto-connect the first test wallet; switch to the one the takes use.
  const account = app.getByRole("button", { name: /^0x[0-9a-fA-F]{4}/ }).first();
  await account.waitFor({ timeout: 60_000 });
  await account.click();
  await sleep(800);
  const connected = app.getByRole("menuitem").filter({ hasText: WALLET });
  if (await connected.count()) await connected.first().click();
  else {
    await app.getByRole("menuitem", { name: "Choose another account" }).click();
    await sleep(1500);
    const cancel = app.getByRole("button", { name: "Cancel" });
    if (await cancel.isVisible().catch(() => false)) await cancel.click(); // Base Account's popup attempt
    await app.getByRole("menuitem", { name: WALLET }).click().catch(async () => {
      await account.click(); await sleep(800);
      await app.getByRole("menuitem", { name: "Choose another account" }).click(); await sleep(1500);
      await app.getByRole("menuitem", { name: WALLET }).click();
    });
  }
  await sleep(3000);
  console.log("active wallet:", await app.getByRole("button", { name: /^0x[0-9a-fA-F]{4}/ }).first().innerText());
  await app.getByText(/Verify with World ID|Verified human/).first().waitFor({ timeout: 300_000 });
  console.log("warm: wallet connected and pool read");
  await context.close();
  process.exit(0);
}

// On a failure, keep a screenshot and close the browser so the videos are written out.
const fail = async (error) => {
  console.error(error);
  for (const page of context.pages()) await page.screenshot({ path: path.join(OUT, `error-${pages.get(page)?.name ?? "page"}.png`) }).catch(() => {});
  await context.close().catch(() => {});
  process.exit(1);
};
process.on("unhandledRejection", fail);
process.on("uncaughtException", fail);

if (MODE === "main") {
  // 1. Not verified: the pool refuses before anything is signed.
  await caption(app, "Not verified yet. Rips are for verified humans: one allowance per person.");
  await sleep(1800);
  await click(app, app.getByRole("button", { name: "RIP $1" }));
  await app.getByText("Verify with World ID first").first().waitFor({ timeout: 60_000 });
  await caption(app, "Refused. Nothing was charged.");
  await sleep(2600);
  await click(app, app.getByRole("button", { name: "Close" }));

  // 2. World ID: IDKit, then the World ID simulator standing in for the World App.
  await caption(app, "Verify with World ID: Proof of Human, bound to this wallet");
  await click(app, app.getByRole("button", { name: "Verify with World ID" }));
  const simLink = app.getByText("Use the simulator");
  await simLink.waitFor({ timeout: 120_000 });
  await caption(app, "Testing in staging: the World ID simulator stands in for the World App");
  await sleep(2200);
  // The link opens the simulator in a new tab, as it would for anyone testing in staging.
  const opened = context.waitForEvent("page");
  await click(app, simLink, { settle: false });
  const sim = await opened;
  pages.set(sim, { name: "sim", createdAt: Date.now() });
  pointer.set(sim, { x: SIZE.width * 0.5, y: SIZE.height * 0.6 });
  cut(sim);
  await sim.waitForLoadState("domcontentloaded");
  await caption(sim, "World ID simulator (stands in for the World App)");
  const cont = sim.getByText("Continue", { exact: true });
  cut(sim, 6); // the simulator loading its test identity
  await cont.waitFor({ timeout: 120_000 });
  cut(sim);
  await sleep(1800);
  await caption(sim, "Approve the request with World ID 4.0");
  await click(sim, cont);
  cut(sim, 6);
  await sim.getByText("Presented").first().waitFor({ timeout: 120_000 });
  cut(sim);
  await sleep(1500);

  await app.bringToFront();
  cut(app);
  await caption(app, "Chainlink CRE checks the proof with World's API and writes it to Base Sepolia");
  await sleep(2500);
  cut(app, 10); // the CRE workflow runs
  await app.getByText("All set!").first().waitFor({ timeout: 240_000 });
  cut(app);
  await sleep(1800);
  await app.keyboard.press("Escape");
  await app.getByText("Verified human").first().waitFor({ timeout: 60_000 });
  await caption(app, "Verified. $50 per person per batch, counted across every wallet they verify.");
  await moveTo(app, 300, 230);
  await sleep(3200);
  const allowance = await allowanceLeft(app);
  if (allowance && allowance.left < allowance.cap) {
    await caption(app, `This person already spent $${allowance.cap - allowance.left} from another wallet, so $${allowance.left} is left`);
    await sleep(3600);
  }

  // 3. A $1 Rip.
  await caption(app, "Pull a $1 Rip: a slice of upside on 10 stocks");
  await click(app, app.getByRole("button", { name: "RIP $1" }));
  cut(app, 4);
  await app.getByText("YOU PULLED", { exact: false }).first().waitFor({ timeout: 180_000 });
  cut(app);
  await sleep(4200);
  await click(app, app.getByRole("button", { name: "Done" }));

  // 4. Any number of Rips, within the allowance.
  await caption(app, "Pick as many as you like: $1 each, within this person's allowance");
  const more = app.getByRole("button", { name: "One more Rip" });
  await more.scrollIntoViewIfNeeded();
  for (let i = 0; i < 2; i++) { await click(app, more, { settle: false }); await sleep(rand(300, 520)); }
  await sleep(700);
  await click(app, app.getByRole("button", { name: /^RIP \$3$/ }));
  cut(app, 4);
  await app.getByText("You pulled").first().waitFor({ timeout: 180_000 });
  cut(app);
  await sleep(3800);
  await click(app, app.getByRole("button", { name: "Done" }));
  const after = await allowanceLeft(app);
  if (after) {
    await caption(app, `$${after.left} of $${after.cap} left for this person this batch`);
    await moveTo(app, 300, 230);
    await sleep(3000);
  }

  // 5. A Rip's page: the CRE settlement price and Uniswap resale.
  await caption(app, "Each Rip settles at Chainlink's price and can be resold on Uniswap v4");
  await click(app, app.getByRole("link", { name: "My Rips", exact: true }).first());
  cut(app, 4);
  const held = app.getByText(/^tAAPL/).first();
  await held.waitFor({ timeout: 180_000 });
  cut(app);
  await sleep(1800);
  await click(app, held);
  await app.getByText("Settlement price").first().waitFor({ timeout: 60_000 });
  cut(app, 4);
  await app.getByText(/Chainlink via CRE: \$/).first().waitFor({ timeout: 120_000 }).catch(() => {});
  cut(app);
  await sleep(1500);
  await scrollBy(app, 900);
  await caption(app, "Settlement price: Chainlink stock feed, delivered to Base Sepolia by a CRE workflow");
  await sleep(4200);
  await caption(app, "Sell on Uniswap v4: the pool's hook checks World ID first");
  const sell = app.getByRole("button", { name: "Sell on Uniswap" });
  await sell.waitFor({ timeout: 60_000 });
  for (let i = 0; i < 60 && !(await sell.isEnabled()); i++) await sleep(500); // the quote loads
  await sleep(1500);
  await click(app, sell);
  cut(app, 5);
  await app.getByText(/^Sold for/).first().waitFor({ timeout: 240_000 });
  cut(app);
  await caption(app, "Sold through Uniswap v4. World ID · Chainlink CRE · Uniswap");
  await sleep(4200);
} else {
  // After expiry: settle at the CRE-delivered Chainlink price, then redeem one that ended above its strike. My Rips
  // lists settled Rips first, then live ones, then expired ones awaiting settlement.
  const below = process.env.DEMO_SETTLE_STOCK ?? "tAMZN";
  const above = process.env.DEMO_REDEEM_STOCK ?? "tSPCX";
  await caption(app, "After expiry: settle at the Chainlink price CRE delivered");
  await click(app, app.getByRole("link", { name: "My Rips", exact: true }).first());
  cut(app, 6);
  await app.getByText(new RegExp(`^${below}`)).last().waitFor({ timeout: 180_000 });
  cut(app);
  await sleep(2200);
  await click(app, app.getByText(new RegExp(`^${below}`)).last());
  cut(app, 6);
  const settle = app.getByRole("button", { name: "Settle at the Chainlink price" });
  await settle.waitFor({ timeout: 180_000 });
  cut(app);
  await settle.scrollIntoViewIfNeeded();
  await caption(app, "The first CRE price report after expiry decides the payout");
  await sleep(3500);
  for (let i = 0; i < 60 && !(await settle.isEnabled()); i++) await sleep(500);
  await click(app, settle);
  cut(app, 6);
  await app.getByText(/^Settled\./).first().waitFor({ timeout: 240_000 });
  cut(app);
  await scrollBy(app, -400);
  await caption(app, `${below} ended below its strike, so this Rip pays nothing`);
  await sleep(3800);

  await click(app, app.getByRole("link", { name: "My Rips", exact: true }).first());
  cut(app, 6);
  await app.getByText(new RegExp(`^${above}`)).first().waitFor({ timeout: 180_000 });
  cut(app);
  await sleep(1500);
  await click(app, app.getByText(new RegExp(`^${above}`)).first());
  cut(app, 6);
  // Redeem, or show the payout if this Rip was already redeemed.
  const redeem = app.getByRole("button", { name: /Redeem held claims/ });
  await redeem.or(app.getByText(`Redeemed in ${above}.`)).first().waitFor({ timeout: 180_000 });
  cut(app);
  if (await redeem.isVisible().catch(() => false)) {
    await caption(app, `${above} settled above its strike, so it pays out in the stock itself`);
    await sleep(3000);
    await click(app, redeem);
    cut(app, 5);
    await app.getByText("Redeemed").first().waitFor({ timeout: 180_000 }).catch(() => {});
    cut(app);
    await caption(app, `Redeemed in ${above}. World ID · Chainlink CRE · Uniswap v4`);
  } else {
    await scrollBy(app, 300);
    await caption(app, `${above} settled above its strike and paid out in the stock itself`);
    await sleep(3800);
    await caption(app, "World ID · Chainlink CRE · Uniswap v4, on Base Sepolia");
  }
  await sleep(3800);
}
cut(app);
await caption(app, "");
const timeline = { started, mode: MODE, size: SIZE, pages: {}, segments };
for (const [page, info] of pages) timeline.pages[info.name] = { createdAt: info.createdAt, video: null };
await context.close();
for (const [page, info] of pages) timeline.pages[info.name].video = await page.video().path();
writeFileSync(path.join(OUT, "timeline.json"), JSON.stringify(timeline, null, 2));
console.log(`Recorded ${segments.length} segments to ${OUT}`);
