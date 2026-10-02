/**
 * The layout of a remote session's staged `$JINN_HOME` (FARM_SCRIPT in
 * engines/remote-stage.ts), shared with the code that has to agree with it.
 *
 * The farm is a symlink farm over the sshfs mount of the gateway's home, so a
 * remote session reads and writes the org's real files. The gateway's SQLite
 * databases are the exception: they run in WAL mode, which needs a shared-memory
 * index and POSIX locks that every process can see, and a lock taken on another
 * host through sshfs is invisible to the gateway. A remote open of the live
 * registry, even a read-only one, truncates and rebuilds the gateway's wal-index
 * and corrupts the database. So the directories that hold databases are staged
 * as real directories whose entries are linked one by one, minus the database
 * files, and each database the gateway has is a DIRECTORY in the stage so that
 * a stray open fails instead of quietly creating an empty local database.
 */

/** Top-level entries staged as real host-local directories, not links. */
export const FARM_REAL_ENTRIES = ["gateway.json", "tmp"] as const;

/** Top-level directories staged as real directories whose children are linked
 *  one by one, minus {@link isFarmExcludedChild} entries. `workflows/` only
 *  exists on homes upgraded from a release that still had Workflows. */
export const FARM_FILTERED_DIRS = ["sessions", "workflows"] as const;

/** A real file FARM_SCRIPT writes into every staged home. Its presence is how
 *  Marid code knows the home it was handed is a remote session's stage, whose
 *  linked entries lead to the gateway's live data. */
export const REMOTE_STAGE_MARKER = ".jinn-remote-stage";

/** SQLite database files and their sidecars. Keep in step with the `case`
 *  patterns in FARM_SCRIPT. */
const DATABASE_FILE = /\.db(?:-wal|-shm|-journal)?$/;

/** A child of a {@link FARM_FILTERED_DIRS} directory that the farm does not
 *  link: a database file or sidecar, or `backups/` (database snapshots). */
export function isFarmExcludedChild(name: string): boolean {
  return name === "backups" || DATABASE_FILE.test(name);
}

/** Whether `relSegments` (a path relative to the gateway home, split into
 *  segments) is reachable through the farm at the same relative path. */
export function isLinkedInFarm(relSegments: readonly string[]): boolean {
  const [top, child] = relSegments;
  if (!top) return false;
  if ((FARM_REAL_ENTRIES as readonly string[]).includes(top) || top === REMOTE_STAGE_MARKER) return false;
  if ((FARM_FILTERED_DIRS as readonly string[]).includes(top)) {
    return child !== undefined && !isFarmExcludedChild(child);
  }
  return true;
}
