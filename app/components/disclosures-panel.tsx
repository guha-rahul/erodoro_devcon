"use client";

import { useAnnouncements } from "@/lib/use-announcements";
import type { Address } from "@/lib/types";
import { Panel } from "./ui";

/**
 * Corporate-action disclosures from the token issuer.
 *
 * Shown, never parsed. The text is written by the issuer, so a contract that
 * branched on it would be trusting a string with money. A multiplier change
 * that arrives *without* a surrounding announcement is the emergency override,
 * and is called out as such rather than listed the same way.
 */
export function DisclosuresPanel({ token }: { token: Address }) {
  const { data, isLoading } = useAnnouncements(token);
  const items = data ?? [];

  return (
    <Panel title="Issuer disclosures" subtitle="Corporate actions on the collateral">
      {isLoading ? (
        <p className="text-muted text-sm">Reading recent disclosures…</p>
      ) : items.length === 0 ? (
        <p className="text-muted text-sm">
          No corporate action in recent history. A split or a rebase would appear here, and the
          strike is adjusted for one automatically at settlement.
        </p>
      ) : (
        <ul className="divide-line-soft divide-y">
          {items.map((d, i) => (
            <li key={`${d.block}-${i}`} className="py-3">
              {d.kind === "announcement" ? (
                <>
                  <div className="font-mono text-[0.8125rem]">{d.id}</div>
                  <p className="text-muted mt-1 text-sm">{d.description}</p>
                  {d.uri && (
                    <a
                      href={d.uri}
                      target="_blank"
                      rel="noreferrer"
                      className="text-muted hover:text-text mt-1 inline-block text-[0.8125rem] underline underline-offset-2"
                    >
                      Disclosure ↗
                    </a>
                  )}
                </>
              ) : (
                <>
                  <div className="text-n font-mono text-[0.8125rem]">Multiplier changed directly</div>
                  <p className="text-muted mt-1 text-sm">
                    Set to {d.multiplier?.toString()} without a surrounding announcement. That is
                    the issuer&rsquo;s emergency override rather than a scheduled corporate action.
                  </p>
                </>
              )}
            </li>
          ))}
        </ul>
      )}
    </Panel>
  );
}
