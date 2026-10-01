import { createHash, randomUUID } from "node:crypto";
import type { Database as DatabaseType } from "better-sqlite3";
import { migrateRetiredStatuses } from "./retired-statuses.js";

/** The author every comment posted by this migration carries. */
export const RETIRED_APPROVAL_AUTHOR = "migration";

interface PendingApprovalRow {
  id: string;
  work_item_id: string;
  request: string;
  requested_by: string;
  escalated_at: string | null;
  options: string | null;
  operator_only: number;
}

function tableExists(db: DatabaseType, name: string): boolean {
  return db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name) !== undefined;
}

function commentBody(row: PendingApprovalRow): string {
  let options: string[] = [];
  try {
    const parsed = row.options ? JSON.parse(row.options) : [];
    if (Array.isArray(parsed)) options = parsed.filter((option): option is string => typeof option === "string");
  } catch {
    // An unreadable options blob loses only the options line.
  }
  return [
    `This approval was still pending when approvals were removed: ${row.request}`,
    ...(options.length > 0 ? [`Options: ${options.join(", ")}.`] : []),
    `Requested by ${row.requested_by}${row.operator_only ? ", reserved for the operator" : ""}${row.escalated_at ? ", escalated to the operator" : ""}.`,
    "Answer it here, or move the Todo.",
  ].join("\n\n");
}

/**
 * Carry each still-pending Todo approval over as a comment on its Todo.
 *
 * Nothing reads the approval tables any more, so a question an older gateway
 * left pending would otherwise vanish from every surface. The rows stay, inert;
 * an open Todo with a pending approval gets one system comment stating the
 * question, its options and who asked. The comment id is derived from the
 * approval's, so the post is written once however many times the gateway boots.
 * The Todo's status and assignee are left alone.
 *
 * Runs inside the Todo-DB migration's write lock on every boot. Takes `db`
 * rather than the comment store, which imports this module's caller.
 */
export function postRetiredApprovals(db: DatabaseType): number {
  if (!tableExists(db, "work_item_approvals") || !tableExists(db, "work_item_comments")) return 0;
  const choices = tableExists(db, "work_item_approval_choices");
  const operatorOnly = tableExists(db, "work_item_approval_operator_only");
  const rows = db.prepare(
    `SELECT a.id, a.work_item_id, a.request, a.requested_by, a.escalated_at,
            ${choices ? "(SELECT c.options FROM work_item_approval_choices c WHERE c.approval_id = a.id)" : "NULL"} AS options,
            ${operatorOnly ? "EXISTS (SELECT 1 FROM work_item_approval_operator_only o WHERE o.approval_id = a.id)" : "0"} AS operator_only
       FROM work_item_approvals a JOIN work_items w ON w.id = a.work_item_id
      WHERE a.state = 'pending' AND w.status NOT IN ('done', 'cancelled')`,
  ).all() as PendingApprovalRow[];
  if (rows.length === 0) return 0;
  const now = new Date().toISOString();
  const insert = db.prepare(
    `INSERT OR IGNORE INTO work_item_comments (id, work_item_id, parent_comment_id, author_kind, author, body, created_at, edited_at, deleted_at)
     VALUES (?, ?, NULL, 'system', ?, ?, ?, NULL, NULL)`,
  );
  const event = db.prepare(
    `INSERT INTO work_item_events (id, work_item_id, kind, from_status, to_status, actor, detail, created_at)
     VALUES (?, ?, 'comment_added', NULL, NULL, ?, ?, ?)`,
  );
  const bump = db.prepare("UPDATE work_items SET version = version + 1, updated_at = ? WHERE id = ?");
  let posted = 0;
  for (const row of rows) {
    const commentId = `wic_${createHash("sha256").update(`retired-approval:${row.id}`).digest("hex").slice(0, 12)}`;
    if (insert.run(commentId, row.work_item_id, RETIRED_APPROVAL_AUTHOR, commentBody(row), now).changes === 0) continue;
    event.run(`wie_${randomUUID().replace(/-/g, "").slice(0, 12)}`, row.work_item_id, RETIRED_APPROVAL_AUTHOR,
      JSON.stringify({ commentId, reason: "retired-approval", approvalId: row.id }), now);
    bump.run(now, row.work_item_id);
    posted += 1;
  }
  return posted;
}

/** The boot step for what retired Todo features left in the data: the retired
 *  statuses' rows, then the approvals still pending. */
export function migrateRetiredWorkItemData(db: DatabaseType): void {
  migrateRetiredStatuses(db);
  postRetiredApprovals(db);
}
