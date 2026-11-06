import { AppChrome } from "@/components/app-chrome";
import { SeriesDetail } from "@/components/series-detail";
import { publicClient } from "@/lib/chain";
import { DEPLOYMENT } from "@/lib/deployment";
import { FactoryAbi } from "@/lib/abis";
import type { Address } from "@/lib/types";

/**
 * A static export needs every route enumerated at build time, so the canonical
 * list is read from the registry during the build.
 *
 * The consequence is real and worth stating: **a series listed after a build has
 * no page until the next build.** The markets table still shows it, because that
 * reads in the browser. Fixing this properly means either rebuilding on a
 * listing event or moving off static export — see `todo.md`.
 */
export async function generateStaticParams() {
  const factory = DEPLOYMENT.contracts.factory as Address | null;
  const recorded = DEPLOYMENT.staticSeries.map((id) => BigInt(id));
  if (!factory) return recorded.length > 0 ? toParams(recorded) : [{ id: "0" }];
  if (process.env.SKIP_BUILD_RPC === "1") {
    return recorded.length > 0 ? toParams(recorded) : [{ id: "0" }];
  }
  try {
    const live = (await publicClient.readContract({
      address: factory,
      abi: FactoryAbi,
      functionName: "canonicalSeries",
    })) as readonly bigint[];
    return toParams([...new Set([...recorded, ...live])]);
  } catch (e) {
    // The deployment artifact is the deterministic build input. A live read
    // adds newly listed routes when available but must not make CI depend on an
    // RPC. Listing operations must update staticSeries before release.
    console.warn("Could not refresh canonical series at build time; using recorded ids.", e);
    return recorded.length > 0 ? toParams(recorded) : [{ id: "0" }];
  }
}

function toParams(ids: readonly bigint[]) {
  return ids.map((id) => ({ id: id.toString(16) }));
}

export default async function SeriesPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  let parsed: bigint | null = null;
  try {
    parsed = BigInt(`0x${id}`);
  } catch {
    parsed = null;
  }

  return (
    <>
      <AppChrome active="/app" />
      <main className="mx-auto w-full max-w-7xl flex-1 px-4 py-8 sm:px-6">
        <div className="mt-6">
          <SeriesDetail id={parsed} />
        </div>
      </main>
    </>
  );
}
