"use client";

import { type FormEvent, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { createPortal } from "react-dom";
import { SWAP_API } from "@/lib/swap-api";

const ACCESS_POST = "https://x.com/ErodoroFi/status/2097801341934698499";

/** A store that never changes, so the snapshot alone decides the value. */
const subscribeNever = () => () => {};

type Submission =
  | { kind: "idle" }
  | { kind: "sending" }
  /** `stored` confirms that Cloudflare D1 accepted the request. */
  | { kind: "ok"; stored: boolean }
  | { kind: "error"; message: string };

export function WaitlistButton({ className }: { className?: string }) {
  const [open, setOpen] = useState(false);
  const [xUsername, setXUsername] = useState("");
  const [submission, setSubmission] = useState<Submission>({ kind: "idle" });
  const input = useRef<HTMLInputElement>(null);

  // `createPortal` needs a real document, which does not exist while the page
  // is prerendered. `useSyncExternalStore` returns the server snapshot during
  // SSR and the client one after hydration, which is React's own replacement
  // for the older setState-in-an-effect "mounted" flag.
  const mounted = useSyncExternalStore(subscribeNever, () => true, () => false);

  useEffect(() => {
    if (!open) return;
    input.current?.focus();
    const close = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    document.addEventListener("keydown", close);
    return () => document.removeEventListener("keydown", close);
  }, [open]);

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (submission.kind === "sending") return;
    setSubmission({ kind: "sending" });
    try {
      const response = await fetch(`${SWAP_API}/waitlist`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ xUsername }),
      });
      const result = (await response.json().catch(() => null)) as
        | { error?: string; stored?: boolean }
        | null;
      if (!response.ok) throw new Error(result?.error || "Could not request access.");
      setSubmission({ kind: "ok", stored: result?.stored === true });
    } catch (error) {
      setSubmission({
        kind: "error",
        message: error instanceof Error ? error.message : "Could not request access.",
      });
    }
  };

  return (
    <>
      <button
        type="button"
        onClick={() => {
          setSubmission({ kind: "idle" });
          setOpen(true);
        }}
        className={className ?? "border-line text-muted hover:border-text hover:text-text rounded-sm border px-3 py-2 text-[0.8125rem] whitespace-nowrap transition-colors sm:px-4"}
      >
        Request access <span aria-hidden>↗</span>
      </button>

      {mounted && open && createPortal(
        <div className="fixed inset-0 z-[100] flex items-center justify-center p-4" role="presentation">
          <button
            type="button"
            aria-label="Close access request"
            onClick={() => setOpen(false)}
            className="absolute inset-0 bg-black/65"
          />
          <section
            role="dialog"
            aria-modal="true"
            aria-labelledby="waitlist-title"
            className="border-line bg-panel shadow-pop relative w-full max-w-md rounded-md border p-5 sm:p-6"
          >
            <div className="flex items-start justify-between gap-4">
              <div>
                <p className="eyebrow">Early access</p>
                <h2 id="waitlist-title" className="mt-2 text-2xl font-medium tracking-[-0.035em]">
                  Request early access
                </h2>
              </div>
              <button
                type="button"
                aria-label="Close access request"
                onClick={() => setOpen(false)}
                className="border-line text-muted hover:text-text rounded-sm border px-2.5 py-1.5 text-sm"
              >
                Close
              </button>
            </div>

            {submission.kind === "ok" ? (
              <div
                className={`mt-5 rounded-sm border p-4 ${
                  submission.stored ? "border-p/30 bg-p/5" : "border-n/40 bg-n/5"
                }`}
                role="status"
              >
                {submission.stored ? (
                  <>
                    <p className="text-p font-medium">Request saved.</p>
                    <p className="text-muted mt-1 text-sm">
                      We’ll contact you on X when access opens.
                    </p>
                  </>
                ) : (
                  <>
                    <p className="text-n font-medium">Request not saved.</p>
                    <p className="text-muted mt-1 text-sm">
                      Complete the X steps below and check back for access updates.
                    </p>
                  </>
                )}
              </div>
            ) : (
              <form onSubmit={submit} className="mt-5">
                <label htmlFor="waitlist-x-username" className="text-muted text-sm">
                  X username
                </label>
                <input
                  ref={input}
                  id="waitlist-x-username"
                  name="xUsername"
                  type="text"
                  autoComplete="username"
                  required
                  minLength={1}
                  maxLength={16}
                  pattern="@?[A-Za-z0-9_]{1,15}"
                  value={xUsername}
                  onChange={(event) => {
                    setXUsername(event.target.value);
                    if (submission.kind === "error") setSubmission({ kind: "idle" });
                  }}
                  placeholder="@yourhandle"
                  className="border-line bg-bg focus:border-text mt-2 w-full rounded-sm border px-3 py-2.5 text-sm outline-none"
                />
                <button
                  type="submit"
                  disabled={submission.kind === "sending"}
                  title={submission.kind === "sending" ? "Sending request" : undefined}
                  className="bg-text hover:bg-accent text-bg mt-3 w-full rounded-sm px-4 py-2.5 text-sm font-medium transition-colors disabled:cursor-wait disabled:opacity-60"
                >
                  {submission.kind === "sending" ? "Sending…" : "Request access"}
                </button>
                {submission.kind === "error" && (
                  <p className="text-danger mt-3 text-sm" role="alert">
                    {submission.message}
                  </p>
                )}
                <p className="text-dim mt-3 text-xs">Access updates only. No email required.</p>
              </form>
            )}
            <div className="border-line bg-bg mt-4 border p-4">
              <p className="label-mono text-xs tracking-[0.1em] uppercase">Complete on X</p>
              <div className="text-muted mt-3 flex flex-wrap gap-x-4 gap-y-2 text-sm">
                <span>Follow</span>
                <span>Retweet</span>
                <span>Comment</span>
              </div>
              <a
                href={ACCESS_POST}
                target="_blank"
                rel="noreferrer"
                className="text-accent-ink mt-4 inline-block text-sm underline underline-offset-4"
              >
                Open the post on X <span aria-hidden>↗</span>
              </a>
            </div>
          </section>
        </div>,
        document.body,
      )}
    </>
  );
}
