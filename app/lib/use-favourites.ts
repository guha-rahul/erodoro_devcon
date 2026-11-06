"use client";

import { useCallback } from "react";
import { useLocalStorage } from "./use-local-storage";

const KEY = "erodoro:favourites";

/**
 * Starred markets.
 *
 * Deliberately local rather than on chain: a favourite is a browsing
 * preference, not a position, and writing it to a wallet-signed account would
 * cost a transaction to express something only this browser needs to know.
 */
export function useFavourites() {
  const [ids, setIds] = useLocalStorage<string[]>(KEY, [], (raw) => {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as string[]) : [];
  });

  const toggle = useCallback(
    (id: string) => setIds(ids.includes(id) ? ids.filter((x) => x !== id) : [...ids, id]),
    [ids, setIds],
  );

  return { ids, toggle, has: (id: string) => ids.includes(id) };
}
