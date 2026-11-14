// Row model and queries for the files table — uploaded attachments and the
// managed files an agent writes. Split out of `registry.ts`, which owns the
// sessions and messages side of the same database.
import { initDb } from '../shared/db.js';

export interface FileMeta {
  id: string;
  filename: string;
  size: number;
  mimetype: string | null;
  path: string | null;
  /** Displayed pixel size, present only for images that could be measured. */
  width?: number;
  height?: number;
  createdAt: string;
}

/**
 * Absent, not null. The column is nullable because a non-image and an unreadable
 * image have no size to store, but a descriptor that carries `width: null` makes
 * every reader — including the JSON one caller after caller parses — check for a
 * second kind of missing. There is one: the key is not there.
 */
function measuredSize(width: unknown, height: unknown): { width?: number; height?: number } {
  return typeof width === 'number' && typeof height === 'number' ? { width, height } : {};
}

function rowToFileMeta(row: Record<string, unknown>): FileMeta {
  return {
    id: row.id as string,
    filename: row.filename as string,
    size: row.size as number,
    mimetype: (row.mimetype as string) ?? null,
    path: (row.path as string) ?? null,
    ...measuredSize(row.width, row.height),
    createdAt: row.created_at as string,
  };
}

export function insertFile(meta: {
  id: string;
  filename: string;
  size: number;
  mimetype: string | null;
  path: string | null;
  width?: number;
  height?: number;
}): FileMeta {
  const db = initDb();
  const now = new Date().toISOString();
  // Destructured so an explicit `width: undefined` cannot survive into the returned
  // descriptor as a present-but-empty key.
  const { width, height, ...rest } = meta;
  db.prepare('INSERT INTO files (id, filename, size, mimetype, path, width, height, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run(
    rest.id, rest.filename, rest.size, rest.mimetype, rest.path, width ?? null, height ?? null, now,
  );
  return { ...rest, ...measuredSize(width, height), createdAt: now };
}

export function getFile(id: string): FileMeta | undefined {
  const db = initDb();
  const row = db.prepare('SELECT * FROM files WHERE id = ?').get(id) as Record<string, unknown> | undefined;
  return row ? rowToFileMeta(row) : undefined;
}

export function listFiles(): FileMeta[] {
  const db = initDb();
  const rows = db.prepare('SELECT * FROM files ORDER BY created_at DESC').all() as Record<string, unknown>[];
  return rows.map(rowToFileMeta);
}

export function deleteFile(id: string): boolean {
  const db = initDb();
  const result = db.prepare('DELETE FROM files WHERE id = ?').run(id);
  return result.changes > 0;
}

/** Update the recorded on-disk path for a file (used when re-homing into the uploads dir). */
export function setFilePath(id: string, filePath: string): void {
  const db = initDb();
  db.prepare('UPDATE files SET path = ? WHERE id = ?').run(filePath, id);
}
