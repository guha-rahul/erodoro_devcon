#!/usr/bin/env node
/**
 * Minimal solver/buyer CLI for the intent auction.
 *
 * Lists open auctions, shows the current best bid and the Dutch reserve,
 * and submits a signed bid. This is the reference integration for any
 * third-party desk: fetch auctions, price off your own vol surface, sign
 * EIP-712, POST, then settle the win on-chain via ErodoroIntent.fillIntent.
 *
 * Usage:
 *   INTENT_RPC_URL=https://sepolia.base.org \
 *   BIDDER_KEY=0x... \
 *   INTENT_ADDRESS=0x... INTENT_CHAIN_ID=84532 \
 *   AUCTIONS_BASE=https://erodoro.example \
 *   node app/scripts/bid-cli.mjs list
 *   node app/scripts/bid-cli.mjs bid <intentHash> <amount> <premium>
 *
 * Amounts are raw claim units (decimal strings); premium is quote-token
 * base units (USDC: 6 decimals). Never bid what you cannot fund: the
 * contract pulls payment atomically at settlement.
 */
import { createWalletClient, http } from "viem";
import { privateKeyToAccount } from "viem/accounts";

const BASE = process.env.AUCTIONS_BASE ?? "http://localhost:8787";
const INTENT_ADDRESS = process.env.INTENT_ADDRESS;
const CHAIN_ID = Number(process.env.INTENT_CHAIN_ID ?? 84532);
const chain = { id: CHAIN_ID, name: "target", nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 }, rpcUrls: { default: { http: ["http://localhost"] } } };

const BID_TYPES = {
  Bid: [
    { name: "bidder", type: "address" },
    { name: "intentHash", type: "bytes32" },
    { name: "amount", type: "uint256" },
    { name: "premium", type: "uint256" },
    { name: "expiry", type: "uint256" },
    { name: "nonce", type: "uint256" },
  ],
};

async function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  if (cmd === "list") {
    const res = await fetch(`${BASE}/api/auctions`);
    const { auctions } = await res.json();
    if (!auctions?.length) {
      console.log("No auctions.");
      return;
    }
    for (const a of auctions) {
      const best = [...(a.bids ?? [])].sort((x, y) => (BigInt(y.premium) > BigInt(x.premium) ? 1 : -1))[0];
      console.log(`${a.intentHash} [${a.path}/${a.state}] bids=${a.bids?.length ?? 0} best=${best?.premium ?? "-"} winner=${a.winner ? a.winner.bidder : "-"}`);
    }
    return;
  }
  if (cmd === "bid") {
    const [intentHash, amount, premium] = rest;
    if (!/^0x[0-9a-fA-F]{64}$/.test(intentHash ?? "") || !amount || !premium) {
      throw new Error("Usage: bid-cli.mjs bid <intentHash> <amount> <premium>");
    }
    if (!process.env.BIDDER_KEY || !INTENT_ADDRESS) throw new Error("Set BIDDER_KEY and INTENT_ADDRESS.");
    const bidder = privateKeyToAccount(process.env.BIDDER_KEY);
    const client = createWalletClient({ account: bidder, chain, transport: http() });
    const now = BigInt(Math.floor(Date.now() / 1000));
    const message = { bidder: bidder.address, intentHash, amount: BigInt(amount), premium: BigInt(premium), expiry: now + 600n, nonce: BigInt(Date.now()) };
    const signature = await client.signTypedData({
      domain: { name: "ErodoroAuction", version: "1", chainId: CHAIN_ID, verifyingContract: INTENT_ADDRESS },
      types: BID_TYPES,
      primaryType: "Bid",
      message: { ...message, amount: message.amount, premium: message.premium, expiry: message.expiry, nonce: message.nonce },
    });
    const res = await fetch(`${BASE}/api/auctions/${intentHash}/bids`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ bidder: bidder.address, amount, premium, expiry: (now + 600n).toString(), nonce: message.nonce.toString(), signature }),
    });
    console.log(`HTTP ${res.status}`, await res.text());
    return;
  }
  throw new Error("Usage: bid-cli.mjs list | bid <intentHash> <amount> <premium>");
}

main().catch((e) => {
  console.error(e.message);
  process.exit(1);
});
