/** @vitest-environment jsdom */
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import { Sidebar } from "./Sidebar";
import { PageTitle } from "./PageTitle";

afterEach(cleanup);

/**
 * The active highlight and the header title must track the LIVE pathname.
 *
 * They used to be computed in the server layout from the request's
 * x-pathname header — but layouts do not re-render on client-side
 * navigation, so after clicking a sidebar link the content changed while
 * the highlight and title stayed frozen on whichever page was last
 * hard-loaded. The owner caught it: sidebar on المالية, content on المشتريات.
 */

let pathname = "/ar";
vi.mock("next/navigation", () => ({ usePathname: () => pathname }));

const items = [
  { key: "dashboard", href: "", label: "لوحة التحكم" },
  { key: "purchases", href: "purchases", label: "المشتريات" },
  { key: "finance", href: "finance", label: "المالية" },
];

const titles = {
  dashboard: "لوحة التحكم",
  purchases: "المشتريات",
  finance: "المالية",
};

describe("Sidebar", () => {
  it("highlights the item matching the current pathname", () => {
    pathname = "/ar/finance";
    render(<Sidebar locale="ar" appName="تجارة سمارت" items={items} />);

    expect(screen.getByText("المالية").getAttribute("aria-current")).toBe("page");
    expect(screen.getByText("المشتريات").getAttribute("aria-current")).toBeNull();
  });

  it("moves the highlight when the pathname changes, without a reload", () => {
    pathname = "/ar/finance";
    const { rerender } = render(<Sidebar locale="ar" appName="تجارة سمارت" items={items} />);

    pathname = "/ar/purchases";
    rerender(<Sidebar locale="ar" appName="تجارة سمارت" items={items} />);

    expect(screen.getByText("المشتريات").getAttribute("aria-current")).toBe("page");
    expect(screen.getByText("المالية").getAttribute("aria-current")).toBeNull();
  });

  it("falls back to the dashboard for the locale root", () => {
    pathname = "/ar";
    render(<Sidebar locale="ar" appName="تجارة سمارت" items={items} />);

    expect(screen.getByText("لوحة التحكم").getAttribute("aria-current")).toBe("page");
  });
});

describe("PageTitle", () => {
  it("shows the title of the section the pathname is inside", () => {
    pathname = "/ar/purchases/abc-123/receive";
    render(<PageTitle locale="ar" titles={titles} />);

    expect(screen.getByRole("heading").textContent).toBe("المشتريات");
  });

  it("tracks client-side navigation", () => {
    pathname = "/ar/finance";
    const { rerender } = render(<PageTitle locale="ar" titles={titles} />);
    expect(screen.getByRole("heading").textContent).toBe("المالية");

    pathname = "/ar/purchases";
    rerender(<PageTitle locale="ar" titles={titles} />);
    expect(screen.getByRole("heading").textContent).toBe("المشتريات");
  });
});
