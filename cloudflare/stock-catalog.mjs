import { getAddress, isAddress } from "viem";

// Trust issuer-published addresses, never pool tickers or a user-provided URL.
// A new issuer needs a reviewed adapter; new assets from these sources do not.
export const SOURCES = [
  // Base's own JSON behind brand.base.org/stocks: the page renders only the first
  // ten in HTML and loads the rest from here (127 on 2026-10-11).
  { id: "coinbase", issuer: "Coinbase", url: "https://brand.base.org/api/stocks", kind: "base-api", disclosures: "https://www.coinbase.com/tokenize" },
  { id: "xstocks", issuer: "Backed · xStocks", url: "https://raw.githubusercontent.com/backed-fi/cowswap-xstocks-tokenlist/main/tokenlist.json", kind: "token-list", disclosures: "https://assets.backed.fi/legal-documentation" },
  { id: "ondo", issuer: "Ondo", url: "https://raw.githubusercontent.com/ondoprotocol/ondo-global-markets-token-list/main/tokenlist.json", kind: "token-list", disclosures: "https://docs.ondo.finance/legal/terms-of-service" },
  { id: "backed", issuer: "Backed · bTokens", url: "https://assets.backed.fi/products", kind: "backed-pages", disclosures: "https://assets.backed.fi/legal-documentation" },
];
const TTL = 15 * 60 * 1000;
let cached;
let pending;
const attr = (tag, name) => tag.match(new RegExp(`\\b${name}="([^"]*)"`))?.[1];
const clean = (value) => value.replace(/&amp;/g, "&").replace(/&#x27;|&#39;/g, "'").replace(/&quot;/g, '"');

function token(source, address, symbol, name, extra = {}) {
  if (!isAddress(address, { strict: false }) || /^0x0{40}$/i.test(address)) throw new Error("Invalid issuer token address");
  if (typeof symbol !== "string" || !symbol.trim() || symbol.length > 40 || typeof name !== "string" || !name.trim() || name.length > 200) throw new Error("Invalid token metadata");
  return { chainId: 8453, address: getAddress(address.toLowerCase()), symbol: clean(symbol), name: clean(name), issuer: source.issuer, source: source.url, sourceId: source.id, disclosures: source.disclosures, ...extra };
}

export function parseBasePage(html, source = SOURCES[0]) {
  const rows = [];
  for (const match of html.matchAll(/<a\b[^>]*>/g)) {
    const tag = match[0];
    const symbol = attr(tag, "aria-label")?.match(/^View (.+) on BaseScan$/)?.[1];
    const address = attr(tag, "href")?.match(/^https:\/\/basescan\.org\/token\/(0x[\da-fA-F]{40})$/)?.[1];
    if (symbol && address) {
      const before = html.slice(Math.max(0, match.index - 3500), match.index);
      const escaped = symbol.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const names = [...before.matchAll(new RegExp(`>${escaped}</span><p[^>]*>([^<]+)</p>`, "g"))];
      rows.push(token(source, address, symbol, names.at(-1)?.[1] ?? symbol, { b20: true }));
    }
  }
  if (!rows.length) throw new Error("Base stock-list format changed or list is empty");
  return [...new Map(rows.map((t) => [t.address, t])).values()];
}

export function parseBaseApi(data, source = SOURCES[0]) {
  if (!Array.isArray(data?.stocks) || !data.stocks.length || data.stocks.length > 5000) throw new Error("Base stock list format changed or list is empty");
  const rows = data.stocks.map((t) => token(source, t.address, t.ticker, t.name, { b20: true }));
  return [...new Map(rows.map((t) => [t.address, t])).values()];
}

export function parseTokenList(data, source) {
  if (!Array.isArray(data.tokens) || !data.tokens.length || data.tokens.length > 20000) throw new Error("Invalid issuer token list");
  return data.tokens.filter((t) => t.chainId === 8453)
    // Ondo's list also contains its cash token, which is not a stock or fund.
    .filter((t) => source.id !== "ondo" || /\(Ondo Tokenized\)/i.test(t.name))
    .map((t) => token(source, t.address, t.symbol, t.name));
}

export function parseBackedPage(html, source = SOURCES[3]) {
  const title = clean(html.match(/<title>([^<]+)<\/title>/)?.[1] ?? "");
  const symbol = title.match(/\(([^)]+)\)/)?.[1];
  const name = title.replace(/ - Backed Assets$/, "");
  const tags = [...html.matchAll(/<a\b[^>]*>/g)].map((m) => m[0]);
  const base = tags.find((tag) => attr(tag, "title") === "Base" && attr(tag, "href") === "https://basescan.org/token/");
  if (!base) throw new Error("Backed product format changed");
  const address = attr(base, "data-network-address");
  if (!address) return [];
  return [token(source, address, symbol, name, { notice: "Legacy bToken: new issuance discontinued. Review issuer redemption terms." })];
}

async function download(url, fetcher) {
  // workerd supports "manual" and "follow", but not the browser/Node "error"
  // redirect mode. Reject non-2xx below to retain the no-redirect trust boundary.
  const response = await fetcher(url, { signal: AbortSignal.timeout(12000), redirect: "manual", headers: { accept: "text/html, application/json" } });
  if (!response.ok) throw new Error(`Issuer source returned HTTP ${response.status}`);
  const text = await response.text();
  if (text.length > 6_000_000) throw new Error("Issuer response too large");
  return text;
}

export async function loadCatalog(fetcher = fetch, now = Date.now()) {
  const results = await Promise.all(SOURCES.map(async (source) => {
    try {
      const text = await download(source.url, fetcher);
      let tokens;
      if (source.kind === "base-api") tokens = parseBaseApi(JSON.parse(text), source);
      else if (source.kind === "base-page") tokens = parseBasePage(text, source);
      else if (source.kind === "token-list") tokens = parseTokenList(JSON.parse(text), source);
      else {
        const paths = [...new Set([...text.matchAll(/href="(\/products\/b[a-z0-9-]+)"/g)].map((m) => m[1]))];
        if (!paths.length || paths.length > 40) throw new Error("Backed product index changed");
        const pages = [];
        // Bound concurrency and stay within the Worker's subrequest budget.
        for (let i = 0; i < paths.length; i += 4) pages.push(...await Promise.all(paths.slice(i, i + 4).map(async (path) => parseBackedPage(await download(`https://assets.backed.fi${path}`, fetcher), source))));
        tokens = pages.flat();
      }
      return { source: { ...source, status: "ok", count: tokens.length }, tokens };
    } catch (error) {
      // These fetches only target the public issuer URLs above. Never log RPC
      // requests or secret configuration; keep source failures diagnosable.
      console.warn(JSON.stringify({ event: "stock_catalog_source_failed", source: source.id, error: error instanceof Error ? error.message.slice(0, 240) : "Unknown source failure" }));
      return { source: { ...source, status: "unavailable", count: 0 }, tokens: [] };
    }
  }));
  const unique = new Map();
  for (const t of results.flatMap((r) => r.tokens)) {
    const key = t.address.toLowerCase();
    if (unique.has(key) && unique.get(key).sourceId !== t.sourceId) throw new Error("Issuer sources disagree about a token");
    unique.set(key, t);
  }
  return { chainId: 8453, fetchedAt: now, expiresAt: now + TTL, partial: results.some((r) => r.source.status !== "ok"), sources: results.map((r) => r.source), tokens: [...unique.values()].sort((a, b) => a.symbol.localeCompare(b.symbol)) };
}

export async function stockCatalog(request) {
  if (request.method !== "GET") return Response.json({ error: "Use GET." }, { status: 405 });
  try {
    if (!cached || cached.expiresAt <= Date.now()) {
      pending ??= loadCatalog().finally(() => { pending = undefined; });
      cached = await pending;
      // Retry partial failures sooner. Never return an expired fallback as live.
      if (cached.partial) cached.expiresAt = Date.now() + 60000;
    }
    return Response.json(cached, { status: cached.tokens.length ? 200 : 503, headers: { "cache-control": "no-store" } });
  } catch { return Response.json({ error: "Stock catalog unavailable. Try again." }, { status: 503 }); }
}
