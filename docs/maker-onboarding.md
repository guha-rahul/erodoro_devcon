# Market-maker onboarding

This runbook defines the first external RFQ pilot. It does not record a maker commitment. See [`market-validation.md`](market-validation.md) for dated evidence.

## Activation gate

Do not add a maker endpoint until one owner completes the commitment record. The same maker must supply the endpoint and fund the quote wallet.

Record these fields:

| Field | Required value |
| --- | --- |
| Organization and operator | Legal or operating name, technical contact, and operations contact |
| Stock | One B20 collateral address and symbol |
| Strike surface | Minimum and maximum strike, or a fixed strike |
| Expiry surface | Minimum and maximum time to expiry |
| Quote size | Minimum and maximum N amount |
| Quote lifetime | Exact TTL in seconds |
| Quote token | Token address, symbol, and decimals |
| Funding | Wallet address, minimum balance, and allowance threshold |
| Pricing | Named owner and pricing method |
| Inventory | Maximum N balance and stop condition |
| Hedge | Venue, instrument, and named owner |
| Monitoring | Named owner and response window |
| Settlement | Named caller and fallback owner |
| Eligibility | Permitted users and jurisdictions, after legal review |

## Find the first maker

Start with the [Base Services Hub](https://docs.base.org/get-started/base-services-hub). Its Tokka Labs entry offers priority scoping for Base-native liquidity partnerships. Use the linked application form after a pilot deployment exists.

Ask for one narrow Base Sepolia commitment. Do not ask for a full production market. The commitment must name one stock, one strike, one expiry range, one size range, and one operator. It must also include a funded testnet address and a quote endpoint.

The maker signs the EIP-712 digest. The maker does not give Erodoro a private key. A technically capable prop desk can run the pilot. Production activation still requires legal review, operating controls, and real liquidity evidence.

## Endpoint contract

The worker sends a `POST` request to each configured endpoint. The request uses decimal strings for all `uint256` values.

```json
{
  "claims": "0x...",
  "claimId": "11",
  "claimAmount": "100000000",
  "quoteToken": "0x...",
  "taker": "0x..."
}
```

The maker returns one EIP-712 quote for `ErodoroRFQ`. The response must match every requested field.

```json
{
  "makerName": "Example desk",
  "quote": {
    "maker": "0x...",
    "taker": "0x...",
    "claims": "0x...",
    "claimId": "11",
    "claimAmount": "100000000",
    "quoteToken": "0x...",
    "quoteAmount": "6150000",
    "expiry": "1780000120",
    "nonce": "7"
  },
  "metrics": {
    "availableSize": "100000000",
    "spreadBps": 600
  },
  "signature": "0x..."
}
```

The worker rejects P claims, changed request fields, invalid metrics, zero prices, and expired quotes. It calls `checkQuote` before it returns a quote.

The `checkQuote` call makes sure that the signature, balance, allowance, taker, expiry, and nonce are valid. The RFQ contract makes both transfers atomic.

## Configure the worker

1. Set `MM_ENDPOINTS` to `name|https://endpoint`. Use commas between makers.
2. Set `RFQ_CLAIMS_ADDRESS` to the deployed vault.
3. Set `MM_QUOTE_TOKEN` to the pilot quote token.
4. Set `RFQ_ADDRESS` to the deployed RFQ contract.
5. Set `PUBLIC_RPC_URL` or the `PRIVATE_RPC_URL` secret for the same network.
6. Set `MM_TIMEOUT_MS` between `100` and `10000`.
7. Keep `MM_PRIVATE_KEY` unset for external-liquidity evidence.
8. Deploy the worker.
9. Send one N quote request from the seller account.

The maker wallet must hold enough quote tokens. The maker wallet must also approve the deployed `ErodoroRFQ` contract.

## Measurements

Each `/rfq` request writes one `rfq_result` JSON log. The log contains no endpoint URL.

The log records these values:

- Total maker count and response count.
- Response rate and total request time.
- Requested claim amount and best quote amount.
- Maker latency and result status.
- Failure reason for each failed attempt.

The failure reasons include transport, response, request mismatch, funding-check, and on-chain rejection categories. The `detail` field contains the contract reason.

Export the Cloudflare logs after each pilot session. Add the result and the signed commitment to [`market-validation.md`](market-validation.md).

## Evidence boundary

The house maker proves only the software path. A house quote does not prove external demand, available size, a hedge path, or sustained response rate.
