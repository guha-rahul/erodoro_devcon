"use client";

import { useQuery } from "@tanstack/react-query";
import { parseAbiItem } from "viem";
import { publicClient } from "./chain";
import type { Address } from "./types";

/**
 * Corporate-action disclosures from the token issuer.
 *
 * B20 brackets a corporate action between `Announcement` and `EndAnnouncement`,
 * carrying an id, a description and a disclosure URI. The instant multiplier
 * setter emits `MultiplierUpdated` and is the emergency override — an action
 * that appears *without* a surrounding announcement is exactly that, and worth
 * showing differently.
 *
 * The text is written by the issuer. It is displayed as a disclosure, never
 * parsed to decide anything: a contract that branched on free-form strings
 * would have invented a new attack surface rather than closed one.
 */
const ANNOUNCEMENT = parseAbiItem(
  "event Announcement(address indexed caller, string id, string description, string uri)",
);
const MULTIPLIER_UPDATED = parseAbiItem("event MultiplierUpdated(uint256 multiplier)");

/** Public endpoints cap `eth_getLogs`; stay inside it rather than be rejected. */
const MAX_LOOKBACK = 9_000n;

export type Disclosure = {
  kind: "announcement" | "multiplier";
  id?: string;
  description?: string;
  uri?: string;
  multiplier?: bigint;
  block: bigint;
};

export function useAnnouncements(token?: Address) {
  return useQuery({
    queryKey: ["announcements", token ?? null],
    enabled: Boolean(token),
    refetchInterval: 60_000,
    queryFn: async (): Promise<Disclosure[]> => {
      if (!token) return [];
      const head = await publicClient.getBlockNumber();
      const fromBlock = head > MAX_LOOKBACK ? head - MAX_LOOKBACK : 0n;

      const [announcements, multipliers] = await Promise.all([
        publicClient.getLogs({ address: token, event: ANNOUNCEMENT, fromBlock, toBlock: head }),
        publicClient.getLogs({ address: token, event: MULTIPLIER_UPDATED, fromBlock, toBlock: head }),
      ]);

      const out: Disclosure[] = [
        ...announcements.map((l) => ({
          kind: "announcement" as const,
          id: l.args.id,
          description: l.args.description,
          uri: l.args.uri,
          block: l.blockNumber ?? 0n,
        })),
        ...multipliers.map((l) => ({
          kind: "multiplier" as const,
          multiplier: l.args.multiplier,
          block: l.blockNumber ?? 0n,
        })),
      ];
      return out.sort((a, b) => Number(b.block - a.block));
    },
  });
}
