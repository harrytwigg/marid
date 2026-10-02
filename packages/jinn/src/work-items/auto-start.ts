import type { Database as DatabaseType } from 'better-sqlite3';

/** the per-Todo auto-start opt-out, as rows. The table is declared in
 *  `dispatch-schema.ts` and the flag is surfaced through the Todo's dispatch
 *  config, where the board walk reads it; this module is the one
 *  reader and writer of the rows. */

export interface AutoStartRow {
  auto_start: 0 | 1;
  updated_at: string;
}

export function readAutoStartRow(db: DatabaseType, workItemId: string): AutoStartRow | undefined {
  return db
    .prepare('SELECT auto_start, updated_at FROM work_item_auto_start WHERE work_item_id = ?')
    .get(workItemId) as AutoStartRow | undefined;
}

export function writeAutoStartRow(db: DatabaseType, workItemId: string, autoStart: boolean, updatedAt: string): void {
  db.prepare(
    `INSERT INTO work_item_auto_start (work_item_id, auto_start, updated_at)
     VALUES (?, ?, ?)
     ON CONFLICT(work_item_id) DO UPDATE SET auto_start = excluded.auto_start, updated_at = excluded.updated_at`,
  ).run(workItemId, autoStart ? 1 : 0, updatedAt);
}
