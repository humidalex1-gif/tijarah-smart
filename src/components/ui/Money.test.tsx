/** @vitest-environment jsdom */
import { describe, it, expect, afterEach } from "vitest";
import { render, cleanup } from "@testing-library/react";
import { Money } from "./Money";

afterEach(cleanup);

/**
 * `tone="auto"` paints both directions — green above zero, red below — which
 * is right for a cash balance and wrong for a nine-column profit grid, where
 * nearly every cell is positive and a green table says nothing. `loss` paints
 * only the direction that needs noticing: a product that loses money, whose
 * only other signal is a minus sign that, in Arabic-Indic digits under RTL,
 * is the easiest character on the page to miss.
 */
describe("Money tone=loss", () => {
  it("marks a negative figure as a loss", () => {
    const { container } = render(<Money minor={-12_500} locale="ar" currency="SAR" tone="loss" />);
    const cell = container.firstElementChild as HTMLElement;
    expect(cell.className).toContain("text-danger");
  });

  it("leaves a positive figure in plain ink, not green", () => {
    const { container } = render(<Money minor={12_500} locale="ar" currency="SAR" tone="loss" />);
    const cell = container.firstElementChild as HTMLElement;
    expect(cell.className).not.toContain("text-success");
    expect(cell.className).not.toContain("text-danger");
  });
});
