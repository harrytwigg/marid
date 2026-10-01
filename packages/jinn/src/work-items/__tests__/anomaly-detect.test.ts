import { beforeAll, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "jinn-wi-anomaly-"));
process.env.JINN_HOME = tmp;

type Store = typeof import("../store.js");
type Runs = typeof import("../runs.js");
type Detect = typeof import("../anomaly-detect.js");
type Controller = typeof import("../recovery-controller.js");
type Rows = typeof import("../recovery-rows.js");

let store: Store;
let runs: Runs;
let detect: Detect;
let controller: Controller;
let rows: Rows;
let db: import("better-sqlite3").Database;

beforeAll(async () => {
  store = await import("../store.js");
  runs = await import("../runs.js");
  detect = await import("../anomaly-detect.js");
  controller = await import("../recovery-controller.js");
  rows = await import("../recovery-rows.js");
  db = (await import("../../shared/db.js")).initDb();
});

/** Records the Todo's move into `executing` and back-dates it, so the quiet clock
 *  the detector reads for a Todo with no session starts that long ago. */
function executingSince(id: string, agoMs: number): void {
  store.appendWorkItemEvent({
    workItemId: id, kind: "status_change", fromStatus: "backlog", toStatus: "executing",
    actor: "operator", versionEffect: "audit",
  });
  db.prepare("UPDATE work_item_events SET created_at = ? WHERE work_item_id = ? AND kind = 'status_change' AND to_status = 'executing'")
    .run(new Date(Date.now() - agoMs).toISOString(), id);
}

describe("detectTodoAnomalies", () => {
  it("creates zero Todos and zero sessions on a healthy board", () => {
    const beforeItems = store.listWorkItems({}).length;
    const beforeSessions = db.prepare("SELECT count(*) AS n FROM sessions").get() as { n: number };
    const healthy = store.createWorkItem({ title: "quiet backlog" });
    const found = detect.detectTodoAnomalies({ now: new Date(), persist: false });
    expect(found.filter((row) => row.workItemId === healthy.id)).toEqual([]);
    expect(store.listWorkItems({}).length).toBe(beforeItems + 1);
    expect((db.prepare("SELECT count(*) AS n FROM sessions").get() as { n: number }).n).toBe(beforeSessions.n);
  });

  it("flags executing-unhanded for an executing Todo with no linked session whose move is over 4h old", () => {
    const item = store.createWorkItem({ title: "executing with nobody", status: "executing", assignee: "platform-worker" });
    executingSince(item.id, 5 * 60 * 60_000);
    expect(db.prepare("SELECT count(*) AS n FROM sessions WHERE work_item_id = ?").get(item.id)).toEqual({ n: 0 });
    expect(detect.detectAnomalyFor(item.id)).toMatchObject({ kind: "executing-unhanded", lane: "manager" });
  });

  it("flags nothing for an executing Todo with no linked session whose move is under 4h old", () => {
    const item = store.createWorkItem({ title: "just started executing", status: "executing", assignee: "platform-worker" });
    executingSince(item.id, 3 * 60 * 60_000);
    expect(detect.detectAnomalyFor(item.id)).toBeUndefined();
  });

  it("flags blocked-without-recovery for a code failure", () => {
    const item = store.createWorkItem({ title: "blocked code", status: "blocked", assignee: "platform-worker" });
    const sessionId = `s-${item.id}`;
    db.prepare(
      `INSERT INTO sessions (id, engine, source, source_ref, status, work_item_id, created_at, last_activity)
       VALUES (?, 'claude', 'cron', ?, 'idle', ?, ?, ?)`,
    ).run(sessionId, `cron:${sessionId}`, item.id, new Date().toISOString(), new Date().toISOString());
    const run = runs.openWorkItemRun({ workItemId: item.id, sessionId });
    runs.closeWorkItemRun(run.id, {
      outcome: "crashed", endedAt: new Date().toISOString(), error: "the build step exited with code 1",
    });
    const found = detect.detectAnomalyFor(item.id);
    expect(found).toMatchObject({ kind: "blocked-without-recovery", lane: "manager" });
  });

  it("puts an in_review Todo with no assignee on Manager attention", () => {
    const item = store.createWorkItem({ title: "in review with nobody to answer for it", status: "in_review" });
    expect(detect.detectAnomalyFor(item.id)).toMatchObject({
      kind: "review-without-reviewer", lane: "manager", reason: "in review with no assignee to answer for it",
    });
    detect.detectTodoAnomalies({ persist: true });
    controller.sweepTodoRecovery({ mode: "classify-only", rearm: () => ({ status: "executing" }) });
    const hits = store.listWorkItems({ needsAttentionFor: "operator" }).map((row) => row.id);
    expect(hits).toContain(item.id);
  });

  it("does not flag an in_review Todo that has an assignee", () => {
    const item = store.createWorkItem({ title: "in review, owned", status: "in_review", assignee: "platform-worker" });
    expect(detect.detectAnomalyFor(item.id)).toBeUndefined();
  });

  it("does not flag an execution-timeout while the session is still in flight", () => {
    const startedAt = new Date(Date.now() - 5 * 60 * 60_000).toISOString();
    const item = store.createWorkItem({ title: "long running", status: "executing" });
    const sessionId = `s-live-${item.id}`;
    db.prepare(
      `INSERT INTO sessions (id, engine, source, source_ref, status, work_item_id, created_at, last_activity)
       VALUES (?, 'claude', 'cron', ?, 'running', ?, ?, ?)`,
    ).run(sessionId, `cron:${sessionId}`, item.id, startedAt, startedAt);
    runs.openWorkItemRun({ workItemId: item.id, sessionId, startedAt });
    expect(detect.detectAnomalyFor(item.id)).toBeUndefined();
  });

  it("never writes a recovery row, and skips the audit event when persist is off", () => {
    const item = store.createWorkItem({ title: "stuck executing off", status: "executing", assignee: "platform-worker" });
    executingSince(item.id, 5 * 60 * 60_000);
    detect.detectTodoAnomalies({ persist: false });
    expect(store.listWorkItemEvents(item.id).some((event) => event.kind === "anomaly_observed")).toBe(false);
    expect(rows.getWorkItemRecovery(item.id)).toBeUndefined();
    expect(detect.detectTodoAnomalies({ persist: true }).some((row) => row.workItemId === item.id)).toBe(true);
    expect(rows.getWorkItemRecovery(item.id)).toBeUndefined();
  });
});
