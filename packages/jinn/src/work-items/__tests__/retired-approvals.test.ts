import { describe, it, expect, beforeAll } from "vitest";
import os from "node:os";
import fs from "node:fs";
import path from "node:path";

// Throwaway registry (SESSIONS_DB resolves from JINN_HOME at module load).
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "jinn-wi-retired-approvals-"));
process.env.JINN_HOME = tmp;

type Store = typeof import("../store.js");
type Comments = typeof import("../comments.js");
type Retired = typeof import("../retired-approvals.js");
type Migrate = typeof import("../migrate.js");

let store: Store;
let comments: Comments;
let retired: Retired;
let migrate: Migrate;
let db: import("better-sqlite3").Database;
let seq = 0;

beforeAll(async () => {
  store = await import("../store.js");
  comments = await import("../comments.js");
  retired = await import("../retired-approvals.js");
  migrate = await import("../migrate.js");
  db = (await import("../../shared/db.js")).initDb();
});

/** An approval row an older gateway wrote; nothing in this one writes them. */
function legacyApproval(workItemId: string, state: "pending" | "approved" | "rejected", extra: { options?: string[]; operatorOnly?: boolean; escalated?: boolean } = {}): string {
  const id = `wap_${(++seq).toString(16).padStart(12, "0")}`;
  db.prepare(`INSERT INTO work_item_approvals (id, work_item_id, state, request, target, target_kind, requested_by, requested_at, escalated_at)
              VALUES (?, ?, ?, ?, 'Jinn', 'virtual', 'platform-worker', ?, ?)`)
    .run(id, workItemId, state, `Question ${seq}?`, new Date().toISOString(), extra.escalated ? new Date().toISOString() : null);
  if (extra.options) db.prepare("INSERT INTO work_item_approval_choices (approval_id, options) VALUES (?, ?)").run(id, JSON.stringify(extra.options));
  if (extra.operatorOnly) db.prepare("INSERT INTO work_item_approval_operator_only (approval_id) VALUES (?)").run(id);
  return id;
}

describe("carrying pending approvals over as comments", () => {
  it("posts a still-pending approval's question, options and asker on its open Todo, on boot", () => {
    const item = store.createWorkItem({ title: "waiting on a vendor pick" });
    legacyApproval(item.id, "pending", { options: ["Acme", "Globex"], operatorOnly: true, escalated: true });

    migrate.migrateWorkItemsSchema(db);

    const [comment] = comments.listComments(item.id).comments;
    expect(comment).toMatchObject({ authorKind: "system", author: retired.RETIRED_APPROVAL_AUTHOR, parentCommentId: null });
    expect(comment.body).toContain(`Question ${seq}?`);
    expect(comment.body).toContain("Options: Acme, Globex.");
    expect(comment.body).toContain("Requested by platform-worker, reserved for the operator, escalated to the operator.");
    const after = store.getWorkItem(item.id)!;
    expect([after.status, after.version]).toEqual([item.status, item.version + 1]);
  });

  it("leaves decided approvals and closed Todos alone", () => {
    const decided = store.createWorkItem({ title: "already decided" });
    legacyApproval(decided.id, "approved");
    const closed = store.createWorkItem({ title: "closed with a gate open" });
    legacyApproval(closed.id, "pending");
    db.prepare("UPDATE work_items SET status = 'cancelled' WHERE id = ?").run(closed.id);

    retired.postRetiredApprovals(db);

    expect(comments.listComments(decided.id).total).toBe(0);
    expect(comments.listComments(closed.id).total).toBe(0);
  });

  it("writes nothing on a second boot", () => {
    const item = store.createWorkItem({ title: "asked once" });
    legacyApproval(item.id, "pending");
    retired.postRetiredApprovals(db);
    const events = db.prepare("SELECT COUNT(*) FROM work_item_events").pluck().get();
    const version = store.getWorkItem(item.id)!.version;

    expect(retired.postRetiredApprovals(db)).toBe(0);
    migrate.migrateWorkItemsSchema(db);
    expect(db.prepare("SELECT COUNT(*) FROM work_item_events").pluck().get()).toBe(events);
    expect(store.getWorkItem(item.id)!.version).toBe(version);
    expect(comments.listComments(item.id).total).toBe(1);
  });
});
