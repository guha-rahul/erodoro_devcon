"use client";

import { useLocalStorage } from "./use-local-storage";

export type Role = "seller" | "buyer";

const KEY = "erodoro.role";

/**
 * Which side of the trade this visitor is on.
 *
 * The protocol is symmetric; the two users are not. A seller arrives holding a
 * stock and wants cash for the upside. A buyer arrives holding cash and wants
 * the upside. Showing both of them the same screen serves neither, so the role
 * decides which action leads.
 */
export function useRole() {
  return useLocalStorage<Role>(KEY, "seller", (raw) => (raw === "buyer" ? "buyer" : "seller"));
}
