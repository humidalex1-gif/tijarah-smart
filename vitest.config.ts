import { defineConfig, configDefaults } from "vitest/config";
import path from "path";

// Each `npx vitest run` invocation gets its own sqlite file, keyed by this
// process's pid, instead of every run sharing test.db. tests/global-setup.ts
// truncates its database at the start of every run — with a single shared
// file, two concurrent `vitest run` processes (e.g. two agents, or a human
// and CI) race on that truncate/write and corrupt each other's run
// (transaction timeouts, "no record was found", unique-constraint
// collisions — all observed in practice during Stage 1B).
//
// tests/global-setup.ts runs in this same main vitest process (verified
// empirically: both this module and that file observe an identical
// process.pid at runtime), so it can derive the identical file path on its
// own without any env/IPC coordination — see the comment there for why it
// does NOT read this back via process.env.DATABASE_URL.
const WORKER_DATABASE_URL = `file:./test.worker-${process.pid}.db`;

export default defineConfig({
  test: {
    globalSetup: "./tests/global-setup.ts",
    fileParallelism: false,
    // Agents run in git worktrees created UNDER the repo at .claude/worktrees.
    // Vitest's default exclude does not cover them, so a single worktree
    // doubled the suite — 164 files instead of 82 — and ran a second copy of
    // every test against this process's database with that branch's code.
    // 35 failures that said nothing about the working tree.
    exclude: [...configDefaults.exclude, "**/.claude/**"],
    // AUTH_SECRET is not otherwise present under test, and src/lib/crypto.ts
    // derives its key from it. Without this, every encrypt/decrypt throws
    // CRYPTO_UNREADABLE. A fixed value keeps ciphertext reproducible across
    // runs; it is a test fixture, never a real secret.
    env: {
      DATABASE_URL: WORKER_DATABASE_URL,
      AUTH_SECRET: "test-auth-secret-for-vitest",
    },
  },
  resolve: { alias: { "@": path.resolve(__dirname, "src") } },
});
