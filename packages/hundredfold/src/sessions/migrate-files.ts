// The files table's own upgrade migration. It lives beside `migrate.ts` rather
// than inside it because that module is the sessions/messages schema and this is
// the attachment one; `shared/db.ts` sequences both.
import Database from 'better-sqlite3';

/**
 * Additive, nullable migration: record what shape an uploaded image is, so the
 * web client can reserve its box before the bytes arrive instead of growing into
 * it on decode. Safe to run repeatedly and on homes created before dimensions
 * were stored — those rows keep NULLs and fall back to a measured ratio.
 */
export function migrateFilesSchema(database: Database.Database): void {
  const cols = database.prepare('PRAGMA table_info(files)').all() as Array<{ name: string }>;
  const colNames = new Set(cols.map((c) => c.name));
  if (!colNames.has('width')) {
    database.exec('ALTER TABLE files ADD COLUMN width INTEGER');
  }
  if (!colNames.has('height')) {
    database.exec('ALTER TABLE files ADD COLUMN height INTEGER');
  }
}
