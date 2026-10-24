import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";

/**
 * `action()` (src/lib/action.ts) copies EVERY Zod issue's `message` verbatim
 * into `state.fields[path]` on a VALIDATION failure — not just the ones from
 * a hand-written `ctx.addIssue({ message: "..." })` inside a `superRefine`.
 * The identical path is hit by:
 *
 *   1. `ctx.addIssue({ message: "..." })` — the original hole this guard
 *      covered.
 *   2. A validator's own second argument, e.g. `z.string().min(1, "...")`
 *      or `.max(200, { message: "..." })` — this codebase already uses this
 *      form for real messages (expenses/sales/purchases/inventory actions).
 *   3. A validator called with NO message at all, e.g. `z.string().min(2)`
 *      or `.email()` — Zod's own built-in English falls through instead,
 *      e.g. "Too small: expected string to have >=2 characters". This is
 *      the live mechanism behind an Arabic merchant seeing raw English on a
 *      form field; it never touches either message catalog, so
 *      errorCatalog.test.ts / i18n parity tests cannot see it.
 *
 * Every form that reads `state.fields` (ProductForm.tsx, etc.) renders
 * whatever string lands here as-is next to the input, so in all three cases
 * the value MUST be a bare "errors.SOME_CODE" dictionary key — resolved
 * through the form's own `labels.errors` map, same as every action-level
 * error code already is — never a literal sentence, hand-authored or
 * Zod-generated.
 *
 * Scope: every non-test .ts/.tsx file under src/app, src/lib, and
 * src/components — not just files literally named `actions.ts`. A server
 * action can live anywhere in those trees (e.g.
 * src/components/shell/signOutAction.ts), and `addIssue`/schema
 * construction is not confined to src/app either.
 *
 * A genuinely non-user-facing message (e.g. an internal invariant that can
 * never actually surface to a form) may opt out with an inline
 * `// i18n-exempt` comment near the call, rather than by weakening this
 * check.
 *
 * Ownership split (docs/decisions.md's stage-1b review split test-infra
 * work from src/app i18n/UX work across two concurrent agents): the schemas
 * that can actually reach `action()` all live under
 * src/app/[locale]/(app)/**, plus the standalone `(auth)` login/register
 * forms and the onboarding form — all squarely inside "src/app/** pages and
 * forms" territory. This guard still SCANS all of it (so it fails loudly on
 * a NEW violation anywhere), but only ASSERTS zero violations for
 * src/lib and src/components, which this branch owns. Violations under
 * src/app are collected and printed (and enumerated in
 * .superpowers/sdd/1b-final-testinfra-fix.md) as a follow-up for whoever
 * owns src/app's forms next, instead of being edited here.
 */

const SCAN_ROOTS = ["app", "lib", "components"].map((d) => path.resolve(process.cwd(), "src", d));
const OWNED_ROOTS = ["lib", "components"].map((d) => path.resolve(process.cwd(), "src", d));

function findSourceFiles(dir: string): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) {
      found.push(...findSourceFiles(full));
    } else if (
      (entry.endsWith(".ts") || entry.endsWith(".tsx"))
      && !entry.endsWith(".test.ts")
      && !entry.endsWith(".test.tsx")
    ) {
      found.push(full);
    }
  }
  return found;
}

const ALL_FILES = SCAN_ROOTS.flatMap(findSourceFiles);

function isOwnedFile(file: string): boolean {
  return OWNED_ROOTS.some((root) => file.startsWith(root + path.sep));
}

const DICTIONARY_KEY = /^errors\.[A-Za-z0-9_.]+$/;
const EXEMPT_MARKER = "i18n-exempt";
const EXEMPT_WINDOW = 200;

function isExempt(source: string, index: number): boolean {
  return source.slice(Math.max(0, index - EXEMPT_WINDOW), index).includes(EXEMPT_MARKER);
}

/** Blanks out `//` and `/* *\/` comments (preserving offsets/newlines) so
 * commented-out example code can't be mistaken for a real call site. */
function stripComments(source: string): string {
  let out = "";
  let i = 0;
  while (i < source.length) {
    const ch = source[i];
    const two = source.slice(i, i + 2);
    if (ch === "'" || ch === '"' || ch === "`") {
      const quote = ch;
      let j = i + 1;
      out += ch;
      while (j < source.length) {
        const c = source[j];
        out += c;
        if (c === "\\") { j++; if (j < source.length) out += source[j]; j++; continue; }
        if (c === quote) { j++; break; }
        j++;
      }
      i = j;
      continue;
    }
    if (two === "//") {
      let j = i;
      while (j < source.length && source[j] !== "\n") { out += " "; j++; }
      i = j;
      continue;
    }
    if (two === "/*") {
      let j = i;
      while (j < source.length && source.slice(j, j + 2) !== "*/") {
        out += source[j] === "\n" ? "\n" : " ";
        j++;
      }
      out += "  ";
      i = j + 2;
      continue;
    }
    out += ch;
    i++;
  }
  return out;
}

/**
 * Pulls the `message: "..."` string out of every `ctx.addIssue({ ... })`
 * call in `source`, by brace-counting from the call's opening `{` to its
 * matching `}` (a plain regex can't do this safely — the object can contain
 * its own nested braces/brackets, e.g. `path: ["purchasePrice"]`).
 */
function extractAddIssueMessages(source: string): Array<{ message: string; index: number }> {
  const results: Array<{ message: string; index: number }> = [];
  const callRe = /addIssue\s*\(\s*\{/g;
  let call = callRe.exec(source);
  while (call) {
    const braceStart = source.indexOf("{", call.index);
    let depth = 0;
    let end = braceStart;
    for (; end < source.length; end++) {
      if (source[end] === "{") depth++;
      else if (source[end] === "}") {
        depth--;
        if (depth === 0) break;
      }
    }
    const block = source.slice(braceStart, end + 1);
    const messageMatch = block.match(/message:\s*(["'`])((?:(?!\1)[\s\S])*)\1/);
    if (messageMatch) results.push({ message: messageMatch[2], index: call.index });
    call = callRe.exec(source);
  }
  return results;
}

/** Reads a balanced `(...)` starting at `openIdx` (source[openIdx] === "("),
 * skipping over string/template literals and regex literals so their
 * internal punctuation never desyncs the depth count. Returns the content
 * between the parens (exclusive) and the index just past the closing ")". */
function readBalancedParens(source: string, openIdx: number): { content: string; endIdx: number } {
  let i = openIdx + 1;
  let depth = 1;
  let content = "";
  while (i < source.length && depth > 0) {
    const ch = source[i];
    if (ch === "'" || ch === '"' || ch === "`") {
      const quote = ch;
      let j = i + 1;
      let buf = ch;
      while (j < source.length) {
        const c = source[j];
        buf += c;
        if (c === "\\") { j++; if (j < source.length) buf += source[j]; j++; continue; }
        if (c === quote) { j++; break; }
        j++;
      }
      content += buf;
      i = j;
      continue;
    }
    // Heuristic regex-literal start: a "/" whose preceding character opens
    // an argument (so it can't be division), e.g. `.regex(/^[A-Z]{3}$/i)`.
    if (ch === "/" && /[\s(,[{]/.test(source[i - 1] ?? " ")) {
      let j = i + 1;
      let inClass = false;
      let buf = "/";
      while (j < source.length) {
        const c = source[j];
        buf += c;
        if (c === "\\") { j++; if (j < source.length) buf += source[j]; j++; continue; }
        if (c === "[") inClass = true;
        if (c === "]") inClass = false;
        if (c === "/" && !inClass) { j++; break; }
        j++;
      }
      while (j < source.length && /[a-z]/i.test(source[j])) { buf += source[j]; j++; }
      content += buf;
      i = j;
      continue;
    }
    if (ch === "(" || ch === "[" || ch === "{") { depth++; content += ch; i++; continue; }
    if (ch === ")" || ch === "]" || ch === "}") {
      depth--;
      if (depth === 0) { i++; break; }
      content += ch; i++; continue;
    }
    content += ch;
    i++;
  }
  return { content, endIdx: i };
}

/** Splits a balanced-parens body into its top-level (depth-0) comma
 * separated arguments, ignoring commas inside nested brackets or strings. */
function splitTopLevelArgs(content: string): string[] {
  const args: string[] = [];
  let depth = 0;
  let current = "";
  let i = 0;
  while (i < content.length) {
    const ch = content[i];
    if (ch === "'" || ch === '"' || ch === "`") {
      const quote = ch;
      let buf = ch;
      let j = i + 1;
      while (j < content.length) {
        const c = content[j];
        buf += c;
        if (c === "\\") { j++; if (j < content.length) buf += content[j]; j++; continue; }
        if (c === quote) { j++; break; }
        j++;
      }
      current += buf;
      i = j;
      continue;
    }
    if (ch === "(" || ch === "[" || ch === "{") { depth++; current += ch; i++; continue; }
    if (ch === ")" || ch === "]" || ch === "}") { depth--; current += ch; i++; continue; }
    if (ch === "," && depth === 0) { args.push(current); current = ""; i++; continue; }
    current += ch;
    i++;
  }
  if (current.trim() !== "") args.push(current);
  return args.map((a) => a.trim()).filter((a) => a.length > 0);
}

// Zod validator methods whose N-th argument is an optional custom message;
// the number is the arg COUNT at which a message is present (i.e. calling
// with fewer args than this falls through to Zod's built-in English).
const TRACKED_METHODS: Record<string, number> = {
  min: 2, max: 2, length: 2, gte: 2, lte: 2, regex: 2,
  positive: 1, nonnegative: 1, nonpositive: 1, negative: 1,
  int: 1, email: 1, uuid: 1, nonempty: 1, url: 1,
};
const CALL_RE = new RegExp(`\\.(${Object.keys(TRACKED_METHODS).join("|")})\\(`, "g");

interface ValidatorViolation { file: string; line: number; index: number; detail: string; kind: "missing-message" | "literal-message" }

function findValidatorViolations(file: string, rawSource: string): ValidatorViolation[] {
  if (!/from\s+["']zod["']/.test(rawSource)) return [];
  const source = stripComments(rawSource);
  const violations: ValidatorViolation[] = [];
  CALL_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = CALL_RE.exec(source))) {
    const method = m[1];
    const openIdx = m.index + m[0].length - 1;
    const { content, endIdx } = readBalancedParens(source, openIdx);
    const args = splitTopLevelArgs(content);
    const threshold = TRACKED_METHODS[method];
    const line = source.slice(0, m.index).split("\n").length;

    if (args.length < threshold) {
      violations.push({
        file, line, index: m.index, kind: "missing-message",
        detail: `.${method}(${args.join(", ")}) has no message — falls through to Zod's built-in English`,
      });
    } else {
      const lastArg = args[args.length - 1];
      const stringLiteral = lastArg.match(/^(["'`])((?:(?!\1)[\s\S])*)\1$/);
      if (stringLiteral) {
        if (!DICTIONARY_KEY.test(stringLiteral[2])) {
          violations.push({
            file, line, index: m.index, kind: "literal-message",
            detail: `.${method}(...) message ${JSON.stringify(stringLiteral[2])} is not an "errors.*" key`,
          });
        }
      } else if (/^\{/.test(lastArg)) {
        const objMessage = lastArg.match(/(?:message|error)\s*:\s*(["'`])((?:(?!\1)[\s\S])*)\1/);
        if (objMessage && !DICTIONARY_KEY.test(objMessage[2])) {
          violations.push({
            file, line, index: m.index, kind: "literal-message",
            detail: `.${method}(...) object message ${JSON.stringify(objMessage[2])} is not an "errors.*" key`,
          });
        }
      }
      // A function-valued `error`/message config (e.g. `error: () => "..."`)
      // is left unclassified rather than guessed at — none exist today.
    }
    CALL_RE.lastIndex = endIdx;
  }
  return violations;
}

describe("server action issue messages stay out of the UI as dictionary keys", () => {
  it("scans a non-empty set of files (guard against a broken/empty scan passing vacuously)", () => {
    expect(ALL_FILES.length).toBeGreaterThan(0);
  });

  // Asserted across ALL of SCAN_ROOTS, deliberately — unlike the validator
  // check below, this one is NOT scoped to OWNED_ROOTS. Two reasons. It was
  // already green everywhere when it was written, so scoping it buys nothing
  // and costs the enforcement. And OWNED_ROOTS (src/lib, src/components)
  // contains zero addIssue call sites — all four live ones are under src/app
  // — so an OWNED_ROOTS-scoped version of this test asserts over the empty
  // set and passes no matter what anyone writes.
  it("never lets a hand-authored English sentence reach a form field via ctx.addIssue", () => {
    const violations: string[] = [];
    for (const file of ALL_FILES) {
      const source = readFileSync(file, "utf8");
      for (const { message, index } of extractAddIssueMessages(source)) {
        if (DICTIONARY_KEY.test(message)) continue;
        if (isExempt(source, index)) continue;
        violations.push(
          `${path.relative(process.cwd(), file)}: addIssue message ${JSON.stringify(message)} `
          + 'is not an "errors.*" dictionary key',
        );
      }
    }
    expect(violations, violations.join("\n")).toEqual([]);
  });

  it("scans files that actually contain addIssue calls (guard against the check above going vacuous)", () => {
    const withAddIssue = ALL_FILES.filter((file) => extractAddIssueMessages(readFileSync(file, "utf8")).length > 0);
    expect(withAddIssue.length).toBeGreaterThan(0);
  });

  it("never lets a Zod validator's message fall through to a literal English sentence or Zod's built-in default", () => {
    const violations: string[] = [];
    const reportOnly: string[] = [];
    for (const file of ALL_FILES) {
      const rawSource = readFileSync(file, "utf8");
      for (const v of findValidatorViolations(file, rawSource)) {
        if (isExempt(rawSource, v.index)) continue;
        const line = `${path.relative(process.cwd(), file)}:${v.line} [${v.kind}] ${v.detail}`;
        (isOwnedFile(file) ? violations : reportOnly).push(line);
      }
    }
    if (reportOnly.length > 0) {
      console.warn(`Zod validator message violations outside src/lib and src/components: ${reportOnly.length} (see .superpowers/sdd/1b-final-testinfra-fix.md)`);
    }
    expect(violations, violations.join("\n")).toEqual([]);
  });
});
