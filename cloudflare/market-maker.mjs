import { createPublicClient, http } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { baseSepolia } from "viem/chains";

/**
 * A house market maker, so the quote flow can be exercised end to end.
 *
 * **This is a stand-in, and its pricing is naive on purpose.** A real desk
 * prices upside off its own vol surface, inventory and hedge cost. What this
 * demonstrates is the *plumbing*: a maker receives a request, prices it, signs
 * an EIP-712 quote, and never touches the chain. Swapping in a real desk means
 * pointing `MM_ENDPOINTS` somewhere else and changing nothing on chain.
 *
 * It refuses to run anywhere but a test network. A naive model quoting real
 * money is a way to lose it.
 */

const SEPOLIA = 84532;

/** Reads the series behind a claim id, so the quote reflects real terms. */
const VAULT_ABI = [
  {
    type: "function",
    name: "seriesConfig",
    stateMutability: "view",
    inputs: [{ name: "seriesId", type: "uint256" }],
    outputs: [
      {
        type: "tuple",
        components: [
          { name: "creator", type: "address" },
          { name: "collateral", type: "address" },
          { name: "oracle", type: "address" },
          { name: "fallbackOracle", type: "address" },
          { name: "admin", type: "address" },
          { name: "feeRecipient", type: "address" },
          { name: "feedId", type: "bytes32" },
          { name: "fallbackRequestId", type: "bytes32" },
          { name: "settlementModel", type: "uint8" },
          { name: "strike", type: "uint256" },
          { name: "multiplierAtCreation", type: "uint256" },
          { name: "minSplitAmount", type: "uint256" },
          { name: "maturity", type: "uint64" },
          { name: "settlementDelay", type: "uint64" },
          { name: "maxPriceLag", type: "uint64" },
          { name: "fallbackDelay", type: "uint64" },
          { name: "maxConfBps", type: "uint32" },
          { name: "feeBps", type: "uint16" },
          { name: "collateralDecimals", type: "uint8" },
          { name: "priceDecimals", type: "uint8" },
          { name: "splitsPaused", type: "bool" },
          { name: "exists", type: "bool" },
        ],
      },
    ],
  },
];

const QUOTE_TYPES = {
  Quote: [
    { name: "maker", type: "address" },
    { name: "taker", type: "address" },
    { name: "claims", type: "address" },
    { name: "claimId", type: "uint256" },
    { name: "claimAmount", type: "uint256" },
    { name: "quoteToken", type: "address" },
    { name: "quoteAmount", type: "uint256" },
    { name: "expiry", type: "uint256" },
    { name: "nonce", type: "uint256" },
  ],
};

async function referenceUsd(feedId) {
  const id = feedId.replace(/^0x/, "");
  const res = await fetch(`https://hermes.pyth.network/v2/updates/price/latest?ids[]=${id}&encoding=hex`);
  if (!res.ok) return null;
  const p = (await res.json())?.parsed?.[0]?.price;
  return p ? Number(p.price) * 10 ** Number(p.expo) : null;
}

/**
 * What the upside is worth, crudely.
 *
 * Intrinsic value plus a time premium that decays to nothing at expiry. No
 * volatility input, no skew, no hedge cost — it is a placeholder that produces
 * a defensible number, not a model anyone should trade real size against.
 */
function priceUpside({ spot, strike, secondsToExpiry }) {
  const intrinsic = Math.max(0, spot - strike);
  const years = Math.max(0, secondsToExpiry) / 31_536_000;
  // ~35% annualised, scaled by sqrt(time), as a stand-in for a vol surface.
  const timeValue = spot * 0.35 * Math.sqrt(years) * 0.4;
  return intrinsic + timeValue;
}

export async function quote(request, env) {
  if (request.method !== "POST") {
    return new Response(JSON.stringify({ error: "Use POST." }), { status: 405 });
  }
  if (!env.MM_PRIVATE_KEY) {
    return new Response(JSON.stringify({ error: "No maker key configured." }), { status: 503 });
  }

  const body = await request.json();
  const { claims, claimId, claimAmount, quoteToken, taker } = body ?? {};
  if (!claims || !claimId || !claimAmount || !quoteToken) {
    return new Response(JSON.stringify({ error: "Incomplete request." }), { status: 400 });
  }

  const client = createPublicClient({
    chain: baseSepolia,
    transport: http(env.PRIVATE_RPC_URL || "https://sepolia.base.org"),
  });

  const chainId = await client.getChainId();
  if (chainId !== SEPOLIA) {
    return new Response(JSON.stringify({ error: "House maker runs on testnets only." }), { status: 403 });
  }

  // The claim id's low bit distinguishes the two sides; the series is the id
  // with that bit cleared.
  const seriesId = BigInt(claimId) & ~1n;
  const cfg = await client.readContract({ address: claims, abi: VAULT_ABI, functionName: "seriesConfig", args: [seriesId] });
  if (!cfg.exists) {
    return new Response(JSON.stringify({ error: "Unknown series." }), { status: 404 });
  }

  const spot = await referenceUsd(cfg.feedId);
  if (spot === null) {
    return new Response(JSON.stringify({ error: "No reference price; declining to quote." }), { status: 503 });
  }

  const strike = Number(cfg.strike) / 10 ** Number(cfg.priceDecimals);
  const now = Math.floor(Date.now() / 1000);
  const perShare = priceUpside({ spot, strike, secondsToExpiry: Number(cfg.maturity) - now });

  // Claim units share the collateral's decimals; the quote token has its own.
  const shares = Number(BigInt(claimAmount)) / 10 ** Number(cfg.collateralDecimals);
  const quoteDecimals = Number(env.MM_QUOTE_DECIMALS ?? 6);
  const gross = perShare * shares;
  // A spread, so the maker is not quoting its own fair value back.
  const net = gross * (1 - Number(env.MM_SPREAD ?? 0.06));
  const quoteAmount = BigInt(Math.floor(net * 10 ** quoteDecimals));

  if (quoteAmount <= 0n) {
    return new Response(JSON.stringify({ error: "Upside is worthless at this strike; declining." }), { status: 200 });
  }

  const account = privateKeyToAccount(env.MM_PRIVATE_KEY);
  const q = {
    maker: account.address,
    taker: taker ?? "0x0000000000000000000000000000000000000000",
    claims,
    claimId: BigInt(claimId),
    claimAmount: BigInt(claimAmount),
    quoteToken,
    quoteAmount,
    expiry: BigInt(now + Number(env.MM_QUOTE_TTL ?? 120)),
    nonce: BigInt(Date.now()) * 1000n + BigInt(Math.floor(Math.random() * 1000)),
  };

  const signature = await account.signTypedData({
    domain: { name: "ErodoroRFQ", version: "1", chainId: SEPOLIA, verifyingContract: env.RFQ_ADDRESS },
    types: QUOTE_TYPES,
    primaryType: "Quote",
    message: q,
  });

  return new Response(
    JSON.stringify({
      makerName: env.MM_NAME ?? "House maker",
      quote: Object.fromEntries(Object.entries(q).map(([k, v]) => [k, typeof v === "bigint" ? v.toString() : v])),
      metrics: {
        availableSize: q.claimAmount.toString(),
        spreadBps: Math.round(Number(env.MM_SPREAD ?? 0.06) * 10_000),
      },
      signature,
    }),
    { headers: { "content-type": "application/json" } },
  );
}
