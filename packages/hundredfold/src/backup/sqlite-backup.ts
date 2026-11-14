import Database from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";
import { assertLocalDatabasePath } from "../shared/local-db-guard.js";

/**
 * Small enough that a source being written to still gets several chances to
 * interleave. SQLite restarts the copy whenever another connection writes, so
 * the run converges only once the writer pauses - which is the behaviour that
 * makes the result consistent rather than a torn file.
 */
const PAGES_PER_STEP = 10;

/**
 * Copies a SQLite database with the online backup API.
 *
 * `copyFileSync` cannot do this job: registry.db runs in WAL mode, so a live
 * database keeps committed rows - and, after a fresh migration, the schema
 * itself - in the -wal sidecar. Copying the main file alone yields a database
 * that opens but is missing everything the WAL still holds.
 *
 * Returns the byte size of the copy.
 */
export async function backupSqliteDatabase(
  source: string,
  destination: string,
  onStep?: () => void,
): Promise<number> {
  // The source is a live WAL database; opening it across a FUSE/network mount
  // corrupts it (shared/local-db-guard.ts).
  assertLocalDatabasePath(source);
  fs.mkdirSync(path.dirname(destination), { recursive: true, mode: 0o700 });
  const db = new Database(source);
  try {
    db.pragma("busy_timeout = 10000");
    await db.backup(destination, {
      progress: () => {
        onStep?.();
        return PAGES_PER_STEP;
      },
    });
  } finally {
    db.close();
  }
  // The archive beside this copy carries secrets/; the copy carries every
  // session the instance has ever held. Both are owner-only.
  try { fs.chmodSync(destination, 0o600); } catch { /* Windows has no POSIX modes */ }
  return fs.statSync(destination).size;
}
