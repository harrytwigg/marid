import type { Database as DatabaseType } from "better-sqlite3";
import { initDb } from "../shared/db.js";
import type { WorkItemEvent, WorkItemStatus } from "./store.js";

/**
 * The record of a child Todo settling, kept so its parent's owner is woken.
 *
 * A row is written inside the status write's own transaction (`transition()`),
 * so a rollback takes it with the move and a crash after the commit leaves it
 * pending for the sweep (`child-settle-wake.ts`). A row says only that a child
 * moved; who it concerns, and whether anyone is woken, is decided when the
 * parent is flushed.
 *
 * Additive, never a column on `work_items`: the exact-shape verifier refuses
 * drift in an existing table. `outcome` is one of {@link ChildSettleOutcome};
 * it is free text in the table so a later outcome never needs a rebuild.
 */
export const WORK_ITEM_CHILD_SETTLES_TABLE_DDL = `
CREATE TABLE IF NOT EXISTS work_item_child_settles (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  parent_id    TEXT NOT NULL REFERENCES work_items(id) ON DELETE CASCADE,
  child_id     TEXT NOT NULL REFERENCES work_items(id) ON DELETE CASCADE,
  event_id     TEXT NOT NULL UNIQUE,
  from_status  TEXT NOT NULL,
  to_status    TEXT NOT NULL,
  actor        TEXT NOT NULL,
  created_at   TEXT NOT NULL,
  flushed_at   TEXT,
  outcome      TEXT,
  delivery_id  TEXT
)`;

export const WORK_ITEM_CHILD_SETTLES_DDL = `
${WORK_ITEM_CHILD_SETTLES_TABLE_DDL};
CREATE INDEX IF NOT EXISTS idx_child_settles_pending
  ON work_item_child_settles(parent_id) WHERE flushed_at IS NULL;
`;

/** What became of a settled child's row once its parent was flushed. */
export type ChildSettleOutcome = "woken" | "deduped" | "redispatched" | "recorded";

/** The statuses a child leaves work in: the ones that hand it back to someone. */
const SETTLED_STATUSES: ReadonlySet<WorkItemStatus> = new Set<WorkItemStatus>(["in_review", "blocked", "done", "cancelled"]);

/** Whether a move of a Todo under `parentId` is a child settling. */
export function isChildSettle(parentId: string | null | undefined, from: WorkItemStatus, to: WorkItemStatus): boolean {
  return !!parentId && to !== from && SETTLED_STATUSES.has(to);
}

export interface ChildSettleRow {
  id: number;
  parentId: string;
  childId: string;
  eventId: string;
  fromStatus: WorkItemStatus;
  toStatus: WorkItemStatus;
  actor: string;
  createdAt: string;
}

interface SettleDbRow {
  id: number;
  parent_id: string;
  child_id: string;
  event_id: string;
  from_status: WorkItemStatus;
  to_status: WorkItemStatus;
  actor: string;
  created_at: string;
}

function toRow(row: SettleDbRow): ChildSettleRow {
  return {
    id: row.id,
    parentId: row.parent_id,
    childId: row.child_id,
    eventId: row.event_id,
    fromStatus: row.from_status,
    toStatus: row.to_status,
    actor: row.actor,
    createdAt: row.created_at,
  };
}

/** Record that `event` settled a child of `parentId`. Run on `transition()`'s
 *  `db`, inside its transaction. */
export function recordChildSettle(db: DatabaseType, parentId: string, event: WorkItemEvent): void {
  if (!event.fromStatus || !event.toStatus) return;
  db.prepare(
    `INSERT OR IGNORE INTO work_item_child_settles
       (parent_id, child_id, event_id, from_status, to_status, actor, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(parentId, event.workItemId, event.id, event.fromStatus, event.toStatus, event.actor ?? "system", event.createdAt);
}

/** The parent's rows that have not been flushed, oldest first. */
export function pendingChildSettles(parentId: string, db: DatabaseType = initDb()): ChildSettleRow[] {
  return (db.prepare("SELECT * FROM work_item_child_settles WHERE parent_id = ? AND flushed_at IS NULL ORDER BY id")
    .all(parentId) as SettleDbRow[]).map(toRow);
}

/** Whether a wake for this parent is still on its way: any row not yet flushed. */
export function hasPendingChildSettles(parentId: string): boolean {
  return initDb().prepare("SELECT 1 FROM work_item_child_settles WHERE parent_id = ? AND flushed_at IS NULL LIMIT 1")
    .get(parentId) !== undefined;
}

/** Every parent with unflushed rows and the instant its oldest one was written. */
export function parentsWithPendingSettles(): Array<{ parentId: string; oldestAt: number }> {
  const rows = initDb().prepare(
    `SELECT parent_id AS parentId, MIN(created_at) AS oldest
     FROM work_item_child_settles WHERE flushed_at IS NULL GROUP BY parent_id`,
  ).all() as Array<{ parentId: string; oldest: string }>;
  return rows.map((row) => ({ parentId: row.parentId, oldestAt: Date.parse(row.oldest) || 0 }));
}

/** Close rows out with their outcome, on the flush's `db`. Only rows still
 *  pending are touched, so a second flush of the same rows changes nothing. */
export function markChildSettles(
  db: DatabaseType,
  ids: readonly number[],
  outcome: ChildSettleOutcome,
  options: { deliveryId?: string; now?: string } = {},
): void {
  if (ids.length === 0) return;
  const now = options.now ?? new Date().toISOString();
  const mark = db.prepare(
    "UPDATE work_item_child_settles SET flushed_at = ?, outcome = ?, delivery_id = ? WHERE id = ? AND flushed_at IS NULL",
  );
  for (const id of ids) mark.run(now, outcome, options.deliveryId ?? null, id);
}

/** Change what an already-flushed row says became of it, once the action it
 *  named turned out not to happen. */
export function reclassifyChildSettles(ids: readonly number[], outcome: ChildSettleOutcome): void {
  const db = initDb();
  const update = db.prepare("UPDATE work_item_child_settles SET outcome = ? WHERE id = ? AND flushed_at IS NOT NULL");
  for (const id of ids) update.run(outcome, id);
}

/** Put rows back to pending: a flush whose re-dispatch threw is tried again by the sweep. */
export function reopenChildSettles(ids: readonly number[]): void {
  const db = initDb();
  const reopen = db.prepare("UPDATE work_item_child_settles SET flushed_at = NULL, outcome = NULL, delivery_id = NULL WHERE id = ?");
  for (const id of ids) reopen.run(id);
}
