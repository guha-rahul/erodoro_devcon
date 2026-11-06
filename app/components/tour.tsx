"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { usePathname, useRouter } from "next/navigation";
import { IS_LIVE } from "@/lib/deployment";
import { TOUR_STEPS, type TourStep } from "@/lib/tour-steps";

type TourApi = { start: () => void; running: boolean };
const TourContext = createContext<TourApi>({ start: () => {}, running: false });

export function useTour() {
  return useContext(TourContext);
}

const SEEN_KEY = "erodoro.tour.v2";
const AUTO_START_ROUTE = "/app";

function matchesRoute(step: TourStep, pathname: string) {
  return (
    step.route === pathname ||
    step.allowedRoutePrefixes?.some((prefix) => pathname.startsWith(prefix))
  );
}

function firstStepForRoute(steps: TourStep[], pathname: string) {
  const exact = steps.findIndex((step) => step.route === pathname);
  if (exact >= 0) return exact;
  // More specific, later steps win on dynamic routes. Both market selection
  // and market actions tolerate `/app/:id`, but opening Guide there should
  // explain the actions, not replay selection.
  for (let index = steps.length - 1; index >= 0; index -= 1) {
    if (matchesRoute(steps[index], pathname)) return index;
  }
  return -1;
}

/**
 * A contextual walkthrough that survives the route changes it performs.
 *
 * The overlay is deliberately non-blocking. Its shadow highlights the current
 * control without intercepting clicks, so a visitor can perform the action the
 * card describes without closing the guide first.
 */
export function TourProvider({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const router = useRouter();
  const steps = TOUR_STEPS;
  const [running, setRunning] = useState(false);
  const [index, setIndex] = useState(0);

  const open = useCallback(() => {
    const selectedMarket = new URLSearchParams(window.location.search).has("market");
    const here = selectedMarket
      ? steps.findIndex((candidate) => candidate.id === "act")
      : firstStepForRoute(steps, pathname);
    setIndex(here < 0 ? 0 : here);
    setRunning(true);
    try {
      window.localStorage.setItem(SEEN_KEY, "1");
    } catch {
      // Private browsing can make storage unavailable; the guide still works.
    }
  }, [pathname, steps]);

  const stop = useCallback(() => {
    setRunning(false);
    try {
      window.localStorage.setItem(SEEN_KEY, "1");
    } catch {
      // Nothing else depends on persistence.
    }
  }, []);

  const next = useCallback(() => {
    setIndex((current) => {
      if (current >= steps.length - 1) {
        setRunning(false);
        return current;
      }
      return current + 1;
    });
  }, [steps.length]);

  const previous = useCallback(() => setIndex((current) => Math.max(0, current - 1)), []);
  const step = steps[index];

  // Start once, automatically, when a visitor first opens Markets. Persisting
  // the start prevents route changes inside the guide from reopening it and
  // keeps subsequent visits free of an onboarding interruption.
  useEffect(() => {
    if (!IS_LIVE || pathname !== AUTO_START_ROUTE || running) return;
    try {
      if (window.localStorage.getItem(SEEN_KEY)) return;
    } catch {
      // Continue with an in-memory start when storage is unavailable.
    }
    const timer = window.setTimeout(open, 500);
    return () => window.clearTimeout(timer);
  }, [open, pathname, running]);

  // Advancing decides the route. Dynamic market-detail routes are accepted by
  // prefix so clicking a market does not send the visitor back to the list.
  useEffect(() => {
    if (!running || !step || matchesRoute(step, pathname)) return;
    router.push(step.route);
  }, [pathname, router, running, step]);

  return (
    <TourContext.Provider value={{ start: open, running }}>
      {children}
      {IS_LIVE && running && step && (
        <TourOverlay
          step={step}
          index={index}
          total={steps.length}
          onNext={next}
          onPrevious={previous}
          onStop={stop}
        />
      )}
    </TourContext.Provider>
  );
}

const GAP = 14;
const MARGIN = 12;

function TourOverlay({
  step,
  index,
  total,
  onNext,
  onPrevious,
  onStop,
}: {
  step: TourStep;
  index: number;
  total: number;
  onNext: () => void;
  onPrevious: () => void;
  onStop: () => void;
}) {
  const [rect, setRect] = useState<DOMRect | null>(null);
  const [card, setCard] = useState({ width: 368, height: 220 });
  const cardRef = useRef<HTMLDivElement>(null);
  const scrolledFor = useRef<string | null>(null);
  const targets = useMemo(
    () =>
      [step.target, ...(step.fallbackTargets ?? [])].filter(
        (name): name is string => Boolean(name),
      ),
    [step.target, step.fallbackTargets],
  );
  const completionTargets = useMemo(
    () => step.completeWhenVisible ?? [],
    [step.completeWhenVisible],
  );

  // Route changes, async reads and smooth scrolling can all move a target. A
  // frame loop follows the real control without guessing which one finished.
  useEffect(() => {
    let frame = 0;
    const track = () => {
      if (completionTargets.length && findVisibleTarget(completionTargets)) {
        onNext();
        return;
      }

      const element = findVisibleTarget(targets);
      if (element) {
        if (scrolledFor.current !== step.id) {
          scrolledFor.current = step.id;
          element.scrollIntoView({ block: "center", behavior: "smooth" });
        }
        const nextRect = element.getBoundingClientRect();
        setRect((previousRect) =>
          previousRect &&
          previousRect.top === nextRect.top &&
          previousRect.left === nextRect.left &&
          previousRect.width === nextRect.width &&
          previousRect.height === nextRect.height
            ? previousRect
            : nextRect,
        );
      } else {
        setRect((previousRect) => (previousRect === null ? previousRect : null));
      }
      frame = window.requestAnimationFrame(track);
    };
    frame = window.requestAnimationFrame(track);
    return () => window.cancelAnimationFrame(frame);
  }, [completionTargets, onNext, step.id, targets]);

  useEffect(() => {
    if (!step.advanceOn?.length) return;
    const advanceAfterClick = (event: MouseEvent) => {
      const clicked = event.target instanceof Element ? event.target : null;
      if (!clicked) return;
      if (clicked.closest("[data-tour-no-advance]")) return;
      const completes = step.advanceOn!.some((name) =>
        Boolean(clicked.closest(`[data-tour="${name}"]`)),
      );
      if (completes) window.setTimeout(onNext, 80);
    };
    window.addEventListener("click", advanceAfterClick);
    return () => window.removeEventListener("click", advanceAfterClick);
  }, [onNext, step]);

  useLayoutEffect(() => {
    const element = cardRef.current;
    if (!element) return;
    const measured = element.getBoundingClientRect();
    setCard((previousCard) =>
      previousCard.width === measured.width && previousCard.height === measured.height
        ? previousCard
        : { width: measured.width, height: measured.height },
    );
  }, [rect, step]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onStop();
      if (event.key === "ArrowRight") onNext();
      if (event.key === "ArrowLeft") onPrevious();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onNext, onPrevious, onStop]);

  const position = placeCard(rect, card);
  const last = index === total - 1;

  return (
    <div className="pointer-events-none fixed inset-0 z-[100]">
      {rect ? (
        <>
          <div
            data-tour-highlight
            aria-hidden="true"
            className="fixed rounded-md transition-[top,left,width,height] duration-200"
            style={{
              top: rect.top - 8,
              left: rect.left - 8,
              width: rect.width + 16,
              height: rect.height + 16,
              boxShadow:
                "0 0 0 9999px rgb(10 17 24 / 0.72), 0 0 0 4px rgb(214 93 50 / 0.24), 0 0 28px rgb(214 93 50 / 0.62)",
              outline: "3px solid rgb(214 93 50)",
            }}
          />
          {step.action && (
            <div
              data-tour-cue
              aria-hidden="true"
              className="bg-accent text-bg fixed rounded-md px-2.5 py-1 font-mono text-[0.75rem] font-semibold tracking-[0.08em] uppercase shadow-lg"
              style={placeCue(rect)}
            >
              Click here ↓
            </div>
          )}
        </>
      ) : (
        <div
          aria-hidden="true"
          className="fixed inset-0"
          style={{ background: "rgb(10 17 24 / 0.72)" }}
        />
      )}

      <div
        ref={cardRef}
        role="dialog"
        aria-label={step.title}
        className="border-line bg-panel pointer-events-auto fixed w-[min(23rem,calc(100vw-1.5rem))] rounded-md border p-5 shadow-[0_24px_80px_rgb(10_17_24/0.22)]"
        style={{ top: position.top, left: position.left }}
      >
        <div className="text-dim flex items-center justify-between font-mono text-[0.75rem] tracking-[0.12em] uppercase">
          <span>
            Step {index + 1} of {total}
          </span>
          <button
            type="button"
            onClick={onStop}
            className="hover:text-text pointer-events-auto underline-offset-2 transition-colors hover:underline"
          >
            Skip
          </button>
        </div>

        <h2 className="mt-3 text-lg font-medium tracking-[-0.02em]">{step.title}</h2>
        <p className="text-muted mt-1.5 text-[0.9rem] leading-6">{step.body}</p>

        {step.action && rect && (
          <p className="border-accent/40 bg-accent/10 text-text mt-3 rounded-sm border px-3 py-2 text-[0.85rem] font-medium">
            → {step.action}
          </p>
        )}

        {targets.length > 0 && !rect && step.waitFor && (
          <p className="border-n/30 bg-n/5 text-n mt-3 rounded-sm border px-3 py-2 text-[0.85rem]">
            {step.waitFor}
          </p>
        )}

        <div className="mt-5 flex items-center justify-between gap-3">
          <div className="flex min-w-0 flex-1 gap-1 overflow-hidden" aria-hidden="true">
            {Array.from({ length: total }, (_, dot) => (
              <span
                key={dot}
                className={`h-1 shrink-0 rounded-full transition-all ${
                  dot === index ? "bg-accent w-4" : "bg-line w-1"
                }`}
              />
            ))}
          </div>
          <div className="flex shrink-0 gap-2">
            <button
              type="button"
              onClick={onPrevious}
              disabled={index === 0}
              className="border-line hover:border-text rounded-sm border px-3 py-1.5 text-sm transition-colors disabled:cursor-not-allowed disabled:opacity-40"
            >
              Previous
            </button>
            <button
              type="button"
              onClick={last ? onStop : onNext}
              className="bg-text hover:bg-accent text-bg rounded-sm px-3 py-1.5 text-sm font-medium transition-colors"
            >
              {last ? "Done" : "Next"}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

function findVisibleTarget(names: string[]): HTMLElement | null {
  for (const name of names) {
    const candidates = document.querySelectorAll<HTMLElement>(`[data-tour="${name}"]`);
    for (const candidate of candidates) {
      if (isReallyVisible(candidate)) return candidate;
    }
  }
  return null;
}

function isReallyVisible(element: HTMLElement) {
  const rect = element.getBoundingClientRect();
  if (rect.width <= 0 || rect.height <= 0) return false;

  const check = (
    element as HTMLElement & {
      checkVisibility?: (options?: {
        contentVisibilityAuto?: boolean;
        opacityProperty?: boolean;
        visibilityProperty?: boolean;
      }) => boolean;
    }
  ).checkVisibility;
  if (
    typeof check === "function" &&
    !check.call(element, {
      contentVisibilityAuto: true,
      opacityProperty: true,
      visibilityProperty: true,
    })
  ) {
    return false;
  }

  for (let node: HTMLElement | null = element; node; node = node.parentElement) {
    const style = window.getComputedStyle(node);
    if (style.display === "none" || style.visibility === "hidden" || Number(style.opacity) === 0) {
      return false;
    }
  }
  return true;
}

function placeCue(rect: DOMRect): React.CSSProperties {
  const height = 28;
  const top =
    rect.top > height + MARGIN
      ? rect.top - height - 10
      : Math.min(window.innerHeight - height - MARGIN, rect.bottom + 10);
  const left = Math.min(
    Math.max(MARGIN, rect.left),
    Math.max(MARGIN, window.innerWidth - 112 - MARGIN),
  );
  return { top, left };
}

function placeCard(rect: DOMRect | null, card: { width: number; height: number }) {
  if (typeof window === "undefined") return { top: MARGIN, left: MARGIN };
  const viewportWidth = window.innerWidth;
  const viewportHeight = window.innerHeight;

  if (!rect) {
    return {
      top: Math.max(MARGIN, (viewportHeight - card.height) / 2),
      left: Math.max(MARGIN, (viewportWidth - card.width) / 2),
    };
  }

  const below = rect.bottom + GAP;
  const above = rect.top - GAP - card.height;
  const preferred =
    below + card.height < viewportHeight - MARGIN
      ? below
      : above > MARGIN
        ? above
        : viewportHeight - card.height - MARGIN;
  const top = Math.min(
    Math.max(MARGIN, preferred),
    Math.max(MARGIN, viewportHeight - card.height - MARGIN),
  );
  const left = Math.min(
    Math.max(MARGIN, rect.left),
    viewportWidth - card.width - MARGIN,
  );
  return { top, left: Math.max(MARGIN, left) };
}

/** Reopens the contextual walkthrough from any live app screen. */
export function TourButton() {
  const { start } = useTour();
  if (!IS_LIVE) return null;
  return (
    <button
      type="button"
      onClick={start}
      className="border-line text-muted hover:text-text rounded-sm border px-2.5 py-1.5 text-[0.8125rem] transition-colors"
    >
      Guide
    </button>
  );
}
