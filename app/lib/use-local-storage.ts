"use client";

import { useCallback, useSyncExternalStore } from "react";

/**
 * A `localStorage` value, read the way React wants external state read.
 *
 * The obvious version — read it in an effect and `setState` — causes a cascading
 * render and is exactly what `useSyncExternalStore` exists to replace.
 * `localStorage` is external mutable state, so it gets subscribed to rather
 * than copied into component state.
 *
 * The server snapshot is the fallback, so what is prerendered matches the first
 * client paint and hydration does not complain.
 */
const listeners = new Set<() => void>();

function emit() {
  listeners.forEach((l) => l());
}

function subscribe(fn: () => void) {
  listeners.add(fn);
  // Another tab writing the same key counts as a change here too.
  window.addEventListener("storage", fn);
  return () => {
    listeners.delete(fn);
    window.removeEventListener("storage", fn);
  };
}

export function useLocalStorage<T>(key: string, fallback: T, parse: (raw: string) => T) {
  const value = useSyncExternalStore(
    subscribe,
    () => {
      try {
        const raw = window.localStorage.getItem(key);
        return raw === null ? fallback : parse(raw);
      } catch {
        // Blocked or corrupt storage: behave as if nothing was saved.
        return fallback;
      }
    },
    () => fallback,
  );

  const set = useCallback(
    (next: T) => {
      try {
        window.localStorage.setItem(key, typeof next === "string" ? next : JSON.stringify(next));
      } catch {
        // Ignore: the choice simply will not persist.
      }
      emit();
    },
    [key],
  );

  return [value, set] as const;
}
