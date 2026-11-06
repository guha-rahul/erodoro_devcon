// Policy supplies which expiries count and which completions qualify. This
// calculator derives progress only; it grants no points or multiplier.
export function loyaltyProgress({ schedule, completions, asOf, milestones }) {
  if (typeof asOf !== "bigint" || asOf < 0n) throw new Error("Invalid observation time");
  const ids = new Set();
  let previous = -1n;
  for (const entry of schedule) {
    if (typeof entry.id !== "string" || !entry.id || ids.has(entry.id)) throw new Error("Duplicate or invalid expiry id");
    if (typeof entry.maturity !== "bigint" || entry.maturity <= previous) throw new Error("Schedule must have strictly increasing maturities");
    ids.add(entry.id);
    previous = entry.maturity;
  }
  const levels = [...milestones];
  if (levels.some((n, i) => !Number.isSafeInteger(n) || n <= 0 || (i > 0 && n <= levels[i - 1]))) throw new Error("Milestones must increase");
  const wallets = new Map();
  for (const completion of completions) {
    if (!/^0x[0-9a-fA-F]{40}$/.test(completion.wallet)) throw new Error("Invalid wallet");
    if (!ids.has(completion.expiryId)) throw new Error("Completion outside schedule");
    const wallet = completion.wallet.toLowerCase();
    const completed = wallets.get(wallet) ?? new Set();
    completed.add(completion.expiryId);
    wallets.set(wallet, completed);
  }
  const elapsed = schedule.filter((entry) => entry.maturity <= asOf);
  return [...wallets.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([wallet, completed]) => {
    let total = 0, streak = 0, longest = 0;
    for (const expiry of elapsed) {
      if (completed.has(expiry.id)) { total++; streak++; longest = Math.max(longest, streak); }
      else streak = 0;
    }
    const nextMilestone = levels.find((level) => level > total) ?? null;
    return { wallet, completedExpiries: total, currentStreak: streak, longestStreak: longest,
      reachedMilestones: levels.filter((level) => level <= total), nextMilestone,
      expiriesToNext: nextMilestone === null ? null : nextMilestone - total };
  });
}
