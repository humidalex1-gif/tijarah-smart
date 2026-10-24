"use client";

import { useEffect, useId, useRef, useState } from "react";
import { FormField, inputClass } from "@/components/ui/FormField";

const FOCUSABLE_SELECTOR =
  'a[href], button:not([disabled]), textarea:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])';

/**
 * The one extra field a confirm dialog is allowed to grow — a required
 * cancellation reason, or a new password. Deliberately singular: a caller
 * that needs more than one field needs a real form, not this dialog.
 */
export interface ConfirmDialogField {
  label: string;
  value: string;
  onChange: (value: string) => void;
  type?: "text" | "textarea" | "password";
  required?: boolean;
  minLength?: number;
  rows?: number;
  autoComplete?: string;
}

// The prop is named onConfirmAction, not onConfirm: Next only lets a server
// component pass a function across the client boundary when the prop name
// ends in "Action", and every caller of this dialog is a server page handing
// down a server action.
export function ConfirmDialog({
  triggerLabel, title, message, confirmLabel, cancelLabel, onConfirmAction, tone = "danger",
  disabled = false,
  field,
  error,
  open: openProp,
  onOpenChangeAction,
}: {
  triggerLabel: string;
  title: string;
  message: string;
  confirmLabel: string;
  cancelLabel: string;
  onConfirmAction: () => void;
  tone?: "danger" | "brand";
  /**
   * Disables the trigger button — the caller's escape hatch for a
   * non-idempotent mutation already in flight. Without this, the trigger
   * stays clickable the whole time a stock mutation is in flight: a second
   * click re-opens the dialog and a second confirm fires a fully independent
   * mutation (receiving/issuing the same units twice). The five inventory
   * forms pass their own `submitting` state here. For a `field` dialog it
   * also disables Confirm/Cancel and blocks Escape/backdrop dismiss while
   * `field.onChange`'s own async submit is in flight, so the merchant can't
   * abandon a request mid-flight with no feedback.
   */
  disabled?: boolean;
  /** Adds a single text field — see `ConfirmDialogField`. */
  field?: ConfirmDialogField;
  /** Pre-translated error to show inside the dialog. Only meaningful with `open`/`onOpenChangeAction`, since a plain dialog closes unconditionally on confirm and has nowhere to show it. */
  error?: string | null;
  /**
   * Controlled open state. Omit for the normal behavior (confirm closes the
   * dialog immediately, then fires). Pass both when the caller must keep the
   * dialog open across a failed submit — the `field` dialogs (a cancel
   * reason, a new password) validate/mutate server-side and need to show
   * `error` with the field value intact rather than silently closing.
   */
  open?: boolean;
  onOpenChangeAction?: (open: boolean) => void;
}) {
  const [uncontrolledOpen, setUncontrolledOpen] = useState(false);
  const isControlled = openProp !== undefined;
  const open = isControlled ? openProp : uncontrolledOpen;

  function setOpen(next: boolean) {
    if (isControlled) onOpenChangeAction?.(next);
    else setUncontrolledOpen(next);
  }

  // Closing must never strand the user mid-mutation: while `disabled`
  // (a submit is in flight), Escape and the backdrop are no-ops. The Cancel
  // button is also disabled below for the same reason.
  function requestClose() {
    if (disabled) return;
    setOpen(false);
  }

  function handleConfirmClick() {
    // Plain (uncontrolled) dialogs close immediately and then fire — the
    // original behavior every non-field caller already depends on. `field`
    // dialogs are controlled by the caller, which only closes on a
    // successful submit (see e.g. ExpenseDetailActions' handleCancel), so
    // the dialog can stay open with `error` shown on failure.
    if (!isControlled) setOpen(false);
    onConfirmAction();
  }

  const titleId = useId();
  const messageId = useId();
  const panelRef = useRef<HTMLDivElement>(null);
  const fieldRef = useRef<HTMLInputElement | HTMLTextAreaElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  // Tracks whether the dialog was open on the previous render, so the
  // focus-restore effect only fires on a genuine open->close transition —
  // not on mount, when `open` starts false and there is nothing to restore.
  const wasOpenRef = useRef(false);

  useEffect(() => {
    if (open) {
      wasOpenRef.current = true;
      const toFocus = fieldRef.current ?? panelRef.current?.querySelector<HTMLElement>(FOCUSABLE_SELECTOR);
      toFocus?.focus();
    } else if (wasOpenRef.current) {
      wasOpenRef.current = false;
      triggerRef.current?.focus();
    }
  }, [open]);

  function handleKeyDown(e: React.KeyboardEvent<HTMLDivElement>) {
    if (e.key === "Escape") {
      e.stopPropagation();
      requestClose();
      return;
    }
    if (e.key !== "Tab") return;
    const panel = panelRef.current;
    if (!panel) return;
    const focusables = Array.from(panel.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR));
    if (focusables.length === 0) return;
    const first = focusables[0];
    const last = focusables[focusables.length - 1];
    const active = document.activeElement;
    // `active === panel` is the click-on-the-title case the tabIndex above
    // admits: focus sits on the panel itself, which is outside the focusable
    // ring. Shift+Tab from there would otherwise escape backwards into the
    // page behind the dialog, since the panel is the first thing in its own
    // subtree.
    const outsideRing = active === panel || !panel.contains(active);
    if (e.shiftKey) {
      if (active === first || outsideRing) {
        e.preventDefault();
        last.focus();
      }
    } else if (active === last || outsideRing) {
      e.preventDefault();
      first.focus();
    }
  }

  const fieldInvalid = !!field && (
    (!!field.required && field.value.trim() === "")
    || (field.minLength !== undefined && field.value.trim().length < field.minLength)
  );

  return (
    <>
      {/*
        aria-disabled, not the `disabled` attribute: a disabled button is not
        focusable, and browsers blur it the moment it becomes disabled. The
        trigger is exactly where focus must return when the dialog closes, and
        every `disabled`-passing caller sets its `submitting` flag in the same
        tick as the confirm — so a real `disabled` here dropped focus to
        <body> after every destructive confirm. aria-disabled keeps the button
        focusable and still announces "dimmed/unavailable"; onClick enforces
        the behaviour the attribute used to.
      */}
      <button
        ref={triggerRef}
        type="button"
        onClick={() => { if (!disabled) setOpen(true); }}
        aria-disabled={disabled || undefined}
        className={`rounded-lg px-3 py-1.5 text-sm font-medium aria-disabled:cursor-not-allowed aria-disabled:opacity-50 ${
          tone === "danger" ? "text-danger hover:bg-danger/10" : "text-brand hover:bg-brand/10"
        }`}
      >
        {triggerLabel}
      </button>

      {open ? (
        // The backdrop is mouse-only by design: it carries no role/tabIndex,
        // so it is never a keyboard stop. Keyboard users dismiss via Escape
        // or the Cancel button below, both routed through requestClose().
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
          onClick={(e) => { if (e.target === e.currentTarget) requestClose(); }}
        >
          {/*
            tabIndex={-1} is load-bearing, not decoration. handleKeyDown is
            bound here, so it only runs while focus is inside the panel.
            Clicking non-focusable content — the title, the message, a field's
            label text — moves focus to the nearest focusable ancestor; without
            a tabIndex there is none, so focus lands on <body> and both Escape
            and the Tab trap silently stop working. jsdom cannot show this:
            fireEvent dispatches at the panel no matter where focus really is.
          */}
          <div
            ref={panelRef}
            tabIndex={-1}
            role="dialog"
            aria-modal="true"
            aria-labelledby={titleId}
            aria-describedby={message ? messageId : undefined}
            onKeyDown={handleKeyDown}
            className="w-full max-w-md rounded-xl bg-panel p-6 shadow-lg"
          >
            <h3 id={titleId} className="text-lg font-semibold">{title}</h3>
            {/* State the real impact, per the requirements' confirmation rules. */}
            <p id={messageId} className="mt-2 text-sm leading-relaxed text-muted">{message}</p>

            {field ? (
              <div className="mt-4">
                <FormField label={field.label} required={field.required}>
                  {field.type === "textarea" ? (
                    <textarea
                      ref={fieldRef as React.RefObject<HTMLTextAreaElement>}
                      required={field.required}
                      rows={field.rows ?? 3}
                      value={field.value}
                      onChange={(e) => field.onChange(e.target.value)}
                      className={inputClass}
                    />
                  ) : (
                    <input
                      ref={fieldRef as React.RefObject<HTMLInputElement>}
                      type={field.type ?? "text"}
                      required={field.required}
                      minLength={field.minLength}
                      autoComplete={field.autoComplete}
                      value={field.value}
                      onChange={(e) => field.onChange(e.target.value)}
                      className={inputClass}
                    />
                  )}
                </FormField>
              </div>
            ) : null}

            {error ? <p className="mt-2 text-sm text-danger">{error}</p> : null}

            <div className="mt-6 flex justify-end gap-2">
              <button
                type="button"
                onClick={requestClose}
                disabled={disabled}
                className="rounded-lg border border-line px-4 py-2 text-sm disabled:cursor-not-allowed disabled:opacity-50"
              >
                {cancelLabel}
              </button>
              <button
                type="button"
                onClick={handleConfirmClick}
                disabled={disabled || fieldInvalid}
                className={`rounded-lg px-4 py-2 text-sm font-medium text-brand-ink disabled:cursor-not-allowed disabled:opacity-50 ${
                  tone === "danger" ? "bg-danger" : "bg-brand"
                }`}
              >
                {confirmLabel}
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </>
  );
}
