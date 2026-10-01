import { createHash, randomUUID } from "node:crypto";
import type { Database as DatabaseType } from "better-sqlite3";
import { migrateRetiredStatuses } from "./retired-statuses.js";

/** The actor every row written by this migration carries. */
export const RETIRED_APPROVAL_AUTHOR = "migration";

/** Set once the carry-over has run, so it runs once per database: a Todo
 *  closed at the upgrade and reopened later is not stopped again. */
export const RETIRED_APPROVALS_MARKER = "retired_approvals_carried";

interface PendingApprovalRow {
  id: string;
  work_item_id: string;
  status: string;
  request: string;
  requested_by: string;
  target: string | null;
  target_kind: string | null;
  escalated_at: string | null;
  options: string | null;
  operator_only: number;
}

function tableExists(db: DatabaseType, name: string): boolean {
  return db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name) !== undefined;
}

const newId = (prefix: string): string => `${prefix}_${randomUUID().replace(/-/g, "").slice(0, 12)}`;

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
    "The Todo is blocked until it is answered: reply here, then move it on.",
  ].join("\n\n");
}

/** Who the approval was waiting on: the routed employee, else the operator. */
function waitingOn(row: PendingApprovalRow): string {
  if (row.operator_only || row.escalated_at || row.target_kind !== "employee" || !row.target) return "the operator";
  return row.target;
}

function pendingApprovals(db: DatabaseType): PendingApprovalRow[] {
  const choices = tableExists(db, "work_item_approval_choices");
  const operatorOnly = tableExists(db, "work_item_approval_operator_only");
  return db.prepare(
    `SELECT a.id, a.work_item_id, w.status, a.request, a.requested_by, a.target, a.target_kind, a.escalated_at,
            ${choices ? "(SELECT c.options FROM work_item_approval_choices c WHERE c.approval_id = a.id)" : "NULL"} AS options,
            ${operatorOnly ? "EXISTS (SELECT 1 FROM work_item_approval_operator_only o WHERE o.approval_id = a.id)" : "0"} AS operator_only
       FROM work_item_approvals a JOIN work_items w ON w.id = a.work_item_id
      WHERE a.state = 'pending' AND w.status NOT IN ('done', 'cancelled')`,
  ).all() as PendingApprovalRow[];
}

/** Stop an open Todo in `blocked` as a declared human wait, the way a former
 *  escalation is stopped: a status event and a version bump like a transition,
 *  a needs-input block, and a hint naming what is waited on and by whom. A
 *  Todo already blocked keeps its status, and any hint it already has. */
function blockForAnswer(db: DatabaseType, row: PendingApprovalRow, now: string): void {
  const hasHint = db.prepare("SELECT 1 FROM work_item_stop_cause WHERE work_item_id = ? AND unblock_what IS NOT NULL")
    .get(row.work_item_id) !== undefined;
  if (!hasHint) {
    db.prepare(
      `INSERT INTO work_item_stop_cause (work_item_id, parked_until, unblock_what, unblock_who, updated_at)
       VALUES (?, NULL, ?, ?, ?)
       ON CONFLICT(work_item_id) DO UPDATE SET parked_until = NULL, unblock_what = excluded.unblock_what,
         unblock_who = excluded.unblock_who, updated_at = excluded.updated_at`,
    ).run(row.work_item_id, row.request, waitingOn(row), now);
  }
  if (row.status === "blocked") return;
  db.prepare("UPDATE work_items SET status = 'blocked', updated_at = ?, version = version + 1 WHERE id = ? AND status = ?")
    .run(now, row.work_item_id, row.status);
  db.prepare(
    `INSERT INTO work_item_blocks (work_item_id, kind, recurrences, first_blocked_at, last_blocked_at)
     VALUES (?, 'needs_input', 0, ?, ?)
     ON CONFLICT(work_item_id) DO UPDATE SET kind = 'needs_input', last_blocked_at = excluded.last_blocked_at`,
  ).run(row.work_item_id, now, now);
  db.prepare(
    `INSERT INTO work_item_events (id, work_item_id, kind, from_status, to_status, actor, detail, created_at)
     VALUES (?, ?, 'status_change', ?, 'blocked', ?, ?, ?)`,
  ).run(newId("wie"), row.work_item_id, row.status, RETIRED_APPROVAL_AUTHOR,
    JSON.stringify({ reason: "retired-approval", declared: true, blockKind: "needs_input", approvalId: row.id }), now);
}

function postComment(db: DatabaseType, row: PendingApprovalRow, now: string): void {
  const commentId = `wic_${createHash("sha256").update(`retired-approval:${row.id}`).digest("hex").slice(0, 12)}`;
  const inserted = db.prepare(
    `INSERT OR IGNORE INTO work_item_comments (id, work_item_id, parent_comment_id, author_kind, author, body, created_at, edited_at, deleted_at)
     VALUES (?, ?, NULL, 'system', ?, ?, ?, NULL, NULL)`,
  ).run(commentId, row.work_item_id, RETIRED_APPROVAL_AUTHOR, commentBody(row), now).changes > 0;
  if (!inserted) return;
  db.prepare(
    `INSERT INTO work_item_events (id, work_item_id, kind, from_status, to_status, actor, detail, created_at)
     VALUES (?, ?, 'comment_added', NULL, NULL, ?, ?, ?)`,
  ).run(newId("wie"), row.work_item_id, RETIRED_APPROVAL_AUTHOR,
    JSON.stringify({ commentId, reason: "retired-approval", approvalId: row.id }), now);
  db.prepare("UPDATE work_items SET version = version + 1, updated_at = ? WHERE id = ?").run(now, row.work_item_id);
}

/**
 * Carry each still-pending Todo approval over, once, as a stop and a comment.
 *
 * Nothing reads the approval tables any more, and their guards went with them:
 * a pending gate no longer withholds the trust-tier close, keeps idle capacity
 * off a backlog Todo, or puts the Todo in anyone's queue. So an open Todo with a
 * pending approval is stopped in `blocked` for whoever was asked, and the
 * question, its options and the asker are posted on it as a system comment.
 * The approval rows stay, inert.
 *
 * Runs inside the Todo-DB migration's write lock, and once per database (a
 * `meta` marker); the comment id is derived from the approval's, so a rerun
 * without the marker still posts it once. Takes `db` rather than the store's
 * helpers, which import this module's caller.
 */
export function postRetiredApprovals(db: DatabaseType): number {
  const required = ["work_item_approvals", "work_item_comments", "work_item_stop_cause", "work_item_blocks", "meta"];
  if (!required.every((name) => tableExists(db, name))) return 0;
  if (db.prepare("SELECT 1 FROM meta WHERE key = ?").get(RETIRED_APPROVALS_MARKER)) return 0;
  const rows = pendingApprovals(db);
  const now = new Date().toISOString();
  for (const row of rows) {
    blockForAnswer(db, row, now);
    postComment(db, row, now);
  }
  db.prepare("INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)").run(RETIRED_APPROVALS_MARKER, now);
  return rows.length;
}

/** The boot step for what retired Todo features left in the data: the retired
 *  statuses' rows, then the approvals still pending. */
export function migrateRetiredWorkItemData(db: DatabaseType): void {
  migrateRetiredStatuses(db);
  postRetiredApprovals(db);
}
