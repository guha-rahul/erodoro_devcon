import Link from "next/link";
import { Nav } from "@/components/nav";

export default function NotFound() {
  return (
    <>
      <Nav />
      <main className="mx-auto flex w-full max-w-3xl flex-1 flex-col justify-center px-6 py-24">
        <p className="eyebrow">404</p>
        <h1 className="font-display mt-4 text-4xl tracking-[-0.045em]">This page does not exist.</h1>
        <p className="text-muted mt-4 max-w-[52ch]">
          The link may be out of date, or the market may never have been listed.
        </p>
        <div className="mt-8 flex flex-wrap gap-4 text-sm">
          <Link href="/" className="underline underline-offset-4">
            Back to the start
          </Link>
          <Link href="/app" className="text-muted hover:text-text underline underline-offset-4">
            Browse markets
          </Link>
        </div>
      </main>
    </>
  );
}
