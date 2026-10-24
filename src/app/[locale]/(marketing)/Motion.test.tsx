/** @vitest-environment jsdom */
import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import { ScrollProgress, Parallax, SplitBar, Tilt } from "./Motion";

/**
 * The front door's motion, and the one promise it must keep: a visitor who
 * has asked for less motion gets NONE of it — not a shorter version.
 *
 * The other half is that nothing here is load-bearing. Every animated element
 * is decoration or an arrival effect, so a page with JavaScript off is
 * complete. These tests hold both, because both are invisible when broken:
 * motion that ignores the preference looks fine to whoever wrote it.
 */

let reduced = false;
let finePointer = true;

beforeEach(() => {
  reduced = false;
  finePointer = true;
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    value: (q: string) => ({
      matches: q.includes("prefers-reduced-motion: reduce")
        ? reduced
        : q.includes("hover") ? finePointer : false,
      media: q, onchange: null,
      addEventListener: () => {}, removeEventListener: () => {},
      addListener: () => {}, removeListener: () => {}, dispatchEvent: () => false,
    }),
  });
});
afterEach(cleanup);

describe("ScrollProgress", () => {
  it("does not listen to the page at all under reduced motion", () => {
    reduced = true;
    const add = vi.spyOn(window, "addEventListener");
    render(<ScrollProgress />);
    // Not a slower bar — no scroll handler whatsoever.
    expect(add.mock.calls.filter(([e]) => e === "scroll")).toHaveLength(0);
    add.mockRestore();
  });

  it("tracks the scroll otherwise", () => {
    const add = vi.spyOn(window, "addEventListener");
    render(<ScrollProgress />);
    expect(add.mock.calls.filter(([e]) => e === "scroll").length).toBeGreaterThan(0);
    add.mockRestore();
  });

  it("removes its listeners when it goes, rather than leaking one per visit", () => {
    const remove = vi.spyOn(window, "removeEventListener");
    const { unmount } = render(<ScrollProgress />);
    unmount();
    expect(remove.mock.calls.filter(([e]) => e === "scroll").length).toBeGreaterThan(0);
    remove.mockRestore();
  });
});

describe("Parallax", () => {
  it("leaves its children exactly where they are under reduced motion", () => {
    reduced = true;
    const { container } = render(<Parallax><span>aura</span></Parallax>);
    expect((container.firstElementChild as HTMLElement).style.transform).toBe("");
  });

  it("is hidden from assistive technology, being decoration", () => {
    const { container } = render(<Parallax><span>aura</span></Parallax>);
    // It moves against the scroll; announcing it would describe nothing.
    expect(container.firstElementChild!.getAttribute("aria-hidden")).toBe("true");
  });
});

describe("SplitBar", () => {
  const parts = [
    { value: 10, label: "still claimed", tone: "claim" as const },
    { value: 3, label: "unexplained", tone: "loss" as const },
  ];

  it("draws the two causes filling the whole bar", () => {
    const { container } = render(<SplitBar parts={parts} />);
    const pieces = [...container.querySelectorAll(".tj-split-part")] as HTMLElement[];

    expect(pieces).toHaveLength(2);
    const total = pieces.reduce((sum, el) => sum + parseFloat(el.style.width), 0);
    // A bar whose pieces do not fill it contradicts the sentence beside it.
    expect(Math.round(total)).toBe(100);
  });

  it("gives the loss its own tone, the one warm colour on the page", () => {
    const { container } = render(<SplitBar parts={parts} />);
    expect(container.querySelector(".tj-split-loss")).not.toBeNull();
    expect(container.querySelector(".tj-split-claim")).not.toBeNull();
  });

  it("draws nothing when there is no gap to explain", () => {
    const { container } = render(
      <SplitBar parts={[{ value: 0, label: "none", tone: "claim" }]} />,
    );
    expect(container.querySelectorAll(".tj-split-part")).toHaveLength(0);
  });

  it("renders already split, so the picture is complete without JavaScript", () => {
    const { container } = render(<SplitBar parts={parts} />);
    // The server's markup is the finished state; the client only animates
    // toward what is already there.
    expect(container.firstElementChild!.className).toContain("is-split");
  });
});

describe("Tilt", () => {
  it("renders its children whether or not the pointer can tilt", () => {
    finePointer = false;
    render(<Tilt><span>card</span></Tilt>);
    expect(screen.getByText("card")).not.toBeNull();
  });

  it("leaves no transform behind on a touch screen", () => {
    finePointer = false;
    const { container } = render(<Tilt><span>card</span></Tilt>);
    expect((container.firstElementChild as HTMLElement).style.transform).toBe("");
  });
});
