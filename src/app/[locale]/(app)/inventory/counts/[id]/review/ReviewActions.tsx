"use client";

import { useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { postStockCountAction, cancelStockCountAction, requestRecountAction } from "../../actions";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";

export interface ReviewActionsLabels {
  post: string;
  postConfirmTitle: string;
  /** Fully resolved server-side (page.tsx via `t(key, vars)`), same pattern
   * as ExpenseDetailActions.tsx's `cancelMessage` — every var this message
   * needs (countNumber, warehouse, movingCount, uncountedCount,
   * driftedCount) is already known at render time, so there is nothing a
   * client-side fillTemplate would add. */
  postConfirmMessage: string;
  cancel: string;
  cancelTitle: string;
  cancelReason: string;
  cancelMessage: string;
  confirm: string;
  dismiss: string;
  loading: string;
  errors: Record<string, string>;
}

export function ReviewActions({
  sessionId, labels,
}: {
  sessionId: string;
  labels: ReviewActionsLabels;
}) {
  const router = useRouter();

  // --- Post ---
  const [postSubmitting, setPostSubmitting] = useState(false);
  const postRef = useRef(false);
  const [postError, setPostError] = useState<string | null>(null);

  async function handlePost() {
    if (postRef.current) return;
    postRef.current = true;
    setPostSubmitting(true);
    const fd = new FormData();
    fd.set("sessionId", sessionId);
    try {
      const res = await postStockCountAction(fd);
      if (res.ok) {
        setPostError(null);
        router.refresh();
      } else {
        setPostError(labels.errors[res.error] ?? labels.errors["errors.generic"]);
      }
    } catch (error) {
      console.error("Post stock count request failed:", error);
      setPostError(labels.errors["errors.generic"]);
    } finally {
      postRef.current = false;
      setPostSubmitting(false);
    }
  }

  // --- Cancel (requires a reason — ConfirmDialog's `field` prop, controlled
  // so a failed submit keeps the dialog open with the reason intact, same
  // pattern as ExpenseDetailActions/PurchaseDetailActions). ---
  const [cancelOpen, setCancelOpen] = useState(false);
  const [reason, setReason] = useState("");
  const [cancelSubmitting, setCancelSubmitting] = useState(false);
  const cancelRef = useRef(false);
  const [cancelError, setCancelError] = useState<string | null>(null);

  async function handleCancel() {
    if (cancelRef.current || reason.trim() === "") return;
    cancelRef.current = true;
    setCancelSubmitting(true);
    const fd = new FormData();
    fd.set("sessionId", sessionId);
    fd.set("reason", reason);
    try {
      const res = await cancelStockCountAction(fd);
      if (res.ok) {
        setCancelOpen(false);
        setReason("");
        setCancelError(null);
        router.refresh();
      } else {
        setCancelError(labels.errors[res.error] ?? labels.errors["errors.generic"]);
      }
    } catch (error) {
      console.error("Cancel stock count request failed:", error);
      setCancelError(labels.errors["errors.generic"]);
    } finally {
      cancelRef.current = false;
      setCancelSubmitting(false);
    }
  }

  return (
    <div className="flex flex-wrap items-start gap-2">
      <div>
        <ConfirmDialog
          triggerLabel={postSubmitting ? labels.loading : labels.post}
          title={labels.postConfirmTitle}
          message={labels.postConfirmMessage}
          confirmLabel={labels.confirm}
          cancelLabel={labels.dismiss}
          tone="brand"
          onConfirmAction={handlePost}
          disabled={postSubmitting}
        />
        {postError ? <p className="mt-2 text-sm text-danger">{postError}</p> : null}
      </div>

      <ConfirmDialog
        triggerLabel={labels.cancel}
        title={labels.cancelTitle}
        message={labels.cancelMessage}
        confirmLabel={labels.confirm}
        cancelLabel={labels.dismiss}
        onConfirmAction={handleCancel}
        disabled={cancelSubmitting}
        field={{
          label: labels.cancelReason,
          value: reason,
          onChange: setReason,
          type: "textarea",
          required: true,
        }}
        error={cancelError}
        open={cancelOpen}
        onOpenChangeAction={(next) => {
          setCancelOpen(next);
          if (!next) { setReason(""); setCancelError(null); }
        }}
      />
    </div>
  );
}

/**
 * A reviewer's per-line tool: send one line back for a fresh count. This is
 * NOT the low-stakes action the name suggests — requestRecount (see
 * src/services/stockCount.ts) also flips the WHOLE session from REVIEW back
 * to OPEN, which this page's own `status === "OPEN"` guard then bounces
 * straight to the counting screen. One click on any single row therefore
 * throws the reviewer out of review entirely: nothing can be posted again
 * until the counter re-submits the whole session for review. That side
 * effect is deliberate (the counting screen only ever serves OPEN sessions,
 * so a requested recount needs somewhere reachable to land), but it is
 * exactly the kind of session-wide, hard-to-undo consequence that earns a
 * ConfirmDialog elsewhere in this file — so it gets one here too, following
 * the same disabled/submittingRef/error pattern as the plain (uncontrolled)
 * Post dialog above. Gated on `inventory.count_post` at the server-action
 * layer (requestRecountAction), and only ever rendered by the page while
 * `session.status === "REVIEW"`.
 */
export function RecountButton({
  lineId, label, loadingLabel, confirmTitle, confirmMessage, confirmLabel, dismissLabel, errors,
}: {
  lineId: string;
  label: string;
  loadingLabel: string;
  confirmTitle: string;
  confirmMessage: string;
  confirmLabel: string;
  dismissLabel: string;
  errors: Record<string, string>;
}) {
  const router = useRouter();
  const [submitting, setSubmitting] = useState(false);
  // Guards the same synchronous-double-click race every other mutation call
  // site in this codebase guards (submittingRef) — two rows can recount at
  // the same time; only a second click on the SAME row before its own
  // request resolves must be swallowed.
  const submittingRef = useRef(false);
  const [error, setError] = useState<string | null>(null);

  async function handleClick() {
    if (submittingRef.current) return;
    submittingRef.current = true;
    setSubmitting(true);
    const fd = new FormData();
    fd.set("lineId", lineId);
    try {
      const res = await requestRecountAction(fd);
      if (res.ok) {
        setError(null);
        router.refresh();
      } else {
        setError(errors[res.error] ?? errors["errors.generic"]);
      }
    } catch (err) {
      console.error("Request recount failed:", err);
      setError(errors["errors.generic"]);
    } finally {
      submittingRef.current = false;
      setSubmitting(false);
    }
  }

  return (
    <div>
      <ConfirmDialog
        triggerLabel={submitting ? loadingLabel : label}
        title={confirmTitle}
        message={confirmMessage}
        confirmLabel={confirmLabel}
        cancelLabel={dismissLabel}
        onConfirmAction={handleClick}
        disabled={submitting}
      />
      {error ? <p className="mt-1 text-xs text-danger">{error}</p> : null}
    </div>
  );
}
