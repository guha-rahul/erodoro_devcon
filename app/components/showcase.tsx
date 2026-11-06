import fs from "node:fs";
import path from "node:path";

/**
 * The product, shown rather than described.
 *
 * Two panels, each holding a real capture that runs off the bottom edge -- the
 * crop is what makes it read as a window into something larger rather than as
 * a screenshot pasted onto a page.
 *
 * The captures must be of *this* interface at the current commit, not a mockup
 * and not a capture of some earlier build. If they have not been taken yet the
 * panel is skipped entirely, and with neither present the section renders
 * nothing at all: a landing page with one honest panel is better than one with
 * a placeholder in the second, and both are better than a screenshot of a
 * screen this app does not have.
 */
const SHOTS = [
  {
    file: "markets.png",
    label: "Markets",
    caption: "Every listed strike and expiry, with the state each one is actually in.",
  },
  {
    file: "portfolio.png",
    label: "Portfolio",
    caption: "What you locked, what you sold, and what is waiting on settlement — kept apart.",
  },
];

export function Showcase() {
  const dir = path.join(process.cwd(), "public", "showcase");
  const present = SHOTS.filter((shot) => fs.existsSync(path.join(dir, shot.file)));
  if (!present.length) return null;

  return (
    <section className="border-line scroll-mt-20 border-t">
      <div className="mx-auto max-w-6xl px-6 py-16 sm:py-24">
        <p className="kicker">The interface</p>
        <h2 className="display-2 mt-6 max-w-[17ch]">Every term stated before you sign.</h2>

        <div className="mt-12 grid gap-5 lg:grid-cols-2">
          {present.map((shot) => (
            <figure
              key={shot.file}
              data-panel
              className="border-line bg-panel-2 overflow-hidden border p-7 pb-0"
            >
              <figcaption className="border-line mb-7 border-b pb-5">
                <span className="kicker text-text">{shot.label}</span>
                <span className="text-muted prose-editorial mt-2.5 block max-w-[42ch] text-[0.875rem]">
                  {shot.caption}
                </span>
              </figcaption>
              {/* Bleeds off the bottom-right. `-mb-px` keeps the panel's own
                  border from drawing a line under the image. */}
              {/* `next/image` buys nothing here: `next.config.ts` sets
                  `images.unoptimized` for the static export, so it would add a
                  wrapper element this layout does not want in exchange for no
                  optimisation at all. */}
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={`/showcase/${shot.file}`}
                alt=""
                width={1280}
                height={900}
                loading="lazy"
                decoding="async"
                className="border-line w-full border-t border-r border-l object-cover object-left-top"
                style={{ aspectRatio: "1280 / 760" }}
              />
            </figure>
          ))}
        </div>
      </div>
    </section>
  );
}
