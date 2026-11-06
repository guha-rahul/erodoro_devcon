import { access, readFile, readdir } from "node:fs/promises";
import { constants } from "node:fs";
import path from "node:path";

const output = path.resolve("out");
const routes = [
  ["index.html", "upside for $1."],
  ["app.html", "Choose where to sell your upside"],
  ["create.html", ">List a market<"],
  ["earn.html", "Earn premium on your stocks"],
  ["swap.html", "Loading stocks"],
  ["buy.html", "Continue to Swap"],
  ["sell.html", "Continue to Swap"],
  ["faucet.html", ">Get test assets<"],
  ["portfolio.html", "Your portfolio"],
  ["rewards.html", ">Rewards<"],
  ["market-rip.html", "Pull a move."],
  ["rips.html", "My Rips"],
  ["rips/position.html", "Loading position"],
  ["rips/sell.html", "Deposit stock"],
];

for (const [file, marker] of routes) {
  const target = path.join(output, file);
  await access(target, constants.R_OK);
  const html = await readFile(target, "utf8");
  if (!html.includes(marker)) throw new Error(`${file} is missing its expected content: ${marker}`);
}

const marketDirectory = path.join(output, "app");
const marketFiles = (await readdir(marketDirectory))
  .filter((name) => /^[0-9a-f]{64}\.html$/.test(name));
if (marketFiles.length === 0) throw new Error("The export contains no recorded market route.");

for (const file of marketFiles) {
  const html = await readFile(path.join(marketDirectory, file), "utf8");
  if (!html.includes("Loading market")) throw new Error(`${file} is not a market page.`);
}

console.log(`Static export smoke check passed: ${routes.length} fixed routes and ${marketFiles.length} market route.`);
