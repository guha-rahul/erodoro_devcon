# Market Rips development provenance

Prepared on 8 October 2026. This records code reuse; it does not establish competition eligibility or alter development dates.

## Existing Solana experience reused

The design and substantial presentation code come from `Erodoro_Stocklana`, branch `rips`, commit `ce82ace4f5f63139a9f48915907c3a2ab73d1d44` (original commit date `2026-10-03T15:31:09+05:30`), **including its working-tree changes**. Five source components were already modified: `my-rips.tsx`, `rip-flow.tsx`, `rips-home.tsx`, `rips-shell.tsx`, and `share-card.tsx`.

Reused and adapted:

- `web/components/rips/{bits,my-rips,rip-card,rip-detail,rip-flow,rips-home,share-card}.tsx` → corresponding `app/components/rips/` files. Includes the home composition, ticker monograms, card layouts, reveal animation, purchase amount selector, sorting, progressive details, canvas sharing image, and share sheet.
- `web/lib/rips/{model,demo,store}.ts` → `app/lib/rips/` with Base metadata, separate actual cost/holdings, explicit simulation labels, and chain-scoped demo persistence.
- Source Rips route wrappers → Base `/rips` and `/rips/position?id=…`; share entry links target `/market-rip`.
- Source Rips CSS → appended Rips section in `app/app/globals.css`, including reduced-motion behavior.

The deterministic cryptocurrency demo catalog and simulated payoff model are prior source work. They are explicitly a demo, do not represent Base stock inventory, and never submit transactions.

The source repository, branch, dates, and uncommitted work were left unchanged. The [source manifest](rips-evidence/source-provenance.json) records working-tree SHA-256 hashes, source commit/date, and destination starting commit. These hashes were rechecked after the port.

## Existing Base work adopted

Before this port, the destination already contained uncommitted `MarketRipPool`, `MarketRipPut`, their original tests, deployment/seed scaffolding, generated interfaces, a basic `/market-rip` screen, and Rips address configuration. These are **pre-existing Base development**, not Solana code and not all newly authored in this session.

The existing Base vault, Factory, ERC-6909 claims, settlement models, payment-token configuration, Wagmi connections, public RPC client, and app shell remain the foundation. Unrelated intent, auction, indexer, oracle, and infrastructure edits were preserved outside the Rips commits.

## New Base port work

- `MarketRipPool.ripUp`, inventory commitment, directed `buyPosition`, upgraded-pool feature probe, and exact atomic payment/claim delivery. Original mixed UP/DOWN `rip()` remains available to existing integrations; the Rips experience uses N upside only.
- Base on-chain loader, receipt verification, incremental purchase-event history, actual token metadata/decimals, account isolation, RPC/wallet chain checks, bounded approvals, transaction statuses, and settled N redemption.
- Base-specific Rips shell, navigation, live/demo separation, position search, recovery states, and truthful disclosure of unavailable resale prices and collateral-token settlement.
- Direct-link hydration repair, focus handling for nested dialogs, wallet cancellation recovery, mobile layout adaptations, and meaningful contract/model/receipt/history tests.
- Isolated Base Sepolia deployment helper using clearly identified mock assets and test quotes; verification evidence and this disclosure.

No Solana wallet, Manifest order-book, MagicBlock transport, or Solana transaction logic was reused as a Base trading implementation. No simulated transaction is represented as an on-chain purchase.

## Git history

The original source history was not rewritten or backdated. Destination commits use their actual creation dates. Newer remote `UX-maxxing` commits were merged normally (`03ced25`), preserving their authorship and history, before pushing the Rips work. The temporary preservation stash remains available as a recovery copy.

Use this distinction in the Colosseum submission: **existing experience and code adapted from the Solana project; existing Base protocol/scaffolding reused; new Base integration and purchase protections authored for this port.** Do not describe the whole Rips interface as newly created Base work.
