#!/usr/bin/env node
"use strict";

/**
 * The nightly database backup.
 *
 * Plain CommonJS on purpose: no tsx, no path aliases, no build step. A backup
 * job that depends on the app's toolchain stops working on exactly the day the
 * toolchain is what broke.
 *
 * It uses SQLite's ONLINE backup API rather than `cp`. Copying a live database
 * file can capture a torn page mid-write and produce an archive that only
 * fails when someone finally needs it; the backup API takes a consistent
 * snapshot while the app keeps writing.
 *
 * And it VERIFIES what it wrote — `integrity_check` plus a real row count —
 * before pruning anything. An unverified backup is a belief, not a backup.
 */

const fs = require("node:fs");
const path = require("node:path");
const Database = require("better-sqlite3");

const SOURCE = process.env.TIJARAH_DB || "/opt/tijarah/data/app.db";
const DEST_DIR = process.env.TIJARAH_BACKUP_DIR || "/opt/tijarah/backups";
const UPLOAD_DIR = process.env.UPLOAD_DIR || "/opt/tijarah/data/uploads";
/** Nightly, so this is two weeks of history. */
const KEEP = Number(process.env.TIJARAH_BACKUP_KEEP || 14);

async function main() {
  if (!fs.existsSync(SOURCE)) throw new Error(`No database at ${SOURCE}`);
  fs.mkdirSync(DEST_DIR, { recursive: true });

  const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const dest = path.join(DEST_DIR, `app-${stamp}.db`);

  const source = new Database(SOURCE, { readonly: true });
  await source.backup(dest);
  source.close();

  // Verify the ARCHIVE, not the original. Reading tables that must never be
  // empty catches a snapshot that is structurally valid but useless.
  const copy = new Database(dest, { readonly: true });
  let integrity;
  let products = 0;
  let movements = 0;
  try {
    integrity = copy.pragma("integrity_check", { simple: true });
    products = copy.prepare("SELECT COUNT(*) n FROM Product").get().n;
    movements = copy.prepare("SELECT COUNT(*) n FROM InventoryMovement").get().n;
  } finally {
    copy.close();
  }

  if (integrity !== "ok" || products === 0) {
    // Deleted rather than kept: a bad archive left in the directory would be
    // counted as a good one on the day it matters, and would push a good one
    // out during pruning.
    fs.unlinkSync(dest);
    throw new Error(`Backup rejected: integrity=${integrity}, products=${products}`);
  }

  const size = fs.statSync(dest).size;
  console.log(`Backup OK: ${dest} (${size} bytes, ${products} products, ${movements} movements)`);

  // Uploaded invoices and receipts live on disk, not in the database, so the
  // snapshot above does not contain them. A backup that restores the books
  // but loses their source documents is only most of a backup.
  copyUploads(path.join(DEST_DIR, `uploads-${stamp}`));

  // Prune only after a verified success, so a run of failures can never empty
  // the directory of the good copies it failed to replace.
  const archives = fs.readdirSync(DEST_DIR)
    .filter((name) => /^app-.*\.db$/.test(name))
    .sort()
    .reverse();
  for (const stale of archives.slice(KEEP)) {
    fs.unlinkSync(path.join(DEST_DIR, stale));
    console.log(`Pruned ${stale}`);
  }
  const uploadCopies = fs.readdirSync(DEST_DIR)
    .filter((name) => /^uploads-/.test(name))
    .sort()
    .reverse();
  for (const stale of uploadCopies.slice(KEEP)) {
    fs.rmSync(path.join(DEST_DIR, stale), { recursive: true, force: true });
    console.log(`Pruned ${stale}`);
  }
  console.log(`Kept ${Math.min(archives.length, KEEP)} of ${archives.length} archives.`);
}

/**
 * Copies the uploads tree beside the database snapshot.
 *
 * Deliberately not fatal: the database is the irreplaceable part, and a
 * permissions problem on a scanned receipt must not throw away a good
 * database backup. It is reported instead, loudly enough to notice.
 */
function copyUploads(dest) {
  if (!fs.existsSync(UPLOAD_DIR)) {
    console.log("No uploads directory yet — nothing to copy.");
    return;
  }
  try {
    fs.cpSync(UPLOAD_DIR, dest, { recursive: true });
    const files = fs.readdirSync(dest).length;
    console.log(`Uploads OK: ${dest} (${files} files)`);
  } catch (error) {
    console.error(`WARNING: uploads not copied (${error.message}). The database backup stands.`);
  }
}

main().catch((error) => {
  console.error(error.message || error);
  process.exit(1);
});
