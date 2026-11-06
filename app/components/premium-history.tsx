"use client";

import { useAccount } from "wagmi";
import { useQueryClient } from "@tanstack/react-query";
import { DEPLOYMENT, txExplorer } from "@/lib/deployment";
import { fromRaw, shortAddress } from "@/lib/format";
import { usePremiumHistory } from "@/lib/use-premium-history";
import { Button, Panel } from "./ui";

export function PremiumHistory() {
  const { address } = useAccount();
  const history = usePremiumHistory();
  const client = useQueryClient();
  const quote = DEPLOYMENT.quote;
  const pages = history.data?.pages ?? [];
  const events = pages.flatMap((page) => page.events);
  const isWallet = (value: string) => value.toLowerCase() === address?.toLowerCase();
  function exportCsv() {
    if (!address || pages.length === 0) return;
    const from = pages.at(-1)!.fromBlock.toString(), to = pages[0].toBlock.toString();
    const rows = [
      ["chain_id", "rfq_contract", "wallet", "coverage_from_block", "coverage_to_block", "block", "transaction_hash", "log_index", "claim_id", "claim_amount_raw", "payment_token", "payment_amount_raw", "received", "spent", "receipt_url"],
      ...events.map((event) => [
        String(DEPLOYMENT.chainId), DEPLOYMENT.contracts.rfq!, address, from, to,
        event.blockNumber.toString(), event.transactionHash, String(event.logIndex),
        event.args.claimId.toString(), event.args.claimAmount.toString(), event.args.quoteToken,
        event.args.quoteAmount.toString(), String(isWallet(event.args.taker)), String(isWallet(event.args.maker)), txExplorer(event.transactionHash),
      ]),
    ];
    const csv = rows.map((row) => row.map((value) => `"${value.replaceAll('"', '""')}"`).join(",")).join("\r\n");
    const url = URL.createObjectURL(new Blob([csv], { type: "text/csv;charset=utf-8" }));
    const link = document.createElement("a");
    link.href = url;
    link.download = `erodoro-${DEPLOYMENT.chainId}-${address}-${from}-${to}.csv`;
    link.click();
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  return (
    <Panel title="Premium history" subtitle="Recent payments from direct trades">
      {!address ? <p className="text-muted text-sm">Connect a wallet to view premium payments.</p>
        : !DEPLOYMENT.contracts.rfq ? <p className="text-muted text-sm">Payment history is unavailable on this network.</p>
        : <>
          {history.isPending && <p role="status" className="text-muted text-sm">Loading premium payments…</p>}
          {pages.length > 0 && <>
            {events.length === 0 && <p className="text-muted text-sm">No recent payments found.</p>}
            <ul className="mt-4 divide-y divide-[var(--color-line-soft)]">
              {events.map((event) => {
                const sameToken = event.args.quoteToken.toLowerCase() === quote?.token.toLowerCase();
                const selfFill = isWallet(event.args.maker) && isWallet(event.args.taker);
                return <li key={`${event.transactionHash}:${event.logIndex}`} className="flex flex-wrap justify-between gap-2 py-3 text-sm">
                  <span>{selfFill ? "Premium earned and paid" : isWallet(event.args.taker) ? "Premium earned" : "Premium paid"}</span>
                  <span className="font-mono">{sameToken && quote ? `${fromRaw(event.args.quoteAmount, quote.decimals, 2)} ${quote.symbol}` : `${event.args.quoteAmount.toString()} raw units (${shortAddress(event.args.quoteToken)})`}</span>
                  <a href={txExplorer(event.transactionHash)} target="_blank" rel="noopener noreferrer" className="text-muted hover:text-text underline underline-offset-4">View receipt ↗</a>
                </li>;
              })}
            </ul>
          </>}
          {history.error && <p role="alert" className="text-n mt-3 text-sm">{pages.length ? "Could not load more payments. Your existing history is still shown." : "Could not load payment history. Try refreshing."}</p>}
          <div className="mt-4 flex flex-wrap gap-3">
            <Button busy={history.isFetching} disabled={history.isFetching} onClick={() => client.resetQueries({ queryKey: ["premium-history", DEPLOYMENT.chainId, DEPLOYMENT.contracts.rfq, address], exact: true })}>Refresh</Button>
            {history.hasNextPage && <Button tone="ghost" disabled={history.isFetching} onClick={() => history.fetchNextPage()}>Show older payments</Button>}
            {events.length > 0 && <Button tone="ghost" disabled={history.isFetching} onClick={exportCsv}>Export CSV</Button>}
          </div>
        </>}
    </Panel>
  );
}
