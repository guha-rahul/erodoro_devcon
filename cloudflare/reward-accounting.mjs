// Deterministic inputs for a future scoring policy. This module awards no points.
// Run separately for each chain, vault, claim id, and accounting window.
const ZERO = "0x0000000000000000000000000000000000000000";
function address(value) {
  if (typeof value !== "string" || !/^0x[0-9a-fA-F]{40}$/.test(value)) throw new Error("Invalid account");
  return value.toLowerCase();
}
function uint(value) {
  if (typeof value !== "bigint" || value < 0n) throw new Error("Expected unsigned bigint");
  return value;
}

/**
 * Integrate claim ownership in [start, end). Opening balances must be a complete
 * snapshot immediately before start. Transfers include mints and burns; callers
 * supply canonical logs for one claim, including all transfers in the window.
 * Units are raw claim units multiplied by seconds, never token-dollar values.
 */
export function balanceSeconds({ start, end, openingBalances, transfers }) {
  uint(start); uint(end);
  if (end <= start) throw new Error("Invalid accounting window");
  const balances = new Map();
  const accrued = new Map();
  const touched = new Map();
  for (const [owner, balance] of openingBalances) {
    const key = address(owner);
    if (key === ZERO || balances.has(key)) throw new Error("Invalid opening snapshot");
    balances.set(key, uint(balance));
  }
  const ordered = [...transfers].sort((a, b) => a.block === b.block
    ? a.logIndex - b.logIndex : a.block < b.block ? -1 : 1);
  const seen = new Map();
  let previousTime = start;
  function checkpoint(owner, time) {
    if (owner === ZERO) return;
    accrued.set(owner, (accrued.get(owner) ?? 0n) + (balances.get(owner) ?? 0n) * (time - (touched.get(owner) ?? start)));
    touched.set(owner, time);
  }
  for (const event of ordered) {
    uint(event.block); uint(event.timestamp); uint(event.amount);
    if (!Number.isSafeInteger(event.logIndex) || event.logIndex < 0) throw new Error("Invalid log index");
    const from = address(event.from), to = address(event.to);
    if (from === ZERO && to === ZERO) throw new Error("Invalid transfer");
    const id = `${event.block}:${event.logIndex}`;
    const fingerprint = `${event.timestamp}:${from}:${to}:${event.amount}`;
    if (seen.has(id)) {
      if (seen.get(id) !== fingerprint) throw new Error("Conflicting canonical log");
      continue;
    }
    seen.set(id, fingerprint);
    if (event.timestamp < start || event.timestamp >= end) throw new Error("Transfer outside accounting window");
    if (event.timestamp < previousTime) throw new Error("Non-monotonic block timestamps");
    previousTime = event.timestamp;
    checkpoint(from, event.timestamp); checkpoint(to, event.timestamp);
    if (from !== ZERO) {
      const balance = balances.get(from) ?? 0n;
      if (balance < event.amount) throw new Error("Incomplete snapshot or missing transfer");
      balances.set(from, balance - event.amount);
    }
    if (to !== ZERO) balances.set(to, (balances.get(to) ?? 0n) + event.amount);
  }
  for (const owner of balances.keys()) checkpoint(owner, end);
  return [...balances.keys()].sort().map((owner) => ({ owner, balance: balances.get(owner), balanceSeconds: accrued.get(owner) ?? 0n }));
}

/** Apply explicit rational weights only after the operator supplies a policy. */
export function weightedPoints(units, { numerator, denominator }) {
  uint(units); uint(numerator); uint(denominator);
  if (denominator === 0n) throw new Error("Zero scoring denominator");
  return units * numerator / denominator;
}

// One chain and RFQ contract per invocation. Keep payment tokens separate.
// Self-fills are excluded; identifying linked wallets needs a separate policy.
export function fillVolumes(fills) {
  const seen = new Map(), totals = new Map();
  for (const fill of fills) {
    uint(fill.block); uint(fill.quoteAmount);
    if (!Number.isSafeInteger(fill.logIndex) || fill.logIndex < 0) throw new Error("Invalid log index");
    const maker = address(fill.maker), taker = address(fill.taker), token = address(fill.quoteToken);
    if ([maker, taker, token].includes(ZERO)) throw new Error("Invalid fill address");
    const id = `${fill.block}:${fill.logIndex}`;
    const fingerprint = `${maker}:${taker}:${token}:${fill.quoteAmount}`;
    if (seen.has(id)) {
      if (seen.get(id) !== fingerprint) throw new Error("Conflicting canonical fill");
      continue;
    }
    seen.set(id, fingerprint);
    if (maker === taker) continue;
    for (const [owner, role] of [[maker, "buyer"], [taker, "seller"]]) {
      const key = `${owner}:${token}:${role}`;
      const row = totals.get(key) ?? { owner, token, role, premium: 0n, fills: 0n };
      row.premium += fill.quoteAmount;
      row.fills += 1n;
      totals.set(key, row);
    }
  }
  return [...totals.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([, row]) => row);
}
