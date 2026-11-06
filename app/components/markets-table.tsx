"use client";

import { useRouter, useSearchParams } from "next/navigation";
import { useMemo, useState } from "react";
import { useSeriesList } from "@/lib/use-series";
import { useFavourites } from "@/lib/use-favourites";
import {
  useMarketPremiums,
  useReferencePrices,
  useCollateralMultipliers,
  annualizedPremiumPct,
  distanceToStrike,
  effectiveStrikeUsd,
  type MarketBid,
} from "@/lib/use-market-rows";
import { displayStatus, isMatured } from "@/lib/market-status";
import { assetFor } from "@/lib/issuers";
import { DEPLOYMENT } from "@/lib/deployment";
import { formatDate, fromRaw, shortAddress, timeUntil } from "@/lib/format";
import { useNow } from "@/lib/use-now";
import type { Series } from "@/lib/types";
import { EmptyState, Segmented } from "./ui";
import { MarketCard } from "./market-card";
import { StatusPill } from "./status-pill";

type Tab = "active" | "matured" | "starred";
type ExpiryFilter = "all" | "7" | "14" | "30" | "60";
type BidFilter = "all" | "live" | "none";
type DistanceFilter = "all" | "0-10" | "10-20" | "20+";
type SortKey = "opportunity" | "expiry" | "strike" | "premium";
type Sort = { key: SortKey; dir: 1 | -1 };

export function MarketsTable() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const { data, loading, error } = useSeriesList();
  const fav = useFavourites();
  const now = useNow();
  const prices = useReferencePrices(data);
  const multipliers = useCollateralMultipliers(data);
  const premiums = useMarketPremiums(data);
  const [tab, setTab] = useState<Tab>("active");
  const [sort, setSort] = useState<Sort>({ key: "opportunity", dir: 1 });
  const [query, setQuery] = useState("");
  const [stock, setStock] = useState(() => searchParams.get("stock")?.toLowerCase() ?? "all");
  const [expiry, setExpiry] = useState<ExpiryFilter>("all");
  const [bid, setBid] = useState<BidFilter>("all");
  const [distance, setDistance] = useState<DistanceFilter>("all");

  const stocks = useMemo(() => {
    const seen = new Set<string>();
    return data.flatMap((series) => {
      const token = series.config.collateral.toLowerCase();
      if (seen.has(token)) return [];
      seen.add(token);
      return [{ token, asset: assetFor(series.config.collateral) }];
    });
  }, [data]);

  const counts = useMemo(
    () => ({
      active: data.filter((s) => !isMatured(s, now)).length,
      matured: data.filter((s) => isMatured(s, now)).length,
      starred: data.filter((s) => fav.has(s.id.toString())).length,
    }),
    [data, now, fav],
  );

  const rows = useMemo(() => {
    const q = query.trim().toLowerCase();
    return data
      .filter((s) => {
        if (tab === "active" && isMatured(s, now)) return false;
        if (tab === "matured" && !isMatured(s, now)) return false;
        if (tab === "starred" && !fav.has(s.id.toString())) return false;
        if (stock !== "all" && s.config.collateral.toLowerCase() !== stock) return false;
        if (expiry !== "all") {
          const remaining = s.config.maturity - now;
          if (remaining <= 0n || remaining > BigInt(Number(expiry) * 86_400)) return false;
        }
        const marketBid = premiums.bidFor(s);
        if (!premiums.loading && bid === "live" && marketBid === null) return false;
        if (!premiums.loading && bid === "none" && marketBid !== null) return false;
        if (distance !== "all") {
          const value = distanceToStrike(s, prices.spotFor(s), multipliers.multiplierFor(s));
          if (value === null) return false;
          if (distance === "0-10" && (value < 0 || value > 10)) return false;
          if (distance === "10-20" && (value < 10 || value > 20)) return false;
          if (distance === "20+" && value < 20) return false;
        }
        if (!q) return true;
        const a = assetFor(s.config.collateral);
        return (
          (a?.symbol ?? "").toLowerCase().includes(q) ||
          (a?.name ?? "").toLowerCase().includes(q) ||
          s.config.collateral.toLowerCase().includes(q) ||
          (effectiveStrikeUsd(s, multipliers.multiplierFor(s))?.toFixed(2).includes(q) ?? false)
        );
      })
      .sort((a, b) => {
        const d = sort.dir;
        if (sort.key === "strike") {
          const left = effectiveStrikeUsd(a, multipliers.multiplierFor(a));
          const right = effectiveStrikeUsd(b, multipliers.multiplierFor(b));
          if (left === null) return right === null ? 0 : 1;
          if (right === null) return -1;
          return (left - right) * d;
        }
        if (sort.key === "premium") return ((premiums.premiumFor(b) ?? -1) - (premiums.premiumFor(a) ?? -1)) * d;
        if (sort.key === "opportunity") {
          const aBid = premiums.bidFor(a);
          const bBid = premiums.bidFor(b);
          if (Boolean(aBid) !== Boolean(bBid)) return aBid ? -1 : 1;
          const aSpot = prices.spotFor(a);
          const bSpot = prices.spotFor(b);
          const aReturn = annualizedPremiumPct(a, aBid, aSpot, now, multipliers.multiplierFor(a)) ?? -1;
          const bReturn = annualizedPremiumPct(b, bBid, bSpot, now, multipliers.multiplierFor(b)) ?? -1;
          if (aReturn !== bReturn) return (bReturn - aReturn) * d;
        }
        return Number(a.config.maturity - b.config.maturity) * d;
      });
  }, [data, tab, stock, expiry, bid, distance, query, sort, now, fav, premiums, prices, multipliers]);

  // The app is a static export. Query selection keeps every onchain market on
  // the permanent `/app` route instead of requiring one HTML file per id.
  const open = (s: Series) => router.push(`/app?market=${s.id.toString(16)}`);

  return (
    <div>
      <div className="mb-4 flex flex-wrap items-center gap-3">
        <Segmented
          label="Market lifecycle"
          value={tab}
          onChange={setTab}
          options={(["active", "matured", "starred"] as Tab[]).map((t) => ({
            value: t,
            label: (
              <span className="capitalize">
                {t}
                <span className="ml-1.5 font-mono text-[0.75rem] opacity-60">{counts[t]}</span>
              </span>
            ),
          }))}
        />

        <div className="border-line bg-panel focus-within:border-accent hover:border-muted flex min-w-[16rem] flex-1 items-center gap-2 rounded-sm border px-3 transition-colors">
          <SearchIcon />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search strike, underlying, or token address"
            aria-label="Search markets"
            className="placeholder:text-dim/70 w-full bg-transparent py-1.5 text-[0.85rem] outline-none"
          />
          {query && (
            <button
              type="button"
              onClick={() => setQuery("")}
              aria-label="Clear search"
              className="text-dim hover:text-text shrink-0 text-sm transition-colors"
            >
              ✕
            </button>
          )}
        </div>
      </div>

      <div className="border-line-soft mb-5 grid items-end gap-3 border-b pb-4 sm:flex sm:flex-wrap">
        <label className="w-full sm:w-auto sm:min-w-[11rem]">
          <span className="text-dim mb-1.5 block text-[0.72rem] tracking-[0.08em] uppercase">
            Stock
          </span>
          <select
            value={stock}
            onChange={(event) => {
              const value = event.target.value;
              setStock(value);
              const params = new URLSearchParams(window.location.search);
              if (value === "all") params.delete("stock");
              else params.set("stock", value);
              window.history.replaceState(null, "", params.size ? `?${params}` : window.location.pathname);
            }}
            className="border-line bg-panel focus:border-accent w-full rounded-sm border px-3 py-1.5 text-[0.85rem] outline-none"
          >
            <option value="all">All stocks</option>
            {stocks.map(({ token, asset }) => (
              <option key={token} value={token}>
                {asset ? `${asset.symbol} · ${asset.name}` : shortAddress(token, 4)}
              </option>
            ))}
          </select>
        </label>
        <div className="min-w-0 overflow-x-auto">
          <span className="text-dim mb-1.5 block text-[0.72rem] tracking-[0.08em] uppercase">
            Expires within
          </span>
          <Segmented
            label="Expiry window"
            size="sm"
            value={expiry}
            onChange={setExpiry}
            options={(["all", "7", "14", "30", "60"] as ExpiryFilter[]).map((value) => ({
              value,
              label: value === "all" ? "All" : `${value}D`,
            }))}
          />
        </div>
        <div className="min-w-0 overflow-x-auto">
          <span className="text-dim mb-1.5 block text-[0.72rem] tracking-[0.08em] uppercase">
            Sell-price distance
          </span>
          <Segmented
            label="Sell-price distance"
            size="sm"
            value={distance}
            onChange={setDistance}
            options={([
              { value: "all", label: "All" },
              { value: "0-10", label: "0–10%" },
              { value: "10-20", label: "10–20%" },
              { value: "20+", label: "20%+" },
            ] as const)}
          />
        </div>
        <label className="w-full sm:w-auto sm:min-w-[12rem]">
          <span className="text-dim mb-1.5 block text-[0.72rem] tracking-[0.08em] uppercase">
            Rank by
          </span>
          <select
            value={sort.key}
            onChange={(event) => setSort({ key: event.target.value as SortKey, dir: 1 })}
            className="border-line bg-panel focus:border-accent w-full rounded-sm border px-3 py-1.5 text-[0.85rem] outline-none"
          >
            <option value="opportunity">Highest annualized premium</option>
            <option value="premium">Highest cash premium</option>
            <option value="expiry">Shortest expiry</option>
            <option value="strike">Lowest sell price</option>
          </select>
        </label>
        <div className="min-w-0 overflow-x-auto">
          <span className="text-dim mb-1.5 block text-[0.72rem] tracking-[0.08em] uppercase">
            Bid status
          </span>
          <Segmented
            label="Bid status"
            size="sm"
            value={bid}
            onChange={setBid}
            options={([
              { value: "all", label: "All" },
              { value: "live", label: "Live bid" },
              { value: "none", label: "No bid" },
            ] as const)}
          />
        </div>
      </div>

      {loading ? (
        <Skeleton />
      ) : error ? (
        <EmptyState title="Could not load markets" body={error} />
      ) : rows.length === 0 ? (
        <EmptyRows
          tab={tab}
          query={query}
          total={data.length}
          filtered={stock !== "all" || expiry !== "all" || bid !== "all" || distance !== "all"}
        />
      ) : (
        <>
          <div className="grid gap-2 md:hidden">
            {rows.map((s) => (
              <MarketCard
                key={s.id.toString()}
                series={s}
                spot={prices.spotFor(s)}
                bid={premiums.bidFor(s)}
                bidLoading={premiums.loading}
                multiplier={multipliers.multiplierFor(s)}
                starred={fav.has(s.id.toString())}
                onStar={() => fav.toggle(s.id.toString())}
                onOpen={() => open(s)}
              />
            ))}
          </div>

          <div className="border-line bg-panel relative hidden overflow-x-auto border-y md:block">
            <table className="w-full min-w-[74rem] border-collapse text-left">
              <thead>
                <tr className="border-line-soft text-dim border-b text-[0.8125rem] tracking-wide uppercase">
                  <th className="w-8 px-2 py-2.5 font-normal"><span className="sr-only">Starred</span></th>
                  <th className="px-3 py-2.5 font-normal">Market</th>
                  <th className="px-3 py-2.5 text-right font-normal">Reference</th>
                  <Header label="Strike" k="strike" sort={sort} setSort={setSort} />
                  <th className="px-3 py-2.5 text-right font-normal">Distance</th>
                  <Header label="Expiry" k="expiry" sort={sort} setSort={setSort} />
                  <Header label="Best bid" k="premium" sort={sort} setSort={setSort} />
                  <th className="px-3 py-2.5 text-right font-normal">Annualized*</th>
                  <th className="px-3 py-2.5 text-right font-normal">Funded size</th>
                  <th className="px-3 py-2.5 font-normal">Status</th>
                  <th className="px-3 py-2.5 font-normal"><span className="sr-only">Open market</span></th>
                </tr>
              </thead>
              <tbody>
                {rows.map((s) => (
                  <Row
                    key={s.id.toString()}
                    series={s}
                    spot={prices.spotFor(s)}
                    bid={premiums.bidFor(s)}
                    bidLoading={premiums.loading}
                    multiplier={multipliers.multiplierFor(s)}
                    starred={fav.has(s.id.toString())}
                    onStar={() => fav.toggle(s.id.toString())}
                    onOpen={() => open(s)}
                  />
                ))}
              </tbody>
            </table>
          </div>
          <p className="text-dim mt-3 text-[0.75rem] leading-5">
            * Simple annualized premium uses the current funded bid, settlement reference, and
            remaining term. It does not compound or include fees, points, dividends, or partner rewards.
          </p>
        </>
      )}
    </div>
  );
}

function Row({
  series,
  spot,
  bid,
  bidLoading,
  multiplier,
  starred,
  onStar,
  onOpen,
}: {
  series: Series;
  spot: number | null;
  bid: MarketBid | null;
  bidLoading: boolean;
  multiplier: bigint | null;
  starred: boolean;
  onStar: () => void;
  onOpen: () => void;
}) {
  const now = useNow();
  const asset = assetFor(series.config.collateral);
  const status = displayStatus(series, now);
  const distance = distanceToStrike(series, spot, multiplier);
  const sellPrice = effectiveStrikeUsd(series, multiplier);
  const symbol = DEPLOYMENT.quote?.symbol ?? "";
  const matured = status !== "Open" && status !== "Paused";
  const annualized = annualizedPremiumPct(series, bid, spot, now, multiplier);

  return (
    <tr
      data-tour="series-card"
      role="link"
      tabIndex={0}
      onClick={onOpen}
      onKeyDown={(e) => {
        if (e.key === "Enter") onOpen();
      }}
      className="border-line-soft hover:bg-panel-2/60 focus-visible:outline-accent cursor-pointer border-b transition-colors focus-visible:outline-2"
    >
      <td className="px-2 py-3.5">
        <span
          role="button"
          data-tour-no-advance
          tabIndex={0}
          aria-label={starred ? "Unstar this market" : "Star this market"}
          onClick={(e) => {
            e.stopPropagation();
            onStar();
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter" || e.key === " ") {
              e.preventDefault();
              e.stopPropagation();
              onStar();
            }
          }}
          className={`cursor-pointer leading-none ${starred ? "text-accent" : "text-dim hover:text-muted"}`}
        >
          {starred ? "★" : "☆"}
        </span>
      </td>
      <td className="px-3 py-3.5">
        <div className="font-medium">
          {asset?.symbol ?? "Unknown"} / {symbol}
        </div>
        <div className="text-dim mt-0.5 text-[0.75rem]">
          {asset?.name ?? shortAddress(series.config.collateral, 4)}
        </div>
      </td>
      <td className="text-muted px-3 py-3.5 text-right font-mono tabular-nums">
        {spot === null ? "—" : `$${spot.toFixed(2)}`}
      </td>
      <td className="px-3 py-3.5 text-right font-mono tabular-nums" title="Adjusted for the current multiplier; settlement fixes the final strike">{sellPrice === null ? "Unavailable" : `$${sellPrice.toFixed(2)}`}</td>
      <td
        className={`px-3 py-3.5 text-right font-mono tabular-nums ${
          distance === null ? "text-dim" : distance >= 0 ? "text-p" : "text-n"
        }`}
        title="How far the strike sits from the reference price"
      >
        {distance === null ? "—" : `${distance >= 0 ? "+" : ""}${distance.toFixed(1)}%`}
      </td>
      <td className="px-3 py-3.5 text-right font-mono tabular-nums" title={formatDate(series.config.maturity)}>
        {status === "Redeemable" ? "—" : status === "Awaiting settlement" ? "Expired" : timeUntil(series.config.maturity)}
      </td>
      <td className="px-3 py-3.5 text-right font-mono tabular-nums">
        {matured ? (
          <span className="text-dim">—</span>
        ) : bid === null ? (
          <span className="text-dim" title="No market maker returned a usable funded quote">
            {bidLoading ? "…" : "No live bid"}
          </span>
        ) : (
          <div>
            <span className="text-p">{bid.premium.toFixed(2)} {symbol}</span>
            <div className="text-dim mt-0.5 text-[0.7rem]">expires {timeUntil(bid.expiry)}</div>
          </div>
        )}
      </td>
      <td className="px-3 py-3.5 text-right font-mono tabular-nums">
        {annualized === null ? <span className="text-dim">—</span> : `${annualized.toFixed(1)}%`}
      </td>
      <td className="px-3 py-3.5 text-right font-mono tabular-nums">
        {bid === null ? (
          <span className="text-dim">—</span>
        ) : (
          `${fromRaw(bid.quoteSize, series.config.collateralDecimals, 4)} ${asset?.symbol ?? "stock"} upside`
        )}
      </td>
      <td className="px-3 py-3.5"><StatusPill status={status} /></td>
      <td className="text-dim px-3 py-3.5 text-right text-[0.8125rem]" aria-hidden>→</td>
    </tr>
  );
}

function Header({
  label,
  k,
  sort,
  setSort,
}: {
  label: string;
  k: SortKey;
  sort: Sort;
  setSort: (s: Sort) => void;
}) {
  const active = sort.key === k;
  return (
    // `aria-sort` describes the column, so it belongs on the header cell.
    // On the button it is silently ignored, which is worse than absent.
    <th
      className="px-3 py-2.5 text-right font-normal"
      aria-sort={active ? (sort.dir === 1 ? "ascending" : "descending") : "none"}
    >
      <button
        type="button"
        onClick={() => setSort({ key: k, dir: active && sort.dir === 1 ? -1 : 1 })}
        className={`transition-colors ${active ? "text-text" : "hover:text-text"}`}
      >
        {label}
        {active && <span aria-hidden>{sort.dir === 1 ? " ↑" : " ↓"}</span>}
      </button>
    </th>
  );
}

/** Rows shaped like the ones that are coming, so the layout does not jump. */
function Skeleton() {
  return (
    <div className="grid gap-2">
      {[0, 1, 2].map((i) => (
        <div key={i} className="border-line bg-panel h-14 animate-pulse rounded-md border" />
      ))}
    </div>
  );
}

/** An empty list should say which emptiness this is. */
function EmptyRows({
  tab,
  query,
  total,
  filtered,
}: {
  tab: Tab;
  query: string;
  total: number;
  filtered: boolean;
}) {
  if (total === 0) {
    return (
      <EmptyState
        title="No markets yet"
        body="Nothing has been listed. A market becomes visible here once the registry marks it canonical."
      />
    );
  }
  if (query) {
    return <EmptyState title="Nothing matches" body={`No market matches “${query}”.`} />;
  }
  if (filtered) {
    return (
      <EmptyState
        title="No matching markets"
        body="No market matches the selected stock, expiry, and bid filters."
      />
    );
  }
  if (tab === "starred") {
    return <EmptyState title="No starred markets" body="Star a market and it will collect here." />;
  }
  if (tab === "matured") {
    return <EmptyState title="Nothing has expired yet" body="Markets appear here once trading stops." />;
  }
  return <EmptyState title="No active markets" body="Every listed market has expired." />;
}

function SearchIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden className="text-dim shrink-0">
      <circle cx="7" cy="7" r="4.5" stroke="currentColor" strokeWidth="1.5" />
      <path d="M10.5 10.5L14 14" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
    </svg>
  );
}
