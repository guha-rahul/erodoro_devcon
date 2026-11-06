import { SWAP_API } from "./swap-api";
import type { Address, Hex } from "./types";

/**
 * Client for the Worker's paymaster allowlist.
 *
 * The Worker decides what may be sponsored and returns the paymaster service
 * URL. A refusal is not an error the user has to resolve: the transaction is
 * still sent, just paid for normally. Nothing here ever asks for sponsorship of
 * a call the Worker has not already accepted.
 */

export type SponsorCall = { to: Address; data: Hex; value?: bigint };
export type PaymasterService = { url: string };

export async function requestSponsorship(
  options: {
    chainId: number;
    account: Address;
    calls: SponsorCall[];
    fetchImpl?: typeof fetch;
  },
): Promise<PaymasterService | null> {
  const request = options.fetchImpl ?? fetch;
  try {
    const response = await request(`${SWAP_API}/api/paymaster/prepare`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        chainId: options.chainId,
        account: options.account,
        calls: options.calls.map((call) => ({
          to: call.to,
          data: call.data,
          value: call.value ? call.value.toString() : "0",
        })),
      }),
    });
    if (!response.ok) return null;
    const body = await response.json();
    const url = body?.paymasterService?.url;
    return body?.sponsored === true && typeof url === "string" ? { url } : null;
  } catch {
    return null;
  }
}
