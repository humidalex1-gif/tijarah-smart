"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  detectPlatform, isInstalled, shouldOffer, DISMISS_KEY, INSTALLED_MEDIA_QUERY,
  type InstallPlatform,
} from "@/lib/install";

/**
 * Offers the app on a laptop, an Android phone and an iPhone.
 *
 * The three platforms install differently, and the difference is not
 * cosmetic. Chrome and Edge announce installability with an event and open a
 * native dialog; iOS Safari has no install API whatsoever and can only be
 * told which buttons to tap.
 *
 * So the event decides the CONTENT, never the visibility. Gating the panel on
 * it was the first design and it was wrong twice: Safari never fires it, and a
 * live check against production saw Chrome not fire it either — which would
 * have left the laptop silently never offered the app at all. The panel shows
 * everywhere; where the browser will honour a button it gets one, and where it
 * will not it gets steps. There is never a button that opens nothing.
 */

export interface InstallPanelLabels {
  title: string;
  body: string;
  install: string;
  installing: string;
  dismiss: string;
  close: string;
  stepsTitle: string;
  iosSteps: string[];
  androidSteps: string[];
  desktopSteps: string[];
}

/** Chrome's install event. Not in TypeScript's DOM library. */
interface InstallPromptEvent extends Event {
  prompt: () => Promise<void>;
  userChoice?: Promise<{ outcome: string }>;
}

function readDismissedAt(): number | null {
  // Private browsing and locked-down enterprise profiles throw on access, and
  // an install banner is never worth taking the page down for.
  try {
    const raw = window.localStorage.getItem(DISMISS_KEY);
    if (!raw) return null;
    const n = Number(raw);
    return Number.isFinite(n) ? n : null;
  } catch {
    return null;
  }
}

function writeDismissedAt(at: number): void {
  try {
    window.localStorage.setItem(DISMISS_KEY, String(at));
  } catch {
    // Dismissal then lasts only this page view. Better than a crash.
  }
}

export function InstallPanel({
  labels, delayMs = 4000,
}: {
  labels: InstallPanelLabels;
  /** A beat before appearing, so it never lands on top of a first paint. */
  delayMs?: number;
}) {
  // Computed once, during the first render rather than in an effect: both
  // depend only on the browser, and setting state from an effect to derive
  // them makes React render twice and trips `react-hooks/set-state-in-effect`.
  // Server-side there is no navigator, so both fall back to values that render
  // nothing — and since the panel returns null until `visible`, the server and
  // client markup agree either way.
  const [platform] = useState<InstallPlatform>(() =>
    typeof navigator === "undefined"
      ? "desktop"
      : detectPlatform({
        userAgent: navigator.userAgent,
        platform: navigator.platform,
        maxTouchPoints: navigator.maxTouchPoints,
      }));

  const [offerAllowed] = useState<boolean>(() => {
    if (typeof window === "undefined") return false;
    const installed = isInstalled({
      standaloneMedia: window.matchMedia(INSTALLED_MEDIA_QUERY).matches,
      navigatorStandalone: (navigator as Navigator & { standalone?: boolean }).standalone,
    });
    return shouldOffer({
      installed,
      dismissedAt: readDismissedAt(),
      now: Date.now(),
      canPrompt: false,
      platform: "desktop",
    });
  });

  const [visible, setVisible] = useState(false);
  const [busy, setBusy] = useState(false);
  const promptEvent = useRef<InstallPromptEvent | null>(null);
  const [canPrompt, setCanPrompt] = useState(false);

  useEffect(() => {
    if (!offerAllowed) return;

    // Always through a timer, even at zero: state set straight from an effect
    // renders twice and the lint rule refuses it. A zero-delay timer still
    // resolves before any assertion that awaits the panel.
    const timer = window.setTimeout(() => setVisible(true), delayMs);

    // Chrome fires this when it decides the page is installable. It can arrive
    // before or after this component mounts, so it is captured whenever it
    // comes rather than checked once.
    const onBeforeInstallPrompt = (event: Event) => {
      event.preventDefault();
      promptEvent.current = event as InstallPromptEvent;
      setCanPrompt(true);
    };
    // Leaving the panel up after a successful install invites a second attempt.
    const onInstalled = () => {
      setVisible(false);
      promptEvent.current = null;
    };

    window.addEventListener("beforeinstallprompt", onBeforeInstallPrompt);
    window.addEventListener("appinstalled", onInstalled);
    return () => {
      window.clearTimeout(timer);
      window.removeEventListener("beforeinstallprompt", onBeforeInstallPrompt);
      window.removeEventListener("appinstalled", onInstalled);
    };
  }, [delayMs, offerAllowed]);

  const dismiss = useCallback(() => {
    writeDismissedAt(Date.now());
    setVisible(false);
  }, []);

  const install = useCallback(async () => {
    const event = promptEvent.current;
    if (!event) return;
    setBusy(true);
    try {
      await event.prompt();
      await event.userChoice;
      // The saved event is single-use: a second `prompt()` throws.
      promptEvent.current = null;
      setCanPrompt(false);
      setVisible(false);
    } catch (e) {
      console.error("Install prompt failed:", e);
    } finally {
      setBusy(false);
    }
  }, []);

  if (!visible) return null;

  const steps = platform === "ios"
    ? labels.iosSteps
    : platform === "android"
      ? labels.androidSteps
      : labels.desktopSteps;

  return (
    <div
      role="dialog"
      aria-label={labels.title}
      // Lifted clear of BottomNav, which is `fixed bottom-0` and about 3.4rem
      // tall below `md`: at `bottom-0` this card landed on top of the four
      // primary tabs four seconds after every page load and covered them until
      // dismissed. The bottom padding carries the home-indicator inset the way
      // BottomNav does, added to the padding already here rather than
      // replacing it, so the card keeps its gap on a phone without one.
      className="fixed inset-x-0 bottom-[4.5rem] z-50 mx-auto max-w-md p-3 pb-[calc(0.75rem+env(safe-area-inset-bottom))] sm:p-4 sm:pb-[calc(1rem+env(safe-area-inset-bottom))] md:bottom-0"
    >
      <div className="rounded-2xl border border-line bg-panel p-4 shadow-lg">
        <div className="flex items-start gap-3">
          <span aria-hidden className="text-2xl">📲</span>
          <div className="min-w-0 flex-1">
            <h2 className="text-base font-bold text-navy">{labels.title}</h2>
            <p className="mt-1 text-sm text-muted">{labels.body}</p>
          </div>
          <button
            type="button"
            onClick={dismiss}
            aria-label={labels.close}
            className="rounded-lg px-2 py-1 text-lg text-muted hover:text-navy"
          >
            <span aria-hidden>×</span>
          </button>
        </div>

        {canPrompt ? (
          <div className="mt-4 flex gap-2">
            <button
              type="button"
              onClick={install}
              disabled={busy}
              className="flex-1 rounded-xl bg-brand p-3 text-sm font-bold text-brand-ink disabled:opacity-60"
            >
              {busy ? labels.installing : labels.install}
            </button>
            <button
              type="button"
              onClick={dismiss}
              className="rounded-xl border border-line px-4 text-sm text-navy"
            >
              {labels.dismiss}
            </button>
          </div>
        ) : (
          <div className="mt-3">
            <p className="text-xs font-semibold text-muted">{labels.stepsTitle}</p>
            <ol className="mt-2 space-y-1 text-sm text-navy">
              {steps.map((step, i) => (
                <li key={step} className="flex gap-2">
                  <span aria-hidden className="text-muted">{i + 1}.</span>
                  <span>{step}</span>
                </li>
              ))}
            </ol>
            <button
              type="button"
              onClick={dismiss}
              className="mt-3 w-full rounded-xl border border-line p-2.5 text-sm text-navy"
            >
              {labels.dismiss}
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
