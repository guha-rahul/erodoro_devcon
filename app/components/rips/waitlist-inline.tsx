"use client";

import { type FormEvent, useState } from "react";
import { SWAP_API } from "@/lib/swap-api";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

type State = { kind: "idle" } | { kind: "sending" } | { kind: "ok" } | { kind: "error"; message: string };

/** The landing's one call to action: an X username into the Worker's waitlist. */
export function WaitlistInline() {
  const [handle, setHandle] = useState("");
  const [state, setState] = useState<State>({ kind: "idle" });

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (state.kind === "sending") return;
    setState({ kind: "sending" });
    try {
      const response = await fetch(`${SWAP_API}/waitlist`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ xUsername: handle.trim() }),
      });
      const result = (await response.json().catch(() => null)) as { error?: string; stored?: boolean } | null;
      if (!response.ok || result?.stored !== true) throw new Error(result?.error || "Could not join the waitlist.");
      setState({ kind: "ok" });
    } catch (error) {
      setState({ kind: "error", message: error instanceof Error ? error.message : "Could not join the waitlist." });
    }
  };

  if (state.kind === "ok") {
    return (
      <p role="status" className="border-p/30 bg-p/5 prose-editorial border px-5 py-4 text-[0.9375rem]">
        You&rsquo;re on the list. We&rsquo;ll reach out on X when Rips opens.
      </p>
    );
  }

  return (
    <form onSubmit={submit} className="w-full max-w-[28rem]" data-waitlist>
      <div className="border-line bg-panel focus-within:border-text flex items-stretch border transition-colors">
        <Label htmlFor="waitlist-x" className="sr-only">Your X username</Label>
        <Input
          id="waitlist-x"
          required
          maxLength={16}
          pattern="@?[A-Za-z0-9_]{1,15}"
          autoComplete="off"
          spellCheck={false}
          placeholder="@yourhandle"
          value={handle}
          onChange={(e) => { setHandle(e.target.value); if (state.kind === "error") setState({ kind: "idle" }); }}
          className="text-text placeholder:text-dim h-auto min-w-0 flex-1 rounded-none border-0 bg-transparent px-4 py-3.5 font-mono text-[0.9375rem] shadow-none focus-visible:ring-0 md:text-[0.9375rem]"
        />
        <Button
          type="submit"
          disabled={state.kind === "sending"}
          className="bg-accent hover:bg-text text-ink label-mono h-auto shrink-0 rounded-none border-0 px-5 tracking-[0.1em] uppercase disabled:opacity-60"
        >
          {state.kind === "sending" ? "Joining…" : "Join waitlist"}
        </Button>
      </div>
      {state.kind === "error" && <p className="text-danger mt-2.5 text-[0.8125rem]" role="alert">{state.message}</p>}
    </form>
  );
}
