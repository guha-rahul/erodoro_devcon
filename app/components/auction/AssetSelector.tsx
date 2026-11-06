"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import type { StockRow } from "@/lib/use-stock-balances";
import { fromRaw } from "@/lib/format";
import { toShareEquivalent } from "@/lib/use-b20";

/** Asset dropdown: selected asset shown, options + search open on click. */
export function AssetSelector({
  assets,
  value,
  onChange,
}: {
  assets: StockRow[];
  value: string;
  onChange: (token: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const root = useRef<HTMLDivElement>(null);

  const selected = assets.find((a) => a.token.toLowerCase() === value.toLowerCase()) ?? null;

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return assets;
    return assets.filter(
      (a) =>
        a.symbol.toLowerCase().includes(q) ||
        a.name.toLowerCase().includes(q) ||
        a.token.toLowerCase().includes(q),
    );
  }, [assets, query]);

  // Close on outside click or Escape.
  useEffect(() => {
    if (!open) return;
    const close = (e: PointerEvent) => {
      if (root.current && !root.current.contains(e.target as Node)) setOpen(false);
    };
    const esc = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("pointerdown", close);
    document.addEventListener("keydown", esc);
    return () => {
      document.removeEventListener("pointerdown", close);
      document.removeEventListener("keydown", esc);
    };
  }, [open ]);

  const pick = (token: string) => {
    onChange(token);
    setOpen(false);
    setQuery("");
  };

  const selectedShares = selected ? (selected.shares ?? toShareEquivalent(selected.balance, selected.multiplier)) : 0n;

  return (
    <div ref={root} className="relative">
      <button
        type="button"
        aria-haspopup="listbox"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
        className={`flex w-full items-center justify-between gap-4 rounded-md border px-4 py-3 text-left transition-colors ${
          open ? "border-accent bg-panel" : "border-line-soft hover:border-line"
        }`}
      >
        {selected ? (
          <span>
            <span className="block text-[0.9375rem] font-medium">{selected.symbol}</span>
            <span className="text-dim block text-[0.78rem]">{selected.name}</span>
          </span>
        ) : (
          <span className="text-dim text-[0.9375rem]">Choose an asset…</span>
        )}
        <span className="flex items-center gap-3">
          {selected && (
            <span className="text-muted font-mono text-[0.8125rem] tabular-nums">
              {fromRaw(selectedShares, selected.decimals, 4)}
            </span>
          )}
          <span aria-hidden="true" className="text-dim text-xs">{open ? "▲" : "▼"}</span>
        </span>
      </button>

      {open && (
        <div className="border-line bg-panel absolute z-20 mt-1 max-h-72 w-full overflow-auto rounded-md border shadow-lg">
          <div className="sticky top-0 p-2">
            <input
              autoFocus
              type="search"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search by name, symbol, or token address…"
              aria-label="Search assets"
              className="border-line-soft bg-bg focus:border-accent w-full rounded-md border px-3 py-2 text-sm outline-none"
            />
          </div>
          <ul role="listbox" aria-label="Asset" className="grid gap-1 p-2 pt-0">
            {filtered.map((a) => {
              const isSelected = value.toLowerCase() === a.token.toLowerCase();
              const shares = a.shares ?? toShareEquivalent(a.balance, a.multiplier);
              return (
                <li key={a.token}>
                  <button
                    type="button"
                    role="option"
                    aria-selected={isSelected}
                    onClick={() => pick(a.token)}
                    className={`flex w-full items-center justify-between gap-4 rounded-md px-3 py-2.5 text-left transition-colors ${
                      isSelected ? "bg-accent/10 text-text" : "hover:bg-bg text-text"
                    }`}
                  >
                    <span>
                      <span className="block text-[0.9375rem] font-medium">{a.symbol}</span>
                      <span className="text-dim block text-[0.78rem]">{a.name}</span>
                    </span>
                    <span className="text-muted font-mono text-[0.8125rem] tabular-nums">
                      {fromRaw(shares, a.decimals, 4)}
                    </span>
                  </button>
                </li>
              );
            })}
            {filtered.length === 0 && (
              <li className="text-dim px-3 py-2 text-sm" role="status">
                {assets.length === 0
                  ? "No live markets — nothing to auction against."
                  : `No assets match “${query.trim()}”.`}
              </li>
            )}
          </ul>
        </div>
      )}
    </div>
  );
}
