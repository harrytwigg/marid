import { describe, it, expect, beforeAll, beforeEach } from "vitest";
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

// Each case is its own "first boot after the upgrade".
beforeEach(() => {
  db.prepare("DELETE FROM meta WHERE key = ?").run(retired.RETIRED_APPROVALS_MARKER);
});

interface LegacyApproval { options?: string[]; operatorOnly?: boolean; escalated?: boolean; target?: string; state?: "pending" | "approved" }

/** An approval row an older gateway wrote; nothing in this one writes them. */
function legacyApproval(workItemId: string, extra: LegacyApproval = {}): string {
  const id = `wap_${(++seq).toString(16).padStart(12, "0")}`;
  db.prepare(`INSERT INTO work_item_approvals (id, work_item_id, state, request, target, target_kind, requested_by, requested_at, escalated_at)
              VALUES (?, ?, ?, ?, ?, ?, 'platform-worker', ?, ?)`)
    .run(id, workItemId, extra.state ?? "pending", `Question ${seq}?`, extra.target ?? "Jinn", extra.target ? "employee" : "virtual",
      new Date().toISOString(), extra.escalated ? new Date().toISOString() : null);
  if (extra.options) db.prepare("INSERT INTO work_item_approval_choices (approval_id, options) VALUES (?, ?)").run(id, JSON.stringify(extra.options));
  if (extra.operatorOnly) db.prepare("INSERT INTO work_item_approval_operator_only (approval_id) VALUES (?)").run(id);
  return id;
}

const stopCause = (id: string) =>
  db.prepare("SELECT parked_until, unblock_what, unblock_who FROM work_item_stop_cause WHERE work_item_id = ?").get(id);

const operatorQueue = () =>
  store.listWorkItems({ needsAttentionFor: "Jinn", needsAttentionOperator: true }).map((item) => item.id);

describe("carrying pending approvals over", () => {
  it("stops an open Todo in blocked for the operator and posts the question, its options and the asker, on boot", () => {
    const item = store.createWorkItem({ title: "waiting on a vendor pick" });
    legacyApproval(item.id, { options: ["Acme", "Globex"], operatorOnly: true, escalated: true });

    migrate.migrateWorkItemsSchema(db);

    const after = store.getWorkItem(item.id)!;
    expect(after.status).toBe("blocked");
    expect(stopCause(item.id)).toEqual({ parked_until: null, unblock_what: `Question ${seq}?`, unblock_who: "the operator" });
    const [moved] = store.listWorkItemEvents(item.id).filter((event) => event.kind === "status_change" && event.actor === retired.RETIRED_APPROVAL_AUTHOR);
    expect(moved).toMatchObject({ fromStatus: "backlog", toStatus: "blocked", detail: { declared: true, blockKind: "needs_input" } });
    const [comment] = comments.listComments(item.id).comments;
    expect(comment).toMatchObject({ authorKind: "system", author: retired.RETIRED_APPROVAL_AUTHOR, parentCommentId: null });
    expect(comment.body).toContain(`Question ${seq}?`);
    expect(comment.body).toContain("Options: Acme, Globex.");
    expect(comment.body).toContain("Requested by platform-worker, reserved for the operator, escalated to the operator.");
    expect(operatorQueue()).toContain(item.id);
  });

  // The guards a pending gate used to hold went with approvals: without the
  // stop, the trust tier would close it unanswered and the board walk start it.
  it("keeps a trust-tier Todo in review from closing over the question", async () => {
    const reconcile = await import("../reconcile.js");
    const gated = store.createWorkItem({ title: "land on main?", status: "in_review", source: "cron", sourceRef: "cron:gate:1" });
    const control = store.createWorkItem({ title: "nothing pending", status: "in_review", source: "cron", sourceRef: "cron:gate:2" });
    legacyApproval(gated.id);

    retired.postRetiredApprovals(db);
    reconcile.reconcileWorkItem(gated.id);
    reconcile.reconcileWorkItem(control.id);

    expect(store.getWorkItem(gated.id)!.status).toBe("blocked");
    expect(store.getWorkItem(control.id)!.status).toBe("done");
  });

  it("takes a backlog Todo out of the queue the board walk starts from", () => {
    const item = store.createWorkItem({ title: "who should own this?", assignee: "platform-worker" });
    legacyApproval(item.id);

    retired.postRetiredApprovals(db);

    expect(store.getWorkItem(item.id)!.status).toBe("blocked");
  });

  it("names the routed employee as who it waits on, and keeps a blocked Todo's own hint but not its park", () => {
    const routed = store.createWorkItem({ title: "for the manager" });
    legacyApproval(routed.id, { target: "eng-manager" });
    const blocked = store.createWorkItem({ title: "already blocked", status: "blocked" });
    db.prepare("INSERT INTO work_item_stop_cause (work_item_id, parked_until, unblock_what, unblock_who, updated_at) VALUES (?, ?, 'the key', 'ops', ?)")
      .run(blocked.id, new Date(Date.now() + 86_400_000).toISOString(), new Date().toISOString());
    legacyApproval(blocked.id);

    retired.postRetiredApprovals(db);

    expect(stopCause(routed.id)).toMatchObject({ unblock_who: "eng-manager" });
    expect(stopCause(blocked.id)).toEqual({ parked_until: null, unblock_what: "the key", unblock_who: "ops" });
    expect(store.listWorkItemEvents(blocked.id).some((event) => event.kind === "status_change" && event.actor === retired.RETIRED_APPROVAL_AUTHOR)).toBe(false);
  });

  it("leaves decided approvals and closed Todos alone, and does not stop a closed one reopened later", () => {
    const decided = store.createWorkItem({ title: "already decided" });
    legacyApproval(decided.id, { state: "approved" });
    const closed = store.createWorkItem({ title: "closed with a gate open" });
    legacyApproval(closed.id);
    db.prepare("UPDATE work_items SET status = 'cancelled' WHERE id = ?").run(closed.id);

    retired.postRetiredApprovals(db);
    db.prepare("UPDATE work_items SET status = 'backlog' WHERE id = ?").run(closed.id);
    migrate.migrateWorkItemsSchema(db);

    expect([store.getWorkItem(decided.id)!.status, comments.listComments(decided.id).total]).toEqual(["backlog", 0]);
    expect([store.getWorkItem(closed.id)!.status, comments.listComments(closed.id).total]).toEqual(["backlog", 0]);
  });

  it("writes nothing on a second boot", () => {
    const item = store.createWorkItem({ title: "asked once" });
    legacyApproval(item.id);
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
