import type { Database as DatabaseType } from "better-sqlite3";

/** Sprints: named, time-boxed groups of top-level Todos (see sprints.ts).
 *
 *  Additive tables, never columns on `work_items`: the exact-shape verifier
 *  refuses any drift in an existing table, so a new table is the only extension
 *  a deployed database survives — and an older build simply ignores them, which
 *  is what makes a rollback safe. */

/** The name is unique case-insensitively, and the partial unique index allows at
 *  most one `active` sprint. */
export const SPRINTS_TABLE_DDL = `
CREATE TABLE IF NOT EXISTS sprints (
  id         TEXT PRIMARY KEY CHECK (id GLOB 'spr_[0-9a-f]*' AND length(id) = 16),
  name       TEXT NOT NULL COLLATE NOCASE UNIQUE,
  goal       TEXT,
  status     TEXT NOT NULL DEFAULT 'planned' CHECK (status IN ('planned','active','closed')),
  starts_at  TEXT,
  ends_at    TEXT,
  created_at TEXT NOT NULL,
  started_at TEXT,
  closed_at  TEXT
)`;

export const SPRINTS_DDL = `
${SPRINTS_TABLE_DDL};
CREATE UNIQUE INDEX IF NOT EXISTS uq_sprints_one_active ON sprints(status) WHERE status = 'active';
`;

/** A Todo's sprint: at most one per Todo, held by top-level Todos only (the
 *  write path refuses a sub-task; its root's row is the one every filter reads). */
export const WORK_ITEM_SPRINTS_TABLE_DDL = `
CREATE TABLE IF NOT EXISTS work_item_sprints (
  work_item_id TEXT PRIMARY KEY REFERENCES work_items(id),
  sprint_id    TEXT NOT NULL REFERENCES sprints(id),
  added_at     TEXT NOT NULL
)`;

export const WORK_ITEM_SPRINTS_DDL = `
${WORK_ITEM_SPRINTS_TABLE_DDL};
CREATE INDEX IF NOT EXISTS idx_wi_sprints_sprint ON work_item_sprints(sprint_id);
`;

/** Boot verification: every membership names a live Todo and an existing
 *  sprint, and at most one sprint is active (the partial unique index,
 *  re-proven here, house style). */
export function sprintRowsAreSound(db: DatabaseType, isLiveTodo: (id: string) => boolean): boolean {
  const sprintIds = new Set(db.prepare("SELECT id FROM sprints").pluck().all() as string[]);
  if (Number(db.prepare("SELECT COUNT(*) FROM sprints WHERE status = 'active'").pluck().get()) > 1) return false;
  const pairs = db.prepare("SELECT work_item_id, sprint_id FROM work_item_sprints").all() as Array<{
    work_item_id: string;
    sprint_id: string;
  }>;
  return pairs.every((pair) => isLiveTodo(pair.work_item_id) && sprintIds.has(pair.sprint_id));
}

/** The `sprint` list filter as a WHERE condition. Membership is held by the
 *  root, so a sub-task is in its root's sprint. `none` is in no sprint,
 *  `active` the running one, anything else a sprint id or (case-insensitive) name. */
export function sprintFilterCondition(sprint: string): { sql: string; values: string[] } {
  if (sprint === "none") {
    return { sql: "NOT EXISTS (SELECT 1 FROM work_item_sprints ws WHERE ws.work_item_id = work_items.root_id)", values: [] };
  }
  const member = "EXISTS (SELECT 1 FROM work_item_sprints ws JOIN sprints s ON s.id = ws.sprint_id WHERE ws.work_item_id = work_items.root_id AND ";
  if (sprint === "active") return { sql: `${member}s.status = 'active')`, values: [] };
  return { sql: `${member}(s.id = ? OR s.name = ? COLLATE NOCASE))`, values: [sprint, sprint] };
}
