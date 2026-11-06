# Market validation

Current as of **2026-08-26**.

This file records dated market research and product hypotheses. It is not a
source of truth for deployments, security or contract behavior. Use
[`../status.md`](../status.md) for current protocol evidence.

## Current conclusion

The search found no product with the exact Erodoro payoff on B20 stocks. This
does not prove that no competitor exists. The result covers only the sources
listed below and can become stale.

Base lists Wasabi as a provider of perpetuals and options for tokenized stocks.
The listing does not state that Wasabi offers Erodoro's capped-upside split.
Base describes listed projects as independent third parties, not partners.

CoinDesk reported that Wasabi lost approximately $4.55 million in April 2026.
The reported cause was a compromised sole administrator key. The attacker used
the authority to install malicious contract implementations.

This incident is relevant to administrator and upgrade controls. It does not
prove that Erodoro is secure. Erodoro needs an assessment of its own authority
model and an external security review.

## Product hypotheses

The following statements are hypotheses, not facts:

1. One external maker can quote funded N positions for one narrow market.
2. A stock holder will accept capped upside for the quoted USDC premium.
3. An RFQ pilot can establish demand before a public AMM has sufficient depth.
4. A maker can describe a practical hedge path for the N inventory.
5. A working Base Sepolia demo can improve Base ecosystem outreach.

The pilot must not use P holders or vault depositors as proof of N demand.
These users create N supply when they sell their upside. They do not create an
independent buyer.

## First liquidity experiment

Use one external maker for one stock, strike range and expiry range. The maker
must fund each quote before the RFQ contract accepts it.

Record these values for each pilot session:

- The reason that the maker buys N.
- The hedge venue and hedge instrument.
- The largest quote size.
- The quote lifetime and spread.
- The inventory limit.
- The funding method.
- The owner of pricing and monitoring.
- The owner of settlement operations.
- The response rate and failed-quote reasons.

A test-house quote proves contract plumbing only. It does not prove market
demand.

## Buyer interviews

Ask each candidate buyer these questions:

1. Which event or exposure makes N useful to you?
2. Which stock, strike and expiry can you quote now?
3. Where can you hedge the position?
4. What size and spread can you support?
5. How long can a signed quote remain valid?
6. Which inventory or loss limit stops new quotes?
7. Who funds the quote wallet and monitors its balance?
8. Who submits settlement and handles a failed settlement?
9. Which oracle and market hours can you accept?
10. Which jurisdictions and counterparties can you serve?

## Interview and commitment log

| Date | Counterparty | Evidence | Result |
| --- | --- | --- | --- |
| 2026-08-25 | None | No external interview or signed commitment was supplied to this repository. | External N demand remains unproven. |
| 2026-08-26 | Public web research | Base Services Hub, Base stock page, and public market-maker pages. | Candidate makers exist. No commitment, endpoint, funded wallet, or interview exists. |

Use [`maker-onboarding.md`](maker-onboarding.md) for the commitment fields and endpoint contract. Add only dated evidence from a named counterparty.

## Maker target list

The first target is Tokka Labs through the Base Services Hub. Base lists Tokka
Labs under token management and says Base-native projects get priority access
to liquidity partnership scoping.

Tokka Labs is the best first call because its public site describes onchain
proprietary trading, RFQ, intent protocols, AMMs, and RWA x DeFi work.

The second target is Coinwatch. Base lists Coinwatch under market making.
Coinwatch can help compare market-making terms and monitor maker performance.
Coinwatch is not itself proof that a maker will quote Erodoro N.

The third target is GSR. GSR describes DeFi liquidity, market access,
market liquidity, treasury management, systematic OTC, and market making.
GSR is a good target for a larger institutional pilot after the narrow testnet
flow has one clear deck and one completed external conversation.

The fourth target is Keyrock. Keyrock describes 24/7 algorithmic market making,
cross-venue price aggregation, spread control, and reporting. This matches the
kind of quote-limit and monitoring data that Task 4 requires.

The fifth target is Flow Traders. Flow Traders describes digital-asset OTC,
programmatic API connectivity, DeFi integrations, and tokenized-asset work.
This is a better institutional target than a first cold pilot.

## First pilot ask

Ask for one Base Sepolia RFQ pilot only. Do not ask for production liquidity.

Use this starting shape:

- Stock: AAPLc on Base mainnet, mirrored as tAAPLc on Base Sepolia.
- Strategy: covered-call N quote only.
- Strike: one fixed out-of-the-money strike.
- Expiry: one short dated expiry, between 7 and 30 days.
- Size: one N amount equal to one tokenized share.
- Quote token: tUSDC on Base Sepolia.
- Quote lifetime: 30 to 120 seconds.
- Evidence: one funded quote, one filled RFQ, and one logged failed-quote set.

Ask the maker to name these fields before an endpoint is configured:

- The maker wallet.
- The minimum quote-token balance.
- The RFQ allowance threshold.
- The maximum N inventory.
- The spread limit.
- The quote time-to-live.
- The owner of pricing.
- The hedge venue and instrument.
- The owner of quote-wallet monitoring.
- The owner of settlement operations.

Do not add `MM_ENDPOINTS` until these fields exist. A live endpoint without a
named owner and a funded wallet is not Task 4 evidence.

## Oracle boundary

Base documents Chainlink feeds for these stocks as total-return values. Each
value includes the B20 multiplier. The feeds stop updates during corporate
actions and keep the last value available.

The production design must use one consistent settlement model:

- A raw equity price with a multiplier-adjusted strike.
- A total-return price without a second multiplier adjustment.

A raw price does not create the split error by itself. The error occurs when
the price and strike use inconsistent multiplier semantics.

The settlement design must read `updatedAt` and apply a staleness limit. It must
also define how it identifies a corporate-action freeze. If this state is not
reliably observable, the adapter remains blocked for production use.

## Outreach

The Base Ecosystem Fund publishes a request for builders in onchain finance.
Its topics include derivatives and tokenized portfolios as collateral. This is
evidence of general interest, not evidence that Base endorses Erodoro.

Use the Base Sepolia demo for initial outreach. Describe Erodoro as a
fully-collateralized covered-call payoff. Do not describe it as a total-return
swap.

Ask Base or the issuer about these topics:

- The permitted product and user scope for third-party B20 derivatives.
- Eligibility and jurisdiction requirements.
- The supported method to identify an oracle pause.
- The expected integration process for corporate-action announcements.
- The correct channel for technical and ecosystem review.

Legal counsel must make the legal conclusions. Base ecosystem feedback does
not replace that review.

## Claims that this file rejects

- "No competitor exists." The search cannot prove an absence.
- "Nobody built this because the assets are new." The cause is unknown.
- "Vault curators create structural N demand." They can distribute N supply,
  but they do not create an independent buyer.
- "Erodoro is a total-return swap." Its current payoff is a covered-call
  decomposition without a financing leg.
- "A raw Pyth price recreates the split bug." The result depends on the complete
  price and strike model.
- "The Wasabi incident proves Erodoro is safer." A separate review must assess
  Erodoro's contracts and operations.

## Evidence required before the demand claim changes

The status can change from `N liquidity is unproven` only after all these items
exist:

1. An external maker returns a funded quote.
2. An external account accepts the quote.
3. The N and USDC transfer completes atomically.
4. The maker explains its price, limit and hedge policy.
5. The pilot records quote failures and operational responsibility.

One successful quote proves one narrow market. It does not prove broad demand.

## Sources

- [Tokenized Stocks on Base](https://docs.base.org/base-chain/asset-issuance/tokenized-stocks-on-base)
- [Base tokenized-stock ecosystem](https://www.base.org/stocks)
- [Base tokenized-stocks launch note](https://blog.base.org/tokenized-stocks)
- [Base Services Hub](https://docs.base.org/get-started/base-services-hub)
- [Tokka Labs](https://tokkalabs.com/)
- [GSR DeFi liquidity](https://www.gsr.io/defi-liquidity/)
- [GSR markets](https://www.gsr.io/services/markets)
- [Keyrock market making](https://keyrock.com/service/market-making/)
- [Flow Traders digital assets](https://www.flowtraders.com/digital-assets/)
- [Request for Builders: Funding the Future of Global Finance](https://blog.base.org/request-for-builders-1)
- [CoinDesk report on the Wasabi administrator-key compromise](https://www.coindesk.com/tech/2026/04/30/wasabi-protocol-drained-for-usd4-5-million-in-apparent-admin-key-compromise)
