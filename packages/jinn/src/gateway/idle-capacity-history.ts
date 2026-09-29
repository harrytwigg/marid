import { initDb } from "../shared/db.js";
import { IDLE_CAPACITY_ACTOR, parseStartNote, type ParsedStartNote } from "../shared/idle-capacity-record.js";

/**
 * What the idle-capacity loop has actually started (User Story 2),
 * read back from the system comments it leaves — the only record of a start.
 *
 * Not a table of its own: the comment already carries every field the
 * operator asked to see, and a second record beside it would be a second
 * thing that could disagree with the first. The cost is that a comment the
 * operator deleted is a tombstone with no body, and is gone from here too.
 */

export interface IdleCapacityStart extends ParsedStartNote {
  workItemId: string;
  commentId: string;
  /** The comment's `createdAt`: the moment the Dispatcher was started. */
  startedAt: string;
  /** The Todo as it is NOW, not as it was — a start whose Todo has since
   *  closed is still a start. */
  title: string;
  status: string;
}

export const HISTORY_DEFAULT_LIMIT = 50;
export const HISTORY_MAX_LIMIT = 500;

interface Row { id: string; work_item_id: string; body: string; created_at: string; title: string; status: string }

/** Newest first. Keyed on the (kind, author) pair, never the author string
 *  alone — an employee whose slug happened to be `idle-capacity` would
 *  otherwise write history. A scan of the comments table, bounded by `limit`;
 *  the existing index is per Todo and this read is across them. */
export function listIdleCapacityStarts(opts: { limit?: number } = {}): IdleCapacityStart[] {
  const limit = Math.min(HISTORY_MAX_LIMIT, Math.max(1, Math.floor(opts.limit ?? HISTORY_DEFAULT_LIMIT)));
  const rows = initDb()
    .prepare(
      `SELECT c.id, c.work_item_id, c.body, c.created_at, w.title, w.status
         FROM work_item_comments c JOIN work_items w ON w.id = c.work_item_id
        WHERE c.author_kind = 'system' AND c.author = ? AND c.deleted_at IS NULL
        ORDER BY c.created_at DESC, c.rowid DESC LIMIT ?`,
    )
    .all(IDLE_CAPACITY_ACTOR, limit) as Row[];
  return rows.map((row) => ({
    ...parseStartNote(row.body),
    workItemId: row.work_item_id,
    commentId: row.id,
    startedAt: row.created_at,
    title: row.title,
    status: row.status,
  }));
}
