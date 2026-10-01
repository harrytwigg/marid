import { randomUUID } from "node:crypto";
import type { Database as DatabaseType } from "better-sqlite3";

/** The actor every row moved by this migration is recorded under. */
export const RETIRED_STATUS_MIGRATION_ACTOR = "migration";

/**
 * The two statuses the gateway no longer writes, and where each one's rows go.
 * `assigned` was "owned, not started" — the owner stays, the Todo waits in
 * `backlog` for a dispatch. `escalated` was "stopped for the operator", which
 * is what `blocked` now says on its own.
 *
 * The `work_items` CHECK still admits both: its DDL is verified byte for byte
 * at boot, so the reduced set is enforced in code instead, and this moves any
 * row an older gateway wrote.
 */
const RETIRED_TARGETS: Readonly<Record<string, "backlog" | "blocked">> = { assigned: "backlog", escalated: "blocked" };

interface RetiredRow {
  id: string;
  status: string;
  source: string;
  department: string | null;
  assignee: string | null;
}

/**
 * Move every `assigned` row to `backlog` and every `escalated` row to `blocked`,
 * keeping the assignee. Each move bumps the row's version and writes the same
 * `status_change` event a transition would, so the event log, version-fenced
 * caches and attempt evidence agree with the row. A former escalation is
 * recorded as a declared block, so recovery leaves it for the operator rather
 * than restarting it.
 *
 * Runs inside the Todo-DB migration's write lock on every boot; with nothing
 * left in a retired status it writes nothing. Takes `db` rather than using the
 * store's helpers, which import this module's caller.
 */
export function migrateRetiredStatuses(db: DatabaseType): number {
  const rows = db
    .prepare("SELECT id, status, source, department, assignee FROM work_items WHERE status IN ('assigned', 'escalated')")
    .all() as RetiredRow[];
  if (rows.length === 0) return 0;
  const now = new Date().toISOString();
  const update = db.prepare("UPDATE work_items SET status = ?, updated_at = ?, version = version + 1 WHERE id = ? AND status = ?");
  const event = db.prepare(
    `INSERT INTO work_item_events (id, work_item_id, kind, from_status, to_status, actor, detail, created_at)
     VALUES (?, ?, 'status_change', ?, ?, ?, ?, ?)`,
  );
  for (const row of rows) {
    const target = RETIRED_TARGETS[row.status];
    update.run(target, now, row.id, row.status);
    const detail = {
      reason: "retired-status",
      ...(target === "blocked" ? { declared: true } : {}),
      todoProvenance: { source: row.source, department: row.department, assignee: row.assignee },
    };
    event.run(`wie_${randomUUID().replace(/-/g, "").slice(0, 12)}`, row.id, row.status, target,
      RETIRED_STATUS_MIGRATION_ACTOR, JSON.stringify(detail), now);
  }
  return rows.length;
}
