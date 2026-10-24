/** @vitest-environment jsdom */
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import { BottomNav } from "./BottomNav";

/**
 * The phone's bottom bar. The sidebar is a drawer below `md`, which costs a
 * tap to open before every navigation; the four screens the owner actually
 * lives in deserve to be one tap, always visible.
 *
 * What matters here is not the styling but the contract: it renders only the
 * items the layout hands it (already permission-filtered), it marks the
 * current one, and it refuses to render as a one-button bar.
 */

const pathname = vi.hoisted(() => ({ current: "/ar/quick" }));
vi.mock("next/navigation", () => ({ usePathname: () => pathname.current }));

afterEach(cleanup);

const ITEMS = [
  { key: "quick", href: "quick", label: "الإدخال السريع" },
  { key: "dashboard", href: "dashboard", label: "لوحة التحكم" },
  { key: "sales", href: "sales", label: "المبيعات" },
  { key: "expenses", href: "expenses", label: "المصروفات" },
];

describe("BottomNav", () => {
  it("renders a link per item, pointing into the right locale", () => {
    pathname.current = "/ar/quick";
    render(<BottomNav locale="ar" items={ITEMS} />);

    const links = screen.getAllByRole("link");
    expect(links).toHaveLength(4);
    expect(links.map((l) => l.getAttribute("href"))).toEqual([
      "/ar/quick", "/ar/dashboard", "/ar/sales", "/ar/expenses",
    ]);
  });

  it("marks the current screen, resolved from the live pathname", () => {
    pathname.current = "/ar/sales/SO-0003";
    render(<BottomNav locale="ar" items={ITEMS} />);

    // aria-current, not a styling class: assistive technology gets the same
    // answer the highlight gives a sighted user.
    const current = screen.getAllByRole("link").filter((l) => l.getAttribute("aria-current") === "page");
    expect(current).toHaveLength(1);
    expect(current[0]!.getAttribute("href")).toBe("/ar/sales");
  });

  it("marks nothing on a screen the bar does not cover", () => {
    pathname.current = "/ar/settings/salla";
    render(<BottomNav locale="ar" items={ITEMS} />);

    const current = screen.getAllByRole("link").filter((l) => l.getAttribute("aria-current") === "page");
    expect(current).toHaveLength(0);
  });

  it("renders nothing rather than a one-button bar", () => {
    // A role stripped down to a single visible screen gets no bar at all: a
    // bar with one destination is chrome without navigation.
    const { container } = render(<BottomNav locale="ar" items={ITEMS.slice(0, 1)} />);
    expect(container.innerHTML).toBe("");
  });

  it("renders only what it is handed, so permission filtering upstream holds", () => {
    render(<BottomNav locale="ar" items={ITEMS.slice(0, 2)} />);
    expect(screen.getAllByRole("link")).toHaveLength(2);
    expect(screen.queryByText("المصروفات")).toBeNull();
  });
});
