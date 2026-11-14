/** What a Todo-data migration refuses with, and the signal that picks which
 *  refusal it is. Kept apart from the migration itself because these are the two
 *  sentences an operator actually reads when the gateway will not start, and
 *  they have to stay recognizable — `shared/db.ts` matches one of them by value
 *  to tell "this database is not ours to migrate" from "this file is broken". */

export const UNSUPPORTED_PRERELEASE_TODO_DATA =
  "Unsupported prerelease Todo data detected. This release cannot start or migrate it.\n" +
  "Use the separately reviewed offline converter, or restore a supported public-version backup.";

export const CORRUPT_SESSIONS_DATABASE =
  "The session database appears to be corrupt or is not a valid SQLite file — this is NOT a Todo-data\n" +
  "problem. If a registry.db-wal sits beside it, copy all three files (registry.db, -wal, -shm) aside\n" +
  "and try moving just the -wal away first: a stale WAL can make an intact file read as corrupt, and a\n" +
  "restore would lose everything since the backup. Otherwise restore it from a backup (check the\n" +
  "'backups/' folder next to registry.db, or your most recent copy) and restart.";

/** SQLite surfaces file corruption via these substrings. */
export function isSqliteCorruption(message: string): boolean {
  return /malformed|file is not a database|not a database|disk image is malformed|database is locked.*corrupt|SQLITE_CORRUPT|SQLITE_NOTADB/i.test(
    message,
  );
}
