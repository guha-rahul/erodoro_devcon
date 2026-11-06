"use client";

import { useAccount } from "wagmi";
import { assetFor } from "@/lib/issuers";
import { useB20 } from "@/lib/use-b20";
import { DEPLOYMENT, explorer } from "@/lib/deployment";
import type { Series } from "@/lib/types";
import { Panel } from "./ui";

/**
 * What the collateral behind this market actually is, and what its issuer can
 * still do to it.
 *
 * The rest of the market screen is about the trade. This is about the thing
 * being traded — who issues it, where it is custodied, and which of the
 * issuer's controls are live right now. Those controls are not theoretical:
 * on the live tokens every transfer policy scope is already armed and merely
 * permissive, which is one list entry away from not being.
 */
export function MarketProfile({ series }: { series: Series }) {
  const { address } = useAccount();
  const asset = assetFor(series.config.collateral);
  const b20 = useB20(series.config.collateral, address, (DEPLOYMENT.contracts.vault as `0x${string}`) ?? undefined);

  const rebased = b20.multiplier !== null && b20.multiplier !== 10n ** 18n;

  return (
    <Panel title="About the collateral" subtitle={asset ? `${asset.symbol} · ${asset.name}` : series.config.collateral}>
      <dl className="grid gap-2 text-[0.875rem]">
        <Row label="Issuer" value={asset?.issuer ?? "Unknown"} />
        <Row label="Decimals" value={String(series.config.collateralDecimals)} />
        <Row
          label="Corporate actions"
          value={rebased ? "Rebased since issue" : "None applied"}
          tone={rebased ? "n" : undefined}
        />
        <Row
          label="Transfers"
          value={b20.transferPaused ? "Paused by the issuer" : "Live"}
          tone={b20.transferPaused ? "danger" : undefined}
        />
        <Row
          label="Transfer policies"
          value={b20.policiesArmed ? "Armed" : "Unrestricted"}
          tone={b20.policiesArmed ? "n" : undefined}
        />
      </dl>

      {b20.policiesArmed && !b20.blockedReason && (
        <p className="text-dim mt-3 text-[0.78rem] leading-5">
          Armed does not mean blocked. The issuer has a policy in place that currently authorises
          this vault and your address; adding an entry to it would not require a redeployment.
        </p>
      )}

      {asset?.isTestAsset && (
        <p className="border-n/30 bg-n/8 text-n mt-3 rounded-sm border px-3 py-2 text-[0.8125rem]">
          A test asset. Not a security, and not backed by anything.
        </p>
      )}

      <div className="border-line-soft mt-4 flex flex-wrap gap-4 border-t pt-3 text-[0.8125rem]">
        <a
          href={explorer(series.config.collateral)}
          target="_blank"
          rel="noreferrer"
          className="text-muted hover:text-text underline underline-offset-2"
        >
          Token contract ↗
        </a>
        {asset?.productUrl && (
          <a
            href={asset.productUrl}
            target="_blank"
            rel="noreferrer"
            className="text-muted hover:text-text underline underline-offset-2"
          >
            Issuer product page ↗
          </a>
        )}
        {asset?.corporateActionsUrl && (
          <a
            href={asset.corporateActionsUrl}
            target="_blank"
            rel="noreferrer"
            className="text-muted hover:text-text underline underline-offset-2"
          >
            Corporate actions ↗
          </a>
        )}
      </div>
    </Panel>
  );
}

function Row({ label, value, tone }: { label: string; value: string; tone?: "n" | "danger" }) {
  return (
    <div className="border-line-soft flex items-baseline justify-between gap-4 border-t pt-2 first:border-t-0 first:pt-0">
      <dt className="text-dim">{label}</dt>
      <dd className={`text-right ${tone === "danger" ? "text-danger" : tone === "n" ? "text-n" : ""}`}>{value}</dd>
    </div>
  );
}
