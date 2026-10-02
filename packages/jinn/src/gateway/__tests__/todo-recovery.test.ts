import { afterAll, beforeAll, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";

// The home vitest.setup allocated for this file, before the override below.
const inheritedHome = process.env.JINN_HOME!;
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "jinn-gw-todo-recovery-"));
process.env.JINN_HOME = tmp;

// Every module below is loaded AFTER the override, never as a static import:
// they reach shared/paths.ts, which freezes the registry path at import time,
// and a static import is hoisted above the assignment.

type Store = typeof import("../../work-items/store.js");
type Runs = typeof import("../../work-items/runs.js");
type Approvals = typeof import("../../work-items/approvals.js");
type Transitions = typeof import("../../work-items/transitions.js");
type Controller = typeof import("../../work-items/recovery-controller.js");
type Detect = typeof import("../../work-items/anomaly-detect.js");
type Rows = typeof import("../../work-items/recovery-rows.js");

let store: Store;
let runs: Runs;
let approvals: Approvals;
let transitions: Transitions;
let controller: Controller;
let detect: Detect;
let rows: Rows;
let db: import("better-sqlite3").Database;

beforeAll(async () => {
  store = await import("../../work-items/store.js");
  runs = await import("../../work-items/runs.js");
  approvals = await import("../../work-items/approvals.js");
  transitions = await import("../../work-items/transitions.js");
  controller = await import("../../work-items/recovery-controller.js");
  detect = await import("../../work-items/anomaly-detect.js");
  rows = await import("../../work-items/recovery-rows.js");
  db = (await import("../../shared/db.js")).initDb();
});

afterAll(async () => {
  (await import("../../shared/db.js")).__closeDbForTest();
  fs.rmSync(tmp, { recursive: true, force: true });
});

function tick(mode: "classify-only" | "auto" = "classify-only"): void {
  controller.sweepTodoRecovery({ mode, rearm: () => ({ status: "assigned" }) });
  detect.detectTodoAnomalies({ persist: true });
}

describe("recovery fixture isolation", () => {
  it("opens the registry in its own home", () => {
    expect(db.name).toBe(path.join(tmp, "sessions", "registry.db"));
  });

  it("keeps approval writes independent of another fixture's commit", () => {
    const item = store.createWorkItem({ title: "isolated approval" });
    const peerPath = path.join(inheritedHome, "sessions", "registry.db");
    fs.mkdirSync(path.dirname(peerPath), { recursive: true });
    const peer = new Database(peerPath);
    peer.pragma("journal_mode = WAL");
    peer.exec("CREATE TABLE IF NOT EXISTS isolation_probe (value TEXT)");
    try {
      db.transaction(() => {
        db.prepare("SELECT id FROM work_items WHERE id = ?").get(item.id);
        // Reproduce a competing fixture committing after the reader's snapshot.
        peer.prepare("INSERT INTO isolation_probe VALUES (?)").run("peer commit");
        approvals.requestApproval(item.id, { request: "Approve isolated work?" });
      })();
      expect(store.getWorkItem(item.id)!.approvalState).toBe("pending");
      expect(peer.prepare("SELECT name FROM sqlite_master WHERE name = 'work_items'").get())
        .toBeUndefined();
    } finally {
      peer.close();
    }
  });
});

describe("approved leftovers and the classifier", () => {
  it("keeps a refused open-child leftover on Manager attention across repeated ticks", () => {
    const item = store.createWorkItem({
      title: "approved landing with open child", status: "assigned", assignee: "platform-worker",
    });
    transitions.transition(item.id, "in_review", "session:worker", { agent: true });
    store.createWorkItem({
      title: "open child leftover", parentId: item.id, status: "assigned", assignee: "platform-worker",
    });
    const sessionId = `s-child-${item.id}`;
    db.prepare(
      `INSERT INTO sessions (id, engine, source, source_ref, status, work_item_id, created_at, last_activity)
       VALUES (?, 'claude', 'cron', ?, 'idle', ?, ?, ?)`,
    ).run(sessionId, `cron:${sessionId}`, item.id, new Date().toISOString(), new Date().toISOString());
    const attempt = runs.openWorkItemRun({ workItemId: item.id, sessionId });
    runs.closeWorkItemRun(attempt.id, { outcome: "completed", endedAt: new Date().toISOString() });
    // A gate a removed Workflow run left pending is decided without moving its Todo.
    approvals.requestApproval(item.id, {
      request: "Land?", ref: "workflow:pipeline:run_1:gate", target: "operator",
    });
    approvals.decideWorkItemApprovalSync({ id: item.id, decision: "approve", decidedBy: "operator" });
    expect(store.getWorkItem(item.id)!.status).toBe("in_review");

    tick();
    tick();

    expect(store.getWorkItem(item.id)!.status).toBe("in_review");
    expect(rows.getWorkItemRecovery(item.id)).toMatchObject({ lane: "manager" });
    expect(store.listWorkItems({ needsAttentionFor: "operator" }).map((row) => row.id)).toContain(item.id);
  });

  it("keeps the classifier's verdict when the detector disagrees, across repeated ticks", () => {
    const item = store.createWorkItem({
      title: "failed attempt", status: "assigned", assignee: "platform-worker",
    });
    const sessionId = `s-disagree-${item.id}`;
    db.prepare(
      `INSERT INTO sessions (id, engine, source, source_ref, status, work_item_id, created_at, last_activity)
       VALUES (?, 'claude', 'cron', ?, 'idle', ?, ?, ?)`,
    ).run(sessionId, `cron:${sessionId}`, item.id, new Date().toISOString(), new Date().toISOString());
    const attempt = runs.openWorkItemRun({ workItemId: item.id, sessionId });
    runs.closeWorkItemRun(attempt.id, {
      outcome: "crashed", endedAt: new Date(Date.now() - 20 * 60_000).toISOString(),
      error: "the build step exited with code 1",
    });
    store.appendWorkItemEvent({
      workItemId: item.id, kind: "status_change", fromStatus: "backlog", toStatus: "assigned",
      actor: "operator", detail: { runId: attempt.id }, versionEffect: "audit",
    });
    expect(detect.detectAnomalyFor(item.id)).toBeUndefined();

    tick();
    const classified = rows.getWorkItemRecovery(item.id)!;
    tick();
    expect(rows.getWorkItemRecovery(item.id)).toEqual(classified);
    expect(classified).toMatchObject({ class: "code", lane: "manager", attempts: 0, incidentId: attempt.id, reason: "the attempt failed in the work itself" });

    tick("auto");
    expect(rows.getWorkItemRecovery(item.id)).toMatchObject({ incidentId: attempt.id, attempts: 1 });
    tick("auto");
    expect(rows.getWorkItemRecovery(item.id)).toMatchObject({ incidentId: attempt.id, attempts: 2 });
    expect(store.listWorkItemEvents(item.id)
      .filter((event) => event.kind === "recovery_classified")).toHaveLength(1);
  });
});
