/**
 * File/D1-backed auction store. MVP centralization is explicit: the
 * coordinator orders bids and tracks state, but it can never settle below
 * the seller's signed floor, alter terms, or move funds — settlement stays
 * contract-enforced (ErodoroIntent.fillIntent).
 *
 * Backends:
 * - Node/local: JSON file at AUCTION_STORE_FILE (default
 *   `.auction-store.json` CWD) + in-memory cache. Survives process restart.
 * - Worker: in-memory + optional D1 binding `AUCTION_DB` (tables created
 *   lazily). Without D1 the worker keeps memory-only state and says so.
 */
import { readFile, writeFile, mkdir, rename } from "node:fs/promises";
import path from "node:path";

const SCHEMA = "erodoro-auction-store/v1";
const fileStores = new Map();
const dbStores = new WeakMap();

function nowSeconds() {
  return Math.floor(Date.now() / 1000);
}

export function emptyState() {
  return { schema: SCHEMA, intents: {}, auctions: {}, fills: {} };
}

export class AuctionStore {
  constructor({ file = null, db = null } = {}) {
    this.file = file;
    this.db = db;
    this.mem = emptyState();
    this.loaded = false;
    this.writeChain = Promise.resolve();
  }

  static fromEnv(env = {}) {
    const file = env.AUCTION_STORE_FILE ?? null;
    const db = env.AUCTION_DB ?? null;
    if (db && typeof db === "object") {
      if (!dbStores.has(db)) dbStores.set(db, new AuctionStore({ db }));
      return dbStores.get(db);
    }
    if (file) {
      if (!fileStores.has(file)) fileStores.set(file, new AuctionStore({ file }));
      return fileStores.get(file);
    }
    return new AuctionStore();
  }

  async load() {
    if (this.loaded) return this.mem;
    if (this.db) {
      await this.db.exec(
        `CREATE TABLE IF NOT EXISTS kv (k TEXT PRIMARY KEY, v TEXT);`,
      ).catch(() => {});
      try {
        const row = await this.db.prepare(`SELECT v FROM kv WHERE k='state'`).first();
        if (row?.v) {
          const parsed = JSON.parse(row.v);
          if (parsed.schema === SCHEMA) this.mem = parsed;
        }
      } catch {}
    } else if (this.file) {
      try {
        const raw = await readFile(this.file, "utf8");
        const parsed = JSON.parse(raw);
        if (parsed.schema === SCHEMA) this.mem = parsed;
      } catch (error) {
        if (error.code !== "ENOENT") throw error;
      }
    }
    this.loaded = true;
    return this.mem;
  }

  /** Serialized writes so two workers/threads cannot interleave a save. */
  async save() {
    this.writeChain = this.writeChain.then(async () => {
      if (this.db) {
        await this.db
          .prepare(`INSERT INTO kv (k, v) VALUES ('state', ?1) ON CONFLICT(k) DO UPDATE SET v=excluded.v`)
          .bind(JSON.stringify(this.mem))
          .run();
      } else if (this.file) {
        await mkdir(path.dirname(this.file), { recursive: true });
        const temporary = `${this.file}.${crypto.randomUUID()}.tmp`;
        await writeFile(temporary, JSON.stringify(this.mem, null, 2));
        await rename(temporary, this.file);
      }
    });
    return this.writeChain;
  }

  async registerIntent(intentHash, intent) {
    await this.load();
    if (this.mem.intents[intentHash]) throw new Error("Intent already registered.");
    this.mem.intents[intentHash] = { ...intent, intentHash, status: "active", filledAmount: "0", createdAt: nowSeconds() };
    await this.save();
    return this.mem.intents[intentHash];
  }

  async getIntent(intentHash) {
    await this.load();
    return this.mem.intents[intentHash] ?? null;
  }

  async listIntents(status = "active") {
    await this.load();
    return Object.values(this.mem.intents).filter((i) => (status === "all" ? true : i.status === status));
  }

  async cancelIntent(intentHash) {
    await this.load();
    const record = this.mem.intents[intentHash];
    if (!record) throw new Error("Unknown intent.");
    record.status = "cancelled";
    const auction = this.mem.auctions[intentHash];
    if (auction && !["Settled", "Filled"].includes(auction.state)) auction.state = "Cancelled";
    await this.save();
    return record;
  }

  async upsertAuction(auction) {
    await this.load();
    const existing = this.mem.auctions[auction.id];
    // Idempotency + concurrency guard: never overwrite a live exclusive
    // winner with a different one.
    if (existing?.winner && existing.winnerExclusiveUntil > nowSeconds() && auction.winner
      && JSON.stringify(existing.winner) !== JSON.stringify(auction.winner)) {
      throw new Error("A live winner already holds exclusivity.");
    }
    this.mem.auctions[auction.id] = auction;
    await this.save();
    return auction;
  }

  async getAuction(id) {
    await this.load();
    return this.mem.auctions[id] ?? null;
  }

  async listAuctions() {
    await this.load();
    return Object.values(this.mem.auctions);
  }

  async recordFill(intentHash, amount, txHash = null, premium = null, buyer = null) {
    await this.load();
    const record = this.mem.intents[intentHash];
    if (record) {
      record.filledAmount = (BigInt(record.filledAmount) + BigInt(amount)).toString();
      if (BigInt(record.filledAmount) >= BigInt(record.claimAmount)) record.status = "filled";
      else record.status = "partially-filled";
    }
    const auction = this.mem.auctions[intentHash];
    if (auction) {
      auction.filledAmount = (BigInt(auction.filledAmount ?? "0") + BigInt(amount)).toString();
      if (txHash) auction.settlementTx = txHash;
      if (premium !== null) auction.winningPremium = String(premium);
      if (buyer) auction.buyer = buyer;
      if (record && BigInt(record.filledAmount) >= BigInt(record.claimAmount)) auction.state = "Filled";
      else auction.state = "PartiallyFilled";
      auction.winner = null;
      auction.winnerExclusiveUntil = 0;
    }
    await this.save();
    return record;
  }
}
