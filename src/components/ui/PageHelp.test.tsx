import { describe, it, expect } from "vitest";
import type { ReactElement } from "react";
import { PageHelp } from "@/components/ui/PageHelp";
import en from "../../../messages/en.json";
import ar from "../../../messages/ar.json";

/**
 * PageHelp takes no hooks and no async work, so it can be called directly and
 * its returned element tree walked — the same approach the server-component
 * page tests in this repo use.
 */
type Node = ReactElement<Record<string, unknown>> | string | number | null | undefined | Node[];

function walk(node: Node, visit: (el: ReactElement<Record<string, unknown>>) => void): void {
  if (node === null || node === undefined || typeof node === "string" || typeof node === "number") return;
  if (Array.isArray(node)) {
    for (const child of node) walk(child, visit);
    return;
  }
  visit(node);
  walk((node.props as { children?: Node }).children, visit);
}

function collect(tree: Node) {
  const tags: string[] = [];
  const text: string[] = [];
  walk(tree, (el) => {
    if (typeof el.type === "string") tags.push(el.type);
    const children = (el.props as { children?: unknown }).children;
    if (typeof children === "string") text.push(children);
  });
  return { tags, text };
}

function lookup(dict: Record<string, unknown>, key: string): string {
  const value = key.split(".").reduce<unknown>(
    (acc, part) => (acc as Record<string, unknown>)?.[part], dict,
  );
  if (typeof value !== "string") throw new Error(`missing key: ${key}`);
  return value;
}

const enT = (key: string) => lookup(en as Record<string, unknown>, key);
const arT = (key: string) => lookup(ar as Record<string, unknown>, key);

describe("PageHelp", () => {
  it("renders two native disclosure panels, not custom toggles", () => {
    // <details>/<summary> is what makes click-to-open and click-again-to-close
    // work with no JavaScript, on a server component, with keyboard and screen
    // reader support included. A div-with-onClick would need a client bundle
    // on all fifteen routes to reproduce it — badly.
    const { tags } = collect(PageHelp({ t: enT, pageKey: "products" }) as Node);

    expect(tags.filter((tag) => tag === "details")).toHaveLength(2);
    expect(tags.filter((tag) => tag === "summary")).toHaveLength(2);
  });

  it("shows both titles and both bodies for the page it is given", () => {
    const { text } = collect(PageHelp({ t: enT, pageKey: "reconcile" }) as Node);

    expect(text).toContain(enT("help.howToTitle"));
    expect(text).toContain(enT("help.howItWorksTitle"));
    expect(text).toContain(enT("help.reconcile.howTo"));
    expect(text).toContain(enT("help.reconcile.howItWorks"));
  });

  it("reads the page it is asked for, not a fixed one", () => {
    // Guards the pageKey actually being used. Without this the component could
    // hard-code one page's text and every test above would still pass.
    const { text } = collect(PageHelp({ t: enT, pageKey: "claims" }) as Node);

    expect(text).toContain(enT("help.claims.howTo"));
    expect(text).not.toContain(enT("help.reconcile.howTo"));
  });

  it("renders Arabic when given the Arabic translator", () => {
    const { text } = collect(PageHelp({ t: arT, pageKey: "adspend" }) as Node);

    expect(text).toContain(arT("help.adspend.howTo"));
    expect(text).toContain(arT("help.howToTitle"));
  });

  it("is closed by default so it never pushes the page down", () => {
    // A merchant who knows the screen should not scroll past instructions
    // every visit.
    let openCount = 0;
    walk(PageHelp({ t: enT, pageKey: "sales" }) as Node, (el) => {
      if (el.type === "details" && el.props.open) openCount += 1;
    });

    expect(openCount).toBe(0);
  });

  it("has help text for every page that renders it", () => {
    // The component throws on a missing key, so a page added later without
    // catalogue entries fails here rather than at runtime in front of a user.
    const pages = [
      "dashboard", "products", "inventory", "warehouses", "purchases",
      "suppliers", "sales", "customers", "expenses", "finance",
      "reconcile", "claims", "adspend", "profit", "settings",
    ];

    for (const page of pages) {
      expect(() => collect(PageHelp({ t: enT, pageKey: page }) as Node)).not.toThrow();
      expect(() => collect(PageHelp({ t: arT, pageKey: page }) as Node)).not.toThrow();
    }
  });
});
