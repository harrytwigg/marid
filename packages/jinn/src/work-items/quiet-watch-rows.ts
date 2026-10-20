import { initDb } from "../shared/db.js";

/**
 * Where the quiet-Todo watch keeps its place on each `executing` Todo, so a
 * restart neither nudges a producer twice nor forgets that it already did.
 *
 * One row per Todo, for one executing stint: `stint` is when the Todo last
 * entered `executing`, and a row from an earlier stint is replaced rather than
 * read. Additive, never a column on `work_items`: the exact-shape verifier
 * refuses drift in an existing table. See specs/006-todo-tree-wake/spec.md,
 * Part D.
 */
export const WORK_ITEM_QUIET_WATCH_TABLE_DDL = `
CREATE TABLE IF NOT EXISTS work_item_quiet_watch (
  work_item_id     TEXT PRIMARY KEY REFERENCES work_items(id) ON DELETE CASCADE,
  stint            TEXT NOT NULL,
  nudged_at        TEXT,
  nudge_session_id TEXT,
  escalated_at     TEXT,
  updated_at       TEXT NOT NULL
)`;

export const WORK_ITEM_QUIET_WATCH_DDL = `${WORK_ITEM_QUIET_WATCH_TABLE_DDL};`;

export interface QuietWatchRow {
  workItemId: string;
  stint: string;
  nudgedAt: string | null;
  nudgeSessionId: string | null;
  escalatedAt: string | null;
}

interface RawRow {
  work_item_id: string;
  stint: string;
  nudged_at: string | null;
  nudge_session_id: string | null;
  escalated_at: string | null;
}

/** The Todo's row for `stint`, or none when it has none or holds an earlier stint's. */
export function quietWatchFor(workItemId: string, stint: string): QuietWatchRow | undefined {
  const row = initDb()
    .prepare("SELECT work_item_id, stint, nudged_at, nudge_session_id, escalated_at FROM work_item_quiet_watch WHERE work_item_id = ?")
    .get(workItemId) as RawRow | undefined;
  if (!row || row.stint !== stint) return undefined;
  return {
    workItemId: row.work_item_id,
    stint: row.stint,
    nudgedAt: row.nudged_at,
    nudgeSessionId: row.nudge_session_id,
    escalatedAt: row.escalated_at,
  };
}

/** Record the nudge for this stint, replacing whatever an earlier stint left. */
export function recordQuietNudge(workItemId: string, stint: string, sessionId: string | null, at: string): void {
  initDb().prepare(`
    INSERT INTO work_item_quiet_watch (work_item_id, stint, nudged_at, nudge_session_id, escalated_at, updated_at)
    VALUES (?, ?, ?, ?, NULL, ?)
    ON CONFLICT(work_item_id) DO UPDATE SET
      stint = excluded.stint, nudged_at = excluded.nudged_at, nudge_session_id = excluded.nudge_session_id,
      escalated_at = NULL, updated_at = excluded.updated_at
  `).run(workItemId, stint, at, sessionId, at);
}

/** Record the escalation for this stint. A stint with no nudge (no session could
 *  take one) gets its row here. */
export function recordQuietEscalation(workItemId: string, stint: string, at: string): void {
  initDb().prepare(`
    INSERT INTO work_item_quiet_watch (work_item_id, stint, nudged_at, nudge_session_id, escalated_at, updated_at)
    VALUES (?, ?, NULL, NULL, ?, ?)
    ON CONFLICT(work_item_id) DO UPDATE SET
      escalated_at = excluded.escalated_at, updated_at = excluded.updated_at,
      nudged_at = CASE WHEN stint = excluded.stint THEN nudged_at END,
      nudge_session_id = CASE WHEN stint = excluded.stint THEN nudge_session_id END,
      stint = excluded.stint
  `).run(workItemId, stint, at, at);
}
