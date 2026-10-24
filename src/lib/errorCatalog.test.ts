import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";

/**
 * The mechanical guard for decisions.md #9: every code a service can throw
 * (`new ServiceError("CODE")` / `invalidState("CODE")`) must resolve to a
 * real, non-literal string in BOTH message catalogs. `getTranslator`
 * (src/lib/i18n.ts) returns the dictionary key itself when a lookup misses,
 * so a gap here doesn't crash anything — it silently renders as literal
 * text like "errors.SALES_ORDER_NOT_DRAFT" on screen.
 *
 * src/services, src/lib, AND src/app are scanned: `new ServiceError(...)`
 * is thrown directly from several src/app/**\/actions.ts files too (e.g.
 * products, purchases, sales, settings), not just from the service layer —
 * `action()`'s `catch (error) { if (error instanceof ServiceError) ... }`
 * branch (src/lib/action.ts) receives a code from any of the three trees
 * identically. A prior version of this guard scanned only services/lib,
 * which meant a throw site added directly in src/app could ship uncaught.
 */

const SCAN_DIRS = ["services", "lib", "app"].map((d) => path.resolve(process.cwd(), "src", d));
const CODE_PATTERN = /(?:new ServiceError|invalidState)\(\s*["'`]([A-Z_]+)["'`]/g;

function findSourceFiles(dir: string): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) {
      found.push(...findSourceFiles(full));
    } else if (entry.endsWith(".ts") && !entry.endsWith(".test.ts")) {
      found.push(full);
    }
  }
  return found;
}

function extractCodes(): Map<string, string[]> {
  // code -> files it's thrown from, for a legible failure message.
  const codes = new Map<string, string[]>();
  for (const dir of SCAN_DIRS) {
    for (const file of findSourceFiles(dir)) {
      const source = readFileSync(file, "utf8");
      const relative = path.relative(process.cwd(), file);
      let match;
      CODE_PATTERN.lastIndex = 0;
      while ((match = CODE_PATTERN.exec(source))) {
        const code = match[1];
        const files = codes.get(code) ?? [];
        if (!files.includes(relative)) files.push(relative);
        codes.set(code, files);
      }
    }
  }
  return codes;
}

describe("every thrown error code has a real message in both catalogs", () => {
  it("resolves to a non-literal string under `errors` in en.json and ar.json", async () => {
    const en = (await import("../../messages/en.json")).default as { errors: Record<string, unknown> };
    const ar = (await import("../../messages/ar.json")).default as { errors: Record<string, unknown> };

    const codes = extractCodes();
    expect(codes.size).toBeGreaterThan(0); // sanity: the scan itself must find something

    const violations: string[] = [];
    for (const [code, files] of codes) {
      for (const [label, dict] of [["en", en], ["ar", ar]] as const) {
        const value = dict.errors[code];
        if (typeof value !== "string" || value.length === 0 || value === code) {
          violations.push(
            `errors.${code} (thrown from ${files.join(", ")}) is missing or literal in messages/${label}.json`,
          );
        }
      }
    }

    expect(violations, violations.join("\n")).toEqual([]);
  });
});
