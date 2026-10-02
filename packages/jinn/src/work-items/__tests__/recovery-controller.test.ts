import { beforeAll, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "jinn-wi-recovery-ctl-"));
process.env.JINN_HOME = tmp;

type Store = typeof import("../store.js");
type Runs = typeof import("../runs.js");
type Rows = typeof import("../recovery-rows.js");
type Controller = typeof import("../recovery-controller.js");
type Claims = typeof import("../claims.js");
type Recovery = typeof import("../recovery.js");

let store: Store;
let runs: Runs;
let rows: Rows;
let controller: Controller;
let claims: Claims;
let recovery: Recovery;
let db: import("better-sqlite3").Database;

beforeAll(async () => {
  store = await import("../store.js");
  runs = await import("../runs.js");
  rows = await import("../recovery-rows.js");
  controller = await import("../recovery-controller.js");
  claims = await import("../claims.js");
  recovery = await import("../recovery.js");
  db = (await import("../../shared/db.js")).initDb();
});

function parked(title: string, error: string, outcome: import("../runs.js").TodoRunOutcome = "crashed") {
  const item = store.createWorkItem({ title, status: "blocked", assignee: "platform-worker" });
  const sessionId = `s-${item.id}`;
  db.prepare(
    `INSERT INTO sessions (id, engine, source, source_ref, status, work_item_id, created_at, last_activity)
     VALUES (?, 'claude', 'cron', ?, 'idle', ?, ?, ?)`,
  ).run(sessionId, `cron:${sessionId}`, item.id, new Date().toISOString(), new Date().toISOString());
  const run = runs.openWorkItemRun({ workItemId: item.id, sessionId });
  runs.closeWorkItemRun(run.id, { outcome, endedAt: new Date().toISOString(), error });
  store.appendWorkItemEvent({
    workItemId: item.id, kind: "status_change", fromStatus: "executing", toStatus: "blocked",
    actor: "workflow:run", detail: { workflowId: "pipeline", runId: run.id }, versionEffect: "audit",
  });
  return { id: item.id, runId: run.id };
}

describe("sweepTodoRecovery", () => {
  it("classify-only writes a recovering lane and never rearms", () => {
    const { id } = parked("quota", "Usage limit exceeded; try again at 2026-08-27T12:00:00.000Z", "rate_limited");
    const rearm: string[] = [];
    const result = controller.sweepTodoRecovery({
      mode: "classify-only",
      rearm: (todoId) => { rearm.push(todoId); return { status: "executing" }; },
    });
    expect(result.applied).toBe(0);
    expect(rearm).toHaveLength(0);
    expect(rows.getWorkItemRecovery(id)).toMatchObject({ class: "transient", lane: "recovering", attempts: 0 });
    expect(store.getWorkItem(id)?.status).toBe("blocked");
  });

  it("does not auto-start a backlog Todo", () => {
    const item = store.createWorkItem({ title: "ordinary backlog" });
    const rearm: string[] = [];
    controller.sweepTodoRecovery({
      mode: "auto",
      rearm: (todoId) => { rearm.push(todoId); return { status: "executing" }; },
    });
    expect(rearm).not.toContain(item.id);
    expect(item.status).toBe("backlog");
    expect(rows.getWorkItemRecovery(item.id)).toBeUndefined();
  });

  it("auto rearms a code failure once", () => {
    const { id } = parked("build failed", "the build step exited with code 1");
    const rearm: string[] = [];
    const first = controller.sweepTodoRecovery({
      mode: "auto",
      rearm: (todoId) => { rearm.push(todoId); return { status: "executing" }; },
    });
    expect(first.applied).toBeGreaterThanOrEqual(1);
    expect(rearm).toContain(id);
    expect(rows.getWorkItemRecovery(id)).toMatchObject({ attempts: 1, reason: "scoped repair re-dispatched the Todo" });
  });

  it("holds no claim around the restart, and records no attempt when the restart port declines", () => {
    const { id } = parked("build failed again", "the build step exited with code 1");
    let claimedDuringRestart: boolean | undefined;
    controller.sweepTodoRecovery({
      mode: "auto",
      rearm: (todoId) => {
        // The restart takes its own claim, so the sweep must not be holding one.
        claimedDuringRestart = claims.claimWorkItem({ workItemId: todoId, owner: "restart-port" }).state === "acquired";
        claims.releaseWorkItemClaim(todoId, "restart-port");
        return { unavailable: "a Dispatcher is already running for it" };
      },
    });
    expect(claimedDuringRestart).toBe(true);
    expect(rows.getWorkItemRecovery(id)?.attempts ?? 0).toBe(0);
  });

  it("todoRecoveryMode defaults to classify-only", () => {
    expect(controller.todoRecoveryMode(undefined)).toBe("classify-only");
    expect(controller.todoRecoveryMode("auto")).toBe("auto");
    expect(controller.todoRecoveryMode("always")).toBe("classify-only");
  });

  it("mode off writes no recovery rows for a classifiable blocked Todo", () => {
    const { id } = parked("quota off", "Usage limit exceeded; try again at 2026-08-27T12:00:00.000Z", "rate_limited");
    const result = controller.sweepTodoRecovery({
      mode: "off",
      rearm: () => ({ status: "executing" }),
    });
    expect(result).toEqual({ classified: 0, applied: 0 });
    expect(rows.getWorkItemRecovery(id)).toBeUndefined();
  });

  it("feeds recovering leftovers into the attention query so the dashboard can split them", () => {
    const { id } = parked("quota parked", "Usage limit exceeded; try again at 2026-08-27T12:00:00.000Z", "rate_limited");
    controller.sweepTodoRecovery({ mode: "classify-only", rearm: () => ({ status: "executing" }) });
    expect(rows.getWorkItemRecovery(id)?.lane).toBe("recovering");
    const hits = store.listWorkItems({ needsAttentionFor: "platform-worker" }).map((item) => item.id);
    expect(hits).toContain(id);
  });

  it("feeds recovering leftovers even when the caller is not the assignee", () => {
    const { id } = parked("quota for another worker", "Usage limit exceeded; try again at 2026-08-27T12:00:00.000Z", "rate_limited");
    controller.sweepTodoRecovery({ mode: "classify-only", rearm: () => ({ status: "executing" }) });
    const hits = store.listWorkItems({ needsAttentionFor: "operator" }).map((item) => item.id);
    expect(hits).toContain(id);
  });

  it("does not overwrite an approved-landed-open manager row with the operator fallback", () => {
    const item = store.createWorkItem({
      title: "approved landing leftover", status: "in_review", assignee: "platform-worker",
    });
    const sessionId = `s-mgr-${item.id}`;
    db.prepare(
      `INSERT INTO sessions (id, engine, source, source_ref, status, work_item_id, created_at, last_activity)
       VALUES (?, 'claude', 'cron', ?, 'idle', ?, ?, ?)`,
    ).run(sessionId, `cron:${sessionId}`, item.id, new Date().toISOString(), new Date().toISOString());
    const run = runs.openWorkItemRun({ workItemId: item.id, sessionId });
    runs.closeWorkItemRun(run.id, { outcome: "completed", endedAt: new Date().toISOString() });
    rows.upsertWorkItemRecovery({
      workItemId: item.id,
      incidentId: run.id,
      class: "operator",
      lane: "manager",
      reason: "approved landing is still open",
    });

    controller.sweepTodoRecovery({ mode: "classify-only", rearm: () => ({ status: "executing" }) });

    expect(rows.getWorkItemRecovery(item.id)).toMatchObject({ lane: "manager", incidentId: run.id });
    expect(store.listWorkItems({ needsAttentionFor: "operator" }).map((row) => row.id)).toContain(item.id);
  });

  it("stops re-arming after MAX_RECOVERY_ATTEMPTS and records the exhaustion", () => {
    const { id } = parked("repeatedly failing build", "the build step exited with code 1");
    const rearm: string[] = [];
    const sweep = () => controller.sweepTodoRecovery({
      mode: "auto",
      rearm: (todoId) => { rearm.push(todoId); return { status: "executing" }; },
    });
    sweep();
    expect(rows.getWorkItemRecovery(id)?.attempts).toBe(1);
    sweep();
    expect(rows.getWorkItemRecovery(id)?.attempts).toBe(recovery.MAX_RECOVERY_ATTEMPTS);
    sweep();
    expect(rearm.filter((todoId) => todoId === id)).toHaveLength(recovery.MAX_RECOVERY_ATTEMPTS);
    expect(store.listWorkItemEvents(id).some((event) => event.kind === "recovery_exhausted")).toBe(true);
    expect(rows.getWorkItemRecovery(id)).toMatchObject({ lane: "manager", reason: "automatic repair attempts exhausted" });
  });
});
