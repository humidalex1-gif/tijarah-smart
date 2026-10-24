/** @vitest-environment jsdom */
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup, waitFor } from "@testing-library/react";

// vitest.config.ts doesn't set `test.globals`, so @testing-library/react's
// automatic afterEach(cleanup) never registers (same rationale as
// ConfirmDialog.test.tsx et al.).
afterEach(cleanup);

const onboardingAction = vi.fn();
vi.mock("./actions", () => ({ onboardingAction: (...args: unknown[]) => onboardingAction(...args) }));

const { OnboardingForm } = await import("./OnboardingForm");

const labels = {
  title: "Set up", companyStep: "Company", financeStep: "Finance", warehouseStep: "Warehouse",
  companyName: "Company name", currency: "Currency", taxRate: "Tax rate",
  warehouseName: "Warehouse name", openingCash: "Opening cash", openingBank: "Opening bank",
  submit: "Finish",
  errors: {
    "errors.generic": "Something went wrong. Please try again.",
    "errors.INVALID_NAME": "That name is too short.",
  },
};

const defaults = { companyName: "", currencyCode: "SAR", taxRatePct: 15, warehouseName: "" };

function renderForm() {
  const utils = render(<OnboardingForm locale="en" defaults={defaults} labels={labels} />);
  // Submit the FORM, not the button: React 19 drives a form action off the
  // submit event, and jsdom does not turn a click on type="submit" into one.
  const submit = () => fireEvent.submit(utils.container.querySelector("form")!);
  return { ...utils, submit };
}

// The banner used to render only when `fields` was falsy. It never is on a
// validation failure: zod's flatten().fieldErrors is `{}` for an
// object-level issue and `{locale: [...]}` for a bad locale — both truthy,
// and neither has a rendered FormField to appear next to, since `locale` is
// a hidden input. So the one piece of feedback available was suppressed and
// the form silently did nothing on submit.
describe("OnboardingForm error feedback", () => {
  it("shows the banner when the failure has no field the form actually renders", async () => {
    onboardingAction.mockResolvedValue({ error: "errors.generic", fields: { locale: ["errors.INVALID_LOCALE"] } });
    const { submit } = renderForm();

    submit();

    await waitFor(() => {
      expect(screen.getByText("Something went wrong. Please try again.")).toBeTruthy();
    });
  });

  it("shows the banner when the failure carries no field errors at all", async () => {
    onboardingAction.mockResolvedValue({ error: "errors.generic", fields: {} });
    const { submit } = renderForm();

    submit();

    await waitFor(() => {
      expect(screen.getByText("Something went wrong. Please try again.")).toBeTruthy();
    });
  });

  it("suppresses the banner when the error is already shown next to its own field", async () => {
    onboardingAction.mockResolvedValue({ error: "errors.generic", fields: { companyName: ["errors.INVALID_NAME"] } });
    const { submit } = renderForm();

    submit();

    await waitFor(() => {
      expect(screen.getByText("That name is too short.")).toBeTruthy();
    });
    expect(screen.queryByText("Something went wrong. Please try again.")).toBeNull();
  });
});
