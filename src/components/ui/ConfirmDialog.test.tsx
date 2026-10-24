/** @vitest-environment jsdom */
import { useRef, useState } from "react";
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import { ConfirmDialog } from "./ConfirmDialog";

// vitest.config.ts doesn't set `test.globals`, so @testing-library/react's
// automatic afterEach(cleanup) registration never fires — without this, each
// test's rendered tree stays in the DOM and later tests fail with "multiple
// elements found" (same rationale as IssueForm.test.tsx et al.).
afterEach(cleanup);

function Plain({ onConfirmAction = vi.fn(), disabled = false }: { onConfirmAction?: () => void; disabled?: boolean }) {
  return (
    <ConfirmDialog
      triggerLabel="Open"
      title="Cancel this order?"
      message="This cannot be undone."
      confirmLabel="Confirm"
      cancelLabel="Cancel"
      onConfirmAction={onConfirmAction}
      disabled={disabled}
    />
  );
}

// Mirrors the real double-submit guard every ConfirmDialog caller owns
// (submittingRef, e.g. IssueForm.tsx) — proves the synchronous-double-click
// contract ConfirmDialog relies on still holds after the a11y rework.
function GuardedPlain({ mutate }: { mutate: () => void }) {
  const submittingRef = useRef(false);
  const [submitting, setSubmitting] = useState(false);
  function handleConfirm() {
    if (submittingRef.current) return;
    submittingRef.current = true;
    setSubmitting(true);
    mutate();
  }
  return <Plain onConfirmAction={handleConfirm} disabled={submitting} />;
}

function WithField({
  open, onOpenChangeAction, onConfirmAction = vi.fn(), disabled = false, error = null,
}: {
  open: boolean;
  onOpenChangeAction: (open: boolean) => void;
  onConfirmAction?: () => void;
  disabled?: boolean;
  error?: string | null;
}) {
  const [value, setValue] = useState("");
  return (
    <ConfirmDialog
      triggerLabel="Cancel order"
      title="Cancel this order?"
      message="This cannot be undone."
      confirmLabel="Confirm"
      cancelLabel="Dismiss"
      onConfirmAction={onConfirmAction}
      disabled={disabled}
      error={error}
      open={open}
      onOpenChangeAction={onOpenChangeAction}
      field={{ label: "Reason", value, onChange: setValue, type: "textarea", required: true }}
    />
  );
}

describe("ConfirmDialog accessibility", () => {
  it("has dialog semantics wired to the title and message", () => {
    render(<Plain />);
    fireEvent.click(screen.getByRole("button", { name: "Open" }));

    const dialog = screen.getByRole("dialog");
    expect(dialog.getAttribute("aria-modal")).toBe("true");
    const labelledBy = dialog.getAttribute("aria-labelledby");
    const describedBy = dialog.getAttribute("aria-describedby");
    expect(document.getElementById(labelledBy!)?.textContent).toBe("Cancel this order?");
    expect(document.getElementById(describedBy!)?.textContent).toBe("This cannot be undone.");
  });

  it("moves focus to the first focusable element in the dialog when it opens (no field)", () => {
    render(<Plain />);
    fireEvent.click(screen.getByRole("button", { name: "Open" }));

    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Cancel" }));
  });

  it("moves focus to the field when the dialog has one", () => {
    const onOpenChangeAction = vi.fn();
    render(<WithField open onOpenChangeAction={onOpenChangeAction} />);

    expect(document.activeElement).toBe(screen.getByLabelText("Reason", { exact: false }));
  });

  it("restores focus to the trigger when the dialog closes", () => {
    render(<Plain />);
    const trigger = screen.getByRole("button", { name: "Open" });
    fireEvent.click(trigger);
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));

    expect(screen.queryByRole("dialog")).toBeNull();
    expect(document.activeElement).toBe(trigger);
  });

  it("traps Tab within the dialog instead of letting it escape to the page", () => {
    render(<Plain />);
    fireEvent.click(screen.getByRole("button", { name: "Open" }));

    const cancelButton = screen.getByRole("button", { name: "Cancel" });
    const confirmButton = screen.getByRole("button", { name: "Confirm" });

    confirmButton.focus();
    expect(document.activeElement).toBe(confirmButton);
    fireEvent.keyDown(confirmButton, { key: "Tab" });
    expect(document.activeElement).toBe(cancelButton);

    fireEvent.keyDown(cancelButton, { key: "Tab", shiftKey: true });
    expect(document.activeElement).toBe(confirmButton);
  });

  // The panel must be focusable in its own right. In a real browser, clicking
  // the title, the message, or a field's label text moves focus to the
  // nearest focusable ancestor; with no tabIndex on the panel there is none,
  // so focus lands on <body>, the keydown handler leaves the bubble path, and
  // Escape plus the Tab trap both die silently. jsdom cannot reproduce that
  // click-to-focus behaviour, so these two tests pin the mechanism instead:
  // the panel is focusable, and the handler behaves correctly when focus is
  // on the panel rather than on one of the buttons.
  it("makes the panel itself focusable so a click on its text cannot strand focus on <body>", () => {
    render(<Plain />);
    fireEvent.click(screen.getByRole("button", { name: "Open" }));

    // Assert the ATTRIBUTE, not the `tabIndex` property: a <div> with no
    // tabindex attribute still reports `tabIndex === -1`, so the property
    // check passes whether or not the fix is present.
    expect(screen.getByRole("dialog").getAttribute("tabindex")).toBe("-1");
  });

  it("keeps Escape and the Tab trap working when focus is on the panel rather than a button", () => {
    render(<Plain />);
    fireEvent.click(screen.getByRole("button", { name: "Open" }));

    const dialog = screen.getByRole("dialog") as HTMLElement;
    const confirmButton = screen.getByRole("button", { name: "Confirm" });

    // Shift+Tab from the panel would otherwise walk backwards out of the
    // dialog entirely: the panel is the first node in its own subtree, so
    // there is nothing before it to land on.
    dialog.focus();
    expect(document.activeElement).toBe(dialog);
    fireEvent.keyDown(dialog, { key: "Tab", shiftKey: true });
    expect(document.activeElement).toBe(confirmButton);

    dialog.focus();
    fireEvent.keyDown(dialog, { key: "Escape" });
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("closes on Escape when idle", () => {
    render(<Plain />);
    fireEvent.click(screen.getByRole("button", { name: "Open" }));
    expect(screen.getByRole("dialog")).toBeTruthy();

    fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });

    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("does not close on Escape while a submit is in flight", () => {
    const onOpenChangeAction = vi.fn();
    render(<WithField open onOpenChangeAction={onOpenChangeAction} disabled />);

    fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });

    expect(onOpenChangeAction).not.toHaveBeenCalled();
    expect(screen.getByRole("dialog")).toBeTruthy();
  });

  it("dismisses on a backdrop click when idle, but not while a submit is in flight", () => {
    const onOpenChangeAction = vi.fn();
    const { rerender } = render(<WithField open onOpenChangeAction={onOpenChangeAction} disabled />);

    // The backdrop is the dialog's own parent element.
    const backdrop = screen.getByRole("dialog").parentElement!;
    fireEvent.click(backdrop);
    expect(onOpenChangeAction).not.toHaveBeenCalled();

    rerender(<WithField open onOpenChangeAction={onOpenChangeAction} disabled={false} />);
    fireEvent.click(backdrop);
    expect(onOpenChangeAction).toHaveBeenCalledWith(false);
  });

  it("does not treat a click inside the panel as a backdrop dismiss", () => {
    render(<Plain />);
    fireEvent.click(screen.getByRole("button", { name: "Open" }));
    fireEvent.click(screen.getByRole("dialog"));

    expect(screen.queryByRole("dialog")).toBeTruthy();
  });

  it("fires the confirm action exactly once when Confirm is clicked twice synchronously", () => {
    // Same race IssueForm.test.tsx guards against: two raw .click() calls
    // dispatched back-to-back before React re-renders/removes the button —
    // ConfirmDialog itself still closes-then-fires on every click (that part
    // is unchanged from before the a11y rework), so it's the caller's own
    // ref guard (mirrored here by GuardedPlain) that must still cut the
    // second call off.
    const mutate = vi.fn();
    render(<GuardedPlain mutate={mutate} />);
    fireEvent.click(screen.getByRole("button", { name: "Open" }));
    const confirmButton = screen.getByRole("button", { name: "Confirm" });

    confirmButton.click();
    confirmButton.click();

    expect(mutate).toHaveBeenCalledTimes(1);
  });

  // Every `disabled`-passing caller (the five inventory forms, both purchase
  // forms, SaleForm, ReturnForm, PaymentForm, AddAccountForm, ExpenseForm)
  // flips its `submitting` flag in the same tick as the confirm. If the
  // trigger used the real `disabled` attribute it would be unfocusable by the
  // time the restore effect ran, dropping the keyboard user on <body> at the
  // top of the page after every destructive confirm.
  it("returns focus to the trigger after confirming, even though the caller disables it on submit", () => {
    const mutate = vi.fn();
    render(<GuardedPlain mutate={mutate} />);
    const trigger = screen.getByRole("button", { name: "Open" });
    fireEvent.click(trigger);
    fireEvent.click(screen.getByRole("button", { name: "Confirm" }));

    expect(mutate).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(trigger.getAttribute("aria-disabled")).toBe("true");
    expect(document.activeElement).toBe(trigger);
  });

  it("refuses to reopen from a trigger the caller has marked unavailable", () => {
    render(<Plain disabled />);
    const trigger = screen.getByRole("button", { name: "Open" });

    fireEvent.click(trigger);

    expect(screen.queryByRole("dialog")).toBeNull();
    expect(trigger.getAttribute("aria-disabled")).toBe("true");
  });

  it("keeps a field-mode dialog open with the value and error intact after a failed submit", () => {
    function Cancel() {
      const [open, setOpen] = useState(true);
      const [error, setError] = useState<string | null>(null);
      const submittingRef = useRef(false);
      function handleConfirm() {
        if (submittingRef.current) return;
        submittingRef.current = true;
        setError("Something went wrong");
        submittingRef.current = false;
      }
      return (
        <WithField
          open={open}
          onOpenChangeAction={(next) => { setOpen(next); if (!next) setError(null); }}
          onConfirmAction={handleConfirm}
          error={error}
        />
      );
    }
    render(<Cancel />);

    fireEvent.change(screen.getByLabelText("Reason", { exact: false }), { target: { value: "Customer changed their mind" } });
    fireEvent.click(screen.getByRole("button", { name: "Confirm" }));

    expect(screen.getByRole("dialog")).toBeTruthy();
    expect(screen.getByText("Something went wrong")).toBeTruthy();
    expect((screen.getByLabelText("Reason", { exact: false }) as HTMLTextAreaElement).value)
      .toBe("Customer changed their mind");
  });

  it("disables Confirm until a required field is filled in", () => {
    const onOpenChangeAction = vi.fn();
    render(<WithField open onOpenChangeAction={onOpenChangeAction} />);

    const confirmButton = screen.getByRole("button", { name: "Confirm" }) as HTMLButtonElement;
    expect(confirmButton.disabled).toBe(true);

    fireEvent.change(screen.getByLabelText("Reason", { exact: false }), { target: { value: "Out of stock" } });
    expect(confirmButton.disabled).toBe(false);
  });
});
