/** @vitest-environment jsdom */
import { act } from "react";
import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor, cleanup } from "@testing-library/react";
import { ResetPasswordButton } from "./ResetPasswordButton";

// vitest.config.ts doesn't set `test.globals`, so @testing-library/react's
// automatic afterEach(cleanup) registration never fires — without this, each
// test's rendered tree stays in the DOM (see IssueForm.test.tsx).
afterEach(cleanup);

const push = vi.fn();
const refresh = vi.fn();
vi.mock("next/navigation", () => ({ useRouter: () => ({ push, refresh, back: vi.fn() }) }));

const setUserPasswordAction = vi.fn();
vi.mock("../actions", () => ({
  setUserPasswordAction: (...args: unknown[]) => setUserPasswordAction(...args),
}));

const labels = {
  resetPassword: "Reset password", newPassword: "New password",
  resetConfirmTitle: "Reset password?", resetConfirmMessageTemplate: "Reset the password for {name}?",
  dismiss: "Dismiss", confirm: "Confirm",
  errors: { "errors.generic": "Something went wrong", "errors.WEAK_PASSWORD": "Password too weak" },
};

// This component is one of the three hand-rolled dialogs the Stage 1B
// accessibility fix replaced with ConfirmDialog's `field` mode — these tests
// prove the migration didn't regress the double-submit guard or the
// stay-open-on-error behavior the hand-rolled version had.
describe("ResetPasswordButton (post ConfirmDialog migration)", () => {
  beforeEach(() => {
    setUserPasswordAction.mockReset();
    push.mockReset();
    refresh.mockReset();
  });

  function openAndFillPassword(password: string) {
    fireEvent.click(screen.getByRole("button", { name: "Reset password" }));
    fireEvent.change(screen.getByLabelText("New password", { exact: false }), { target: { value: password } });
  }

  it("shows the temporary password as readable text the owner can check before handing it over", () => {
    // Pinned deliberately. An OWNER is typing a TEMPORARY password for
    // SOMEONE ELSE — masking it protects nothing they will not read aloud
    // anyway, and there is no confirmation field, so a typo they cannot see
    // locks that user out with no in-app recovery. autoComplete stays off so
    // the browser never offers to save another user's temporary password as
    // the owner's own. This flipped to type="password" once already, in a
    // commit about dialog accessibility that did not mention it; without this
    // test nothing catches that.
    render(<ResetPasswordButton userId="u-1" userName="Sara" labels={labels} />);
    fireEvent.click(screen.getByRole("button", { name: "Reset password" }));

    const input = screen.getByLabelText("New password", { exact: false }) as HTMLInputElement;
    expect(input.type).toBe("text");
    expect(input.getAttribute("autocomplete")).toBe("off");
  });

  it("keeps Confirm disabled until the password is at least 8 characters", () => {
    render(<ResetPasswordButton userId="u-1" userName="Sara" labels={labels} />);
    openAndFillPassword("short");

    expect((screen.getByRole("button", { name: "Confirm" }) as HTMLButtonElement).disabled).toBe(true);

    fireEvent.change(screen.getByLabelText("New password", { exact: false }), { target: { value: "longenough1" } });
    expect((screen.getByRole("button", { name: "Confirm" }) as HTMLButtonElement).disabled).toBe(false);
  });

  it("fires exactly one mutation when Confirm is clicked twice synchronously", () => {
    setUserPasswordAction.mockImplementation(() => new Promise(() => {})); // never resolves

    render(<ResetPasswordButton userId="u-1" userName="Sara" labels={labels} />);
    openAndFillPassword("longenough1");

    const confirmButton = screen.getByRole("button", { name: "Confirm" });
    act(() => {
      confirmButton.click();
      confirmButton.click();
    });

    expect(setUserPasswordAction).toHaveBeenCalledTimes(1);
  });

  it("stays open with the error and the typed password intact when the server rejects it", async () => {
    setUserPasswordAction.mockResolvedValueOnce({ ok: false, error: "errors.WEAK_PASSWORD" });

    render(<ResetPasswordButton userId="u-1" userName="Sara" labels={labels} />);
    openAndFillPassword("longenough1");
    fireEvent.click(screen.getByRole("button", { name: "Confirm" }));

    await waitFor(() => expect(screen.getByText("Password too weak")).toBeTruthy());
    expect(screen.getByRole("dialog")).toBeTruthy();
    expect((screen.getByLabelText("New password", { exact: false }) as HTMLInputElement).value).toBe("longenough1");
    expect(refresh).not.toHaveBeenCalled();
  });

  it("closes, clears the field, and refreshes on a successful reset", async () => {
    setUserPasswordAction.mockResolvedValueOnce({ ok: true, data: {} });

    render(<ResetPasswordButton userId="u-1" userName="Sara" labels={labels} />);
    openAndFillPassword("longenough1");
    fireEvent.click(screen.getByRole("button", { name: "Confirm" }));

    await waitFor(() => expect(refresh).toHaveBeenCalled());
    expect(screen.queryByRole("dialog")).toBeNull();
  });
});
