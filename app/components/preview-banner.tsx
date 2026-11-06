import { DEPLOYMENT, IS_LIVE, IS_TESTNET } from "@/lib/deployment";

/**
 * Says what the numbers on this page actually are.
 *
 * Three states, because they mean different things: nothing deployed, a testnet
 * where the collateral is not a real security, and mainnet where it is.
 */
export function PreviewBanner() {
  if (!IS_LIVE) {
    return (
      <Bar>
        <b className="font-medium">Not deployed.</b> There are no contracts on {DEPLOYMENT.chainName},
        so nothing on this page can be traded.
      </Bar>
    );
  }
  if (IS_TESTNET) {
    return (
      <Bar>
        <b className="font-medium">{DEPLOYMENT.chainName}.</b> Test network. The collateral is a
        token minted for testing, not a real security, and nothing here has any value.
      </Bar>
    );
  }
  return null;
}

function Bar({ children }: { children: React.ReactNode }) {
  return (
    <div className="border-n/30 bg-n/10 text-n border-b" role="status">
      <p className="mx-auto max-w-7xl px-4 py-2 text-[0.8125rem] sm:px-6">{children}</p>
    </div>
  );
}
