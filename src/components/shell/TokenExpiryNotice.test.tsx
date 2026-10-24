/** @vitest-environment jsdom */
import { describe, it, expect, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import { getTranslator } from "@/lib/i18n";
import { TokenExpiryNotice } from "./TokenExpiryNotice";

afterEach(cleanup);

/**
 * The only warning the owner ever got that the Fast Hub token was dying was
 * the sync turning red the morning after. This is the week's notice, on the
 * screen he opens every day, with the one action that fixes it.
 */
describe("TokenExpiryNotice", () => {
  it("counts the days and points at the one screen that fixes it", async () => {
    const t = await getTranslator("en");
    render(<TokenExpiryNotice expiry={{ state: "soon", daysLeft: 3 }} locale="en" t={t} />);

    expect(screen.getByText(t("fasthub.noticeExpiresSoon", { count: 3 }))).toBeTruthy();
    const link = screen.getByRole("link", { name: t("fasthub.noticeRenew") }) as HTMLAnchorElement;
    expect(link.getAttribute("href")).toBe("/en/settings/fasthub");
  });

  it("says expired, not 'expires in 0 days', once it has happened", async () => {
    const t = await getTranslator("en");
    render(<TokenExpiryNotice expiry={{ state: "expired" }} locale="en" t={t} />);

    expect(screen.getByText(t("fasthub.noticeExpired"))).toBeTruthy();
  });

  it("renders nothing when there is nothing to warn about", async () => {
    // A daily "all fine" banner trains the owner to stop reading banners.
    const t = await getTranslator("en");
    const { container } = render(<TokenExpiryNotice expiry={null} locale="en" t={t} />);
    expect(container.firstChild).toBeNull();
  });

  it("pluralises in Arabic", async () => {
    const t = await getTranslator("ar");
    render(<TokenExpiryNotice expiry={{ state: "soon", daysLeft: 2 }} locale="ar" t={t} />);
    // Arabic has a dual: "يومين", never "٢ أيام".
    expect(screen.getByText(/يومين/)).toBeTruthy();
  });
});
