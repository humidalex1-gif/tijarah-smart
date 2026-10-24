"use client";

import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { formatNumber } from "@/lib/format";
import type { Locale } from "@/lib/i18n";
import { barSegments } from "./segments";

/**
 * The landing page's motion, in two pieces: things that arrive as you reach
 * them, and numerals that count themselves up.
 *
 * Three rules hold throughout, and each exists because the obvious
 * implementation of scroll animation breaks something:
 *
 * 1. **The server renders the FINISHED state.** Hiding elements in CSS and
 *    revealing them with JavaScript means a visitor with JavaScript off, or a
 *    crawler, gets a blank page. Here the hidden state is only ever applied by
 *    the client, so the page is complete without it.
 * 2. **Anything already on screen at mount is never hidden.** Arming it would
 *    hide content the visitor is looking at and flash it back a frame later.
 *    It is marked arrived instead, and simply does not animate.
 * 3. **`prefers-reduced-motion` short-circuits both.** Not a reduced duration —
 *    no arming at all, so nothing moves and nothing counts.
 */

type Tag = "div" | "section" | "article" | "li" | "p" | "h2";

function useArrival() {
  const ref = useRef<HTMLElement | null>(null);
  const [arrived, setArrived] = useState<"ssr" | "armed" | "in">("ssr");

  useEffect(() => {
    const element = ref.current;
    if (!element) return;
    if (typeof IntersectionObserver === "undefined") return;
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;

    // Rule 2: on screen already, so it has been seen. Never hide it.
    if (element.getBoundingClientRect().top < window.innerHeight) {
      setArrived("in");
      return;
    }

    setArrived("armed");
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (!entry.isIntersecting) continue;
          setArrived("in");
          observer.disconnect();
        }
      },
      // Fires a little before the element's top edge reaches the fold, so the
      // movement is finishing as it comes into reading position rather than
      // starting there.
      { rootMargin: "0px 0px -10% 0px" },
    );
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  return { ref, arrived };
}

/** Rises and fades in on arrival. `delay` staggers siblings. */
export function Reveal({
  children, className = "", delay = 0, as = "div",
}: {
  children: ReactNode; className?: string; delay?: number; as?: Tag;
}) {
  const { ref, arrived } = useArrival();
  const Element = as as "div";
  const state = arrived === "ssr" ? "" : arrived === "armed" ? "reveal" : "reveal is-in";

  return (
    <Element
      ref={ref as React.Ref<HTMLDivElement>}
      className={`${state} ${className}`.trim()}
      style={delay ? { transitionDelay: `${delay}ms` } : undefined}
    >
      {children}
    </Element>
  );
}

/**
 * A hairline that draws itself along the reading direction. Swiss structure
 * made temporal: the rule is the grid being ruled.
 *
 * The origin is set from the document direction rather than hardcoded left, or
 * every rule on the Arabic page would draw backwards.
 */
export function DrawRule({ className = "", delay = 0 }: { className?: string; delay?: number }) {
  const { ref, arrived } = useArrival();
  const state = arrived === "ssr" ? "" : arrived === "armed" ? "draw" : "draw is-in";

  return (
    <div
      ref={ref as React.Ref<HTMLDivElement>}
      aria-hidden
      className={`${state} h-px w-full bg-hairline ${className}`.trim()}
      style={delay ? { transitionDelay: `${delay}ms` } : undefined}
    />
  );
}

/**
 * Counts a quantity up on arrival.
 *
 * The value is formatted through `formatNumber` on every frame, not just at
 * the end, so an Arabic page counts in Arabic-Indic digits the whole way. The
 * app shipped that exact bug on the reconcile screen once.
 */
export function CountUp({
  value, locale, className = "", durationMs = 1000, delay = 0,
}: {
  value: number; locale: Locale; className?: string; durationMs?: number; delay?: number;
}) {
  const ref = useRef<HTMLSpanElement | null>(null);
  // Matches the server's render exactly, so hydration has nothing to reconcile.
  const [shown, setShown] = useState(value);

  useEffect(() => {
    const element = ref.current;
    if (!element) return;
    if (typeof IntersectionObserver === "undefined") return;
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    if (element.getBoundingClientRect().top < window.innerHeight) return;

    setShown(0);
    let frame = 0;
    let start = 0;

    const step = (now: number) => {
      if (!start) start = now;
      const elapsed = now - start - delay;
      if (elapsed < 0) { frame = requestAnimationFrame(step); return; }
      const progress = Math.min(1, elapsed / durationMs);
      // Cubic ease-out: the figure lands rather than stopping dead.
      setShown(Math.round(value * (1 - Math.pow(1 - progress, 3))));
      if (progress < 1) frame = requestAnimationFrame(step);
    };

    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (!entry.isIntersecting) continue;
          frame = requestAnimationFrame(step);
          observer.disconnect();
        }
      },
      { rootMargin: "0px 0px -10% 0px" },
    );
    observer.observe(element);

    return () => {
      observer.disconnect();
      if (frame) cancelAnimationFrame(frame);
    };
  }, [value, locale, durationMs, delay]);

  return <span ref={ref} className={className}>{formatNumber(shown, locale)}</span>;
}

/* ------------------------------------------------------------------------ */
/* Added for the rebuilt front door. Every piece below obeys the same three   */
/* rules as the two above: the server renders the finished state, anything    */
/* already on screen is never hidden, and reduced motion means NO motion —    */
/* not a shorter one.                                                        */
/* ------------------------------------------------------------------------ */

/** True when the visitor has asked for less motion. Safe before hydration. */
function prefersReducedMotion(): boolean {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") return false;
  return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

/**
 * A gradient hairline across the top that tracks how far the page is read.
 *
 * Progress is written to a CSS custom property rather than to React state:
 * a scroll handler that re-renders the tree fires on every frame of every
 * scroll, and this page has eight animated sections under it.
 */
export function ScrollProgress() {
  const ref = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (prefersReducedMotion()) return;
    const element = ref.current;
    if (!element) return;

    let frame = 0;
    const paint = () => {
      frame = 0;
      const scrollable = document.documentElement.scrollHeight - window.innerHeight;
      const ratio = scrollable > 0 ? window.scrollY / scrollable : 0;
      element.style.setProperty("--tj-progress", String(Math.min(1, Math.max(0, ratio))));
    };
    const onScroll = () => { if (!frame) frame = requestAnimationFrame(paint); };

    paint();
    window.addEventListener("scroll", onScroll, { passive: true });
    window.addEventListener("resize", onScroll, { passive: true });
    return () => {
      window.removeEventListener("scroll", onScroll);
      window.removeEventListener("resize", onScroll);
      if (frame) cancelAnimationFrame(frame);
    };
  }, []);

  return <div ref={ref} aria-hidden className="tj-progress" />;
}

/**
 * Moves its children against the scroll, slowly.
 *
 * Decoration only — never wrap content in this. A reader who scrolls to a
 * heading and finds it still drifting has been given a moving target.
 */
export function Parallax({
  children, speed = 0.12, className = "",
}: {
  children: ReactNode; speed?: number; className?: string;
}) {
  const ref = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (prefersReducedMotion()) return;
    const element = ref.current;
    if (!element) return;

    let frame = 0;
    const paint = () => {
      frame = 0;
      const box = element.getBoundingClientRect();
      // Measured from the viewport's middle so the offset is zero when the
      // element is centred, and symmetric either side of it.
      const fromCentre = (box.top + box.height / 2) - window.innerHeight / 2;
      element.style.transform = `translate3d(0, ${(-fromCentre * speed).toFixed(2)}px, 0)`;
    };
    const onScroll = () => { if (!frame) frame = requestAnimationFrame(paint); };

    paint();
    window.addEventListener("scroll", onScroll, { passive: true });
    window.addEventListener("resize", onScroll, { passive: true });
    return () => {
      window.removeEventListener("scroll", onScroll);
      window.removeEventListener("resize", onScroll);
      if (frame) cancelAnimationFrame(frame);
    };
  }, [speed]);

  return <div ref={ref} aria-hidden className={className}>{children}</div>;
}

/**
 * A card that leans very slightly toward the pointer.
 *
 * Pointer-driven, so it never fires on touch: a phone has no hover, and a
 * tilt that latched on tap would leave the card crooked. It also resets on
 * leave, which the naive version forgets.
 */
export function Tilt({
  children, className = "", max = 6,
}: {
  children: ReactNode; className?: string; max?: number;
}) {
  const ref = useRef<HTMLDivElement | null>(null);

  /**
   * Asked at the moment of the move, not stored from an effect.
   *
   * Storing it meant a state write inside an effect, which renders every card
   * on this page twice for a value that never changes; and it would have gone
   * stale anyway when a laptop with a touchscreen switches input. The query is
   * cheap and the answer is always current.
   */
  const canTilt = useCallback(() => {
    if (typeof window === "undefined" || typeof window.matchMedia !== "function") return false;
    if (prefersReducedMotion()) return false;
    // Fine pointer only: a coarse pointer has no hover to follow, and a tilt
    // latched on tap would leave the card crooked.
    return window.matchMedia("(hover: hover) and (pointer: fine)").matches;
  }, []);

  const onMove = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    const element = ref.current;
    if (!element || !canTilt()) return;
    const box = element.getBoundingClientRect();
    const x = (event.clientX - box.left) / box.width - 0.5;
    const y = (event.clientY - box.top) / box.height - 0.5;
    element.style.transform =
      `perspective(900px) rotateX(${(-y * max).toFixed(2)}deg) rotateY(${(x * max).toFixed(2)}deg)`;
  }, [canTilt, max]);

  const reset = useCallback(() => {
    const element = ref.current;
    if (element) element.style.transform = "";
  }, []);

  return (
    <div
      ref={ref}
      className={`tj-tilt ${className}`.trim()}
      onPointerMove={onMove}
      onPointerLeave={reset}
    >
      {children}
    </div>
  );
}

/**
 * The page's one argument, drawn: a whole bar that splits into its causes.
 *
 * A gap of 13 units is not 13 units of loss — it is 10 still being claimed
 * and 3 actually lost, and that distinction is the entire product. The bar
 * arrives whole, then parts along the boundary between the two.
 *
 * Widths come from `barSegments`, which allocates them the same way the money
 * code splits a shipment's freight, so the pieces fill the bar exactly instead
 * of leaving a rounding sliver at the end.
 */
export function SplitBar({
  parts, className = "",
}: {
  parts: { value: number; label: string; tone: "claim" | "loss" }[];
  className?: string;
}) {
  const { ref, arrived } = useArrival();
  const widths = barSegments(parts.map((p) => p.value));
  const drawable = parts.filter((p) => Number.isFinite(p.value) && p.value > 0);
  const split = arrived === "in" || arrived === "ssr";

  return (
    <div
      ref={ref as React.Ref<HTMLDivElement>}
      className={`tj-split ${split ? "is-split" : ""} ${className}`.trim()}
      aria-hidden
    >
      {drawable.map((part, i) => (
        <span
          key={part.label}
          className={`tj-split-part tj-split-${part.tone}`}
          style={{ width: `${widths[i]}%`, transitionDelay: `${i * 220}ms` }}
        />
      ))}
    </div>
  );
}
