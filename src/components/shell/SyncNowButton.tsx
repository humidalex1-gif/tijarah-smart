"use client";

import { useRef, useState } from "react";
import { useRouter } from "next/navigation";

export type SyncNowLabels = {
  syncNow: string;
  syncing: string;
  done: string;
  /** For a failure this screen has no specific wording for. */
  generic: string;
  /** Message keys `action()` can return, already translated by the caller. */
  errors: Record<string, string>;
};

/**
 * Runs the catch-up poll from the banner that announced the problem.
 *
 * The same run is a click away on Settings → Fast Hub, which is exactly the
 * click that does not happen: the owner reads the alert HERE, and a trip to a
 * settings screen is where "I will do it in a moment" starts.
 *
 * It calls `syncFastHubAction` rather than a second entry point of its own —
 * one permission gate, one recorded run, one thing to keep correct. That
 * action's `settings.edit` gate is also the one the dashboard already tests
 * before rendering this banner at all, so the button never offers what the
 * server would refuse.
 */
export function SyncNowButton({ labels }: { labels: SyncNowLabels }) {
  const router = useRouter();
  const [done, setDone] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // `pending` is state, so a second click in the same tick would still see
  // false and start a second poll against the same cursors.
  const running = useRef(false);

  async function onClick() {
    if (running.current) return;
    running.current = true;
    setPending(true);
    setError(null);
    setDone(false);
    try {
      const { syncFastHubAction } = await import("@/app/[locale]/(app)/settings/fasthub/actions");
      const result = await syncFastHubAction(new FormData());
      if (result.ok) {
        setDone(true);
        // The banner IS the report: it re-renders from the run this just
        // wrote, and disappears if the run found nothing left to say.
        router.refresh();
      } else {
        // `action()` returns a message KEY. Rendering it raw would put
        // "errors.FASTHUB_TOKEN_EXPIRED" on the owner's dashboard.
        setError(labels.errors[result.error] ?? labels.generic);
      }
    } catch {
      setError(labels.generic);
    } finally {
      running.current = false;
      setPending(false);
    }
  }

  return (
    <div className="flex flex-wrap items-center gap-2">
      <button
        type="button"
        onClick={onClick}
        disabled={pending}
        className="rounded-lg bg-brand px-3 py-1.5 text-sm font-medium text-brand-ink disabled:opacity-60"
      >
        {pending ? labels.syncing : labels.syncNow}
      </button>
      {done && !error ? <span className="text-xs text-success">{labels.done}</span> : null}
      {error ? <span className="text-xs text-danger">{error}</span> : null}
    </div>
  );
}
