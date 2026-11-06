import { DEPLOYMENT, IS_TESTNET } from "@/lib/deployment";

/**
 * The strip that bounds the hero.
 *
 * The reference this borrows from runs a token price across it. There is no
 * token and no price, so this runs the deployment instead: which chain, which
 * contracts, what the premium is quoted in, and what is still unaudited. Every
 * item comes from `lib/deployment.ts`, which is a module constant mirroring
 * `contracts/deployments/*.json` — so the landing route keeps its most useful
 * property: it renders with no wallet, no RPC and no request.
 *
 * Deliberately not a price, a TVL, or a count of anyone. A number nobody can
 * check is worse than no number: the first reader to look finds nothing behind
 * it. `UNAUDITED` is on the strip for the same reason it is in `status.md` —
 * it is true, and it is the thing a visitor most needs to know.
 */
/** `0x` plus four is the shortest prefix that identifies anything — slicing
 *  four characters off the front of a hex address leaves `0x1c`, which is two
 *  meaningful digits and matches half the addresses on the chain. */
const short = (address: string) => `${address.slice(0, 6)}…${address.slice(-4)}`;

function items(): string[] {
  const out = [DEPLOYMENT.chainName.toUpperCase()];

  const { vault, factory, rfq, pythAdapter } = DEPLOYMENT.contracts;
  // A chain with nothing deployed says so rather than running an empty strip.
  if (!vault) {
    out.push("NO CONTRACTS DEPLOYED");
  } else {
    out.push(`VAULT ${short(vault)}`);
    if (factory) out.push(`REGISTRY ${short(factory)}`);
    if (rfq) out.push(`RFQ ${short(rfq)}`);
    if (pythAdapter) out.push(`ORACLE ${short(pythAdapter)}`);
  }

  if (DEPLOYMENT.quote) out.push(`QUOTED IN ${DEPLOYMENT.quote.symbol.toUpperCase()}`);
  if (IS_TESTNET) out.push("TEST ASSETS ONLY");
  out.push("UNAUDITED");
  return out;
}

function Track({ entries }: { entries: string[] }) {
  return (
    <div className="flex shrink-0 items-center">
      {entries.map((entry, index) => (
        <span key={`${entry}-${index}`} className="flex items-center">
          <span className="label-mono px-5 text-[0.625rem] tracking-[0.18em] whitespace-nowrap uppercase">
            {entry}
          </span>
          <span aria-hidden className="opacity-30">
            ·
          </span>
        </span>
      ))}
    </div>
  );
}

export function Ticker() {
  const entries = items();
  return (
    <div className="ink-band overflow-hidden py-2" data-ticker>
      <div className="marquee">
        <Track entries={entries} />
        {/* The second copy exists only so the loop has no seam. Reading the
            same addresses twice is not an experience worth giving a screen
            reader. */}
        <div aria-hidden>
          <Track entries={entries} />
        </div>
      </div>
    </div>
  );
}
