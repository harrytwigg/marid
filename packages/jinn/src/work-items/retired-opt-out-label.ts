import { randomUUID } from "node:crypto";
import type { Database as DatabaseType } from "better-sqlite3";
import { writeAutoStartRow } from "./auto-start.js";

/** The label that once opted a Todo out of every automatic start. */
export const RETIRED_OPT_OUT_LABEL = "no-auto-start";

/** The actor the label change on each carried Todo is recorded under. */
export const RETIRED_OPT_OUT_LABEL_ACTOR = "migration";

function tableExists(db: DatabaseType, name: string): boolean {
  return db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name) !== undefined;
}

/**
 * Carry the retired `no-auto-start` label into the dispatch config's
 * `autoStart: false`, then delete the label.
 *
 * Two opt-outs did the same job: the label came first, and `autoStart` was
 * added so a trigger could filter on a typed flag. Nothing reads the label any
 * more, so a Todo still carrying it would silently become startable by the
 * board walk. Each one gets `autoStart: false` instead (overwriting an
 * `autoStart: true`, which the label used to override), loses the label with
 * the same `label_changed` event and version bump a live label write makes,
 * and the label itself is deleted so it can no longer be applied.
 *
 * Runs inside the Todo-DB migration's write lock on every boot, like the
 * retired statuses: with no such label it writes nothing. Every boot rather
 * than once, so a label re-created by an older gateway or a stale prompt is
 * honoured at the next boot instead of starting the Todo it was put on. Takes
 * `db` rather than the store's helpers, which import this module's caller.
 */
export function migrateRetiredOptOutLabel(db: DatabaseType): number {
  const required = ["labels", "work_item_labels", "work_item_auto_start", "work_item_events"];
  if (!required.every((name) => tableExists(db, name))) return 0;
  const labelId = db.prepare("SELECT id FROM labels WHERE name = ?").pluck().get(RETIRED_OPT_OUT_LABEL) as string | undefined;
  if (labelId === undefined) return 0;
  const carried = db.prepare("SELECT work_item_id FROM work_item_labels WHERE label_id = ? ORDER BY work_item_id")
    .pluck().all(labelId) as string[];
  const now = new Date().toISOString();
  const remaining = db.prepare(
    `SELECT l.name FROM work_item_labels wil JOIN labels l ON l.id = wil.label_id
      WHERE wil.work_item_id = ? AND l.id <> ? ORDER BY l.name`,
  ).pluck();
  const unlabel = db.prepare("DELETE FROM work_item_labels WHERE work_item_id = ? AND label_id = ?");
  const bump = db.prepare("UPDATE work_items SET updated_at = ?, version = version + 1 WHERE id = ?");
  const event = db.prepare(
    `INSERT INTO work_item_events (id, work_item_id, kind, from_status, to_status, actor, detail, created_at)
     VALUES (?, ?, 'label_changed', NULL, NULL, ?, ?, ?)`,
  );
  for (const workItemId of carried) {
    writeAutoStartRow(db, workItemId, false, now);
    const labels = remaining.all(workItemId, labelId) as string[];
    unlabel.run(workItemId, labelId);
    bump.run(now, workItemId);
    event.run(`wie_${randomUUID().replace(/-/g, "").slice(0, 12)}`, workItemId, RETIRED_OPT_OUT_LABEL_ACTOR,
      JSON.stringify({ labels, reason: "retired-opt-out-label", autoStart: false }), now);
  }
  db.prepare("DELETE FROM labels WHERE id = ?").run(labelId);
  return carried.length;
}
