import { PrismaClient } from "@prisma/client";
import { PrismaBetterSqlite3 } from "@prisma/adapter-better-sqlite3";
import fs from "node:fs";

// The already-provisioned template: a human runs `npm run db:push` against
// this file (docs/decisions.md #4 — agents never run schema-mutating Prisma
// commands). Every worker database starts life as a byte-for-byte copy of
// it — a file copy is not a Prisma command, so this stays inside the rule.
const TEMPLATE_DATABASE_FILE = "./test.db";

// Matches the path vitest.config.ts computes for `test.env.DATABASE_URL`
// (WORKER_DATABASE_URL there). This file is NOT read from
// process.env.DATABASE_URL here because vitest does not forward `test.env`
// into the globalSetup execution context (verified empirically — it only
// reaches the worker processes that actually run test files). globalSetup
// does, however, run in the same main vitest process as vitest.config.ts
// itself (also verified empirically: identical process.pid observed in
// both), so recomputing the path from process.pid here reliably lands on
// the exact same file the config handed to the workers.
const WORKER_DATABASE_FILE = `./test.worker-${process.pid}.db`;

/**
 * `required: true` for the pre-copy removal, where a surviving file is a
 * correctness problem — the caller is about to copyFileSync over this exact
 * path, and a swallowed lock resurfaces two lines later as a raw errno with
 * no hint that a lock caused it.
 *
 * `required: false` for teardown, where it is not. The process is exiting,
 * the file is scratch, and on Windows SQLite's handle is routinely still
 * closing when teardown runs — so EBUSY here is expected, not a fault.
 * Throwing printed an alarming "error during close" on every single-file DB
 * run while the suite itself passed. The leftover is collected by
 * sweepAbandonedWorkerDatabases() on the next run, which is what that sweep
 * is for.
 */
function removeSqliteFile(file: string, { required = true }: { required?: boolean } = {}) {
  for (const suffix of ["", "-journal", "-wal", "-shm"]) {
    try {
      fs.unlinkSync(file + suffix);
    } catch (err) {
      // ENOENT is the normal case — already gone, or never existed.
      if ((err as NodeJS.ErrnoException).code === "ENOENT") continue;
      if (!required) continue;
      throw new Error(
        `Could not remove ${file + suffix} (${(err as NodeJS.ErrnoException).code}). `
        + "Another process is probably still holding it open — close any running "
        + "vitest watcher or database browser and try again.",
        { cause: err },
      );
    }
  }
}

/**
 * Delete worker databases abandoned by runs that were killed before their
 * teardown could fire. They are gitignored, so they accumulate invisibly.
 *
 * Only files whose owning process is actually GONE are removed. "Any pid but
 * mine is dead" would be wrong: a `npm run test:watch` in another terminal is
 * a live, concurrent vitest invocation with its own worker file, and deleting
 * it mid-run would corrupt that run. `process.kill(pid, 0)` sends no signal —
 * it just probes liveness, throwing ESRCH when nothing owns that pid.
 *
 * A recycled pid now belonging to some unrelated live process means we skip a
 * file that is genuinely stale. That is the safe direction to err: this sweep
 * is hygiene only. Correctness — never running against a stale schema — is
 * already guaranteed by the unconditional removal of THIS run's file below.
 */
function sweepAbandonedWorkerDatabases() {
  let entries: string[];
  try {
    entries = fs.readdirSync(".");
  } catch {
    return; // Not fatal: the sweep is cleanup, never a precondition.
  }
  for (const entry of entries) {
    const match = /^test\.worker-(\d+)\.db$/.exec(entry);
    if (!match) continue;
    const pid = Number(match[1]);
    if (pid === process.pid) continue;
    try {
      process.kill(pid, 0);
      continue; // Still running — someone else's live worker file.
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ESRCH") continue; // EPERM: alive, not ours.
    }
    try {
      removeSqliteFile(`./${entry}`);
    } catch {
      // A locked leftover is not this run's problem — it does not share our
      // path, so it cannot poison us. Leave it.
    }
  }
}

const MISSING_SCHEMA_WARNING =
  "\n" +
  "  test.db has no tables — the Prisma schema has not been pushed yet.\n" +
  "  Database-backed tests will fail until a human runs, from the project root:\n" +
  "\n" +
  "    npm run db:push\n" +
  "    PowerShell:  $env:DATABASE_URL=\"file:./test.db\"; npx prisma db push\n" +
  "    bash:        DATABASE_URL=\"file:./test.db\" npx prisma db push\n" +
  "\n" +
  "  (the first provisions dev.db, the second test.db. Schema provisioning\n" +
  "   is a deliberate human step — agents must not run it.)\n" +
  "\n" +
  "  Note: better-sqlite3 does not use Prisma's `fileMustExist` option here,\n" +
  "  so a missing/empty worker file is NOT an error at open time — it is\n" +
  "  silently created empty. A database-backed test then fails later with a\n" +
  "  plain \"no such table\" error, not a clear \"no file to open\" one.\n";

// Schema provisioning (`prisma db push`) is a deliberate, human-run step —
// see prisma.config.ts and docs/decisions.md. This suite never mutates the
// schema itself; it only verifies the schema is present, gives this run its
// own private copy of it, and resets DATA in that copy between test runs.
export default async function globalSetup() {
  // Always start this run's worker file from a fresh copy of the template,
  // never reuse whatever is already on disk. Windows recycles PIDs freely,
  // so a worker file leaked by an earlier run that was killed (Ctrl-C, OOM,
  // crash — the teardown below never ran) can still be sitting at this
  // exact path. Without this unconditional removal, a later run that draws
  // the same PID would take an `existsSync` shortcut, skip the copy
  // entirely, and silently run every test against that stale file's schema
  // — the `tables.length === 0` check below only catches an EMPTY stale
  // file, not a populated-but-outdated one.
  removeSqliteFile(WORKER_DATABASE_FILE);

  // Separate concern from the line above: that one protects THIS run from a
  // stale file at its own path; this one clears files left behind at OTHER
  // pids' paths, which nothing else ever deletes.
  sweepAbandonedWorkerDatabases();

  if (!fs.existsSync(TEMPLATE_DATABASE_FILE)) {
    // Warn loudly but do not abort: tests that never touch the database
    // (money, costing) are still perfectly runnable, and failing the whole
    // suite over a missing schema would block them for no reason.
    console.warn(MISSING_SCHEMA_WARNING);
    // No worker file was created on this path, so there is nothing for a
    // teardown to remove — returning undefined (no teardown) is correct
    // here, unlike the `tables.length === 0` branch below.
    return;
  }
  fs.copyFileSync(TEMPLATE_DATABASE_FILE, WORKER_DATABASE_FILE);

  const adapter = new PrismaBetterSqlite3({ url: `file:${WORKER_DATABASE_FILE}` });
  const db = new PrismaClient({ adapter });

  try {
    const tables = await db.$queryRawUnsafe<{ name: string }[]>(
      `SELECT name FROM sqlite_master
       WHERE type = 'table'
         AND name NOT LIKE 'sqlite_%'
         AND name != '_prisma_migrations'`,
    );

    if (tables.length === 0) {
      console.warn(MISSING_SCHEMA_WARNING);
      // A worker file WAS just created (copied from the template above),
      // so — unlike the missing-template branch — it must still be cleaned
      // up, or every schema-less run leaks another empty worker file. The
      // `finally` below still runs $disconnect() before this return
      // actually resolves.
      return () => removeSqliteFile(WORKER_DATABASE_FILE, { required: false });
    }

    // Reset data only, in FK-safe order by simply turning FK checks off —
    // the table list is derived from sqlite_master above so this never
    // drifts as models are added in later tasks.
    await db.$executeRawUnsafe("PRAGMA foreign_keys = OFF");
    for (const { name } of tables) {
      await db.$executeRawUnsafe(`DELETE FROM "${name}"`);
    }
    await db.$executeRawUnsafe("PRAGMA foreign_keys = ON");
  } finally {
    await db.$disconnect();
  }

  // Teardown: this run's private database file is scratch space, not
  // something to keep — remove it so concurrent/repeated runs don't
  // accumulate a test.worker-<pid>.db per invocation.
  return () => removeSqliteFile(WORKER_DATABASE_FILE, { required: false });
}
