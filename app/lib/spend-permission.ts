import type { ProviderInterface } from "@base-org/account";
import type { Address } from "./types";

/**
 * Base Account spend permissions (EIP-7715 / Base `SpendPermissionManager`).
 *
 * A spend permission replaces a per-bid ERC-20 approval: the user signs one
 * bounded, recurring USDC allowance and later bids do not re-approve. The
 * request side is complete here; redeeming a permission during settlement needs
 * the intent contract to consume the permission manager, which is tracked
 * separately. Only Base Account is ever asked — injected wallets keep the
 * ordinary allowance path.
 */

export type SpendPermissionModule = typeof import("@base-org/account/spend-permission");
export type SpendPermission = Awaited<ReturnType<SpendPermissionModule["requestSpendPermission"]>>;

export function isBaseAccountConnector(connector: { id?: string } | null | undefined): boolean {
  return connector?.id === "baseAccount";
}

export type RequestSpendPermissionArgs = {
  provider: ProviderInterface;
  account: Address;
  spender: Address;
  token: Address;
  chainId: number;
  allowance: bigint;
  periodInDays: number;
};

/** Ask Base Account to sign a bounded, recurring USDC allowance. */
export async function requestUsdcSpendPermission(args: RequestSpendPermissionArgs): Promise<SpendPermission> {
  const { requestSpendPermission } = await import("@base-org/account/spend-permission");
  return requestSpendPermission({
    provider: args.provider,
    account: args.account,
    spender: args.spender,
    token: args.token,
    chainId: args.chainId,
    allowance: args.allowance,
    periodInDays: args.periodInDays,
  });
}

/** The spend permissions this account already granted to the spender. */
export async function listUsdcSpendPermissions(args: {
  provider?: ProviderInterface;
  account: Address;
  spender: Address;
  chainId: number;
}): Promise<SpendPermission[]> {
  const { fetchPermissions } = await import("@base-org/account/spend-permission");
  return fetchPermissions({
    provider: args.provider,
    account: args.account,
    spender: args.spender,
    chainId: args.chainId,
  });
}
