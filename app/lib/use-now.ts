"use client";

import { useSyncExternalStore } from "react";

/**
 * The current unix second, as a subscribable store.
 *
 * Reading `Date.now()` during render is impure and, worse, means a component
 * never notices time passing — a series would stay on "not yet" past its own
 * maturity until something else forced a re-render. Subscribing fixes both.
 */
let now = Math.floor(Date.now() / 1000);
const listeners = new Set<() => void>();
let timer: ReturnType<typeof setInterval> | null = null;

function subscribe(fn: () => void) {
  listeners.add(fn);
  if (!timer) {
    timer = setInterval(() => {
      const next = Math.floor(Date.now() / 1000);
      if (next !== now) {
        now = next;
        listeners.forEach((l) => l());
      }
    }, 1_000);
  }
  return () => {
    listeners.delete(fn);
    if (listeners.size === 0 && timer) {
      clearInterval(timer);
      timer = null;
    }
  };
}

/** Server snapshot is 0 so prerender and first client paint agree. */
export function useNow(): bigint {
  return BigInt(useSyncExternalStore(subscribe, () => now, () => 0));
}
