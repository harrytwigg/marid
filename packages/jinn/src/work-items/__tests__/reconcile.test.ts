import { describe, it, expect, beforeAll } from "vitest";
import os from "node:os";
import fs from "node:fs";
import path from "node:path";

// Point the registry DB at a throwaway dir BEFORE importing it (SESSIONS_DB is
// resolved from JINN_HOME at module load). Keeps the suite off the live DB.
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "jinn-wi-reconcile-"));
process.env.JINN_HOME = tmp;

type Store = typeof import("../store.js");
type Reconcile = typeof import("../reconcile.js");
type Transitions = typeof import("../transitions.js");
type EventLog = typeof import("../event-log.js");
type AttemptEvidence = typeof import("../attempt-evidence.js");

let store: Store;
let reconcile: Reconcile;
let tr: Transitions;
let eventLog: EventLog;
let attemptEvidence: AttemptEvidence;
let db: import("better-sqlite3").Database;

type SessionStatus = "idle" | "running" | "error" | "waiting" | "interrupted";
type AttemptOutcome = "succeeded" | "failed" | "interrupted" | null;

function evidence(status: SessionStatus, outcome: AttemptOutcome = status === "idle" ? "succeeded" : status === "error" ? "failed" : status === "interrupted" ? "interrupted" : null) {
  return { status, outcome };
}

/** Insert a session in a given status and link it to a work item. `at` sets last_activity
 *  so newest-first ordering in listSessionsByWorkItem is deterministic. */
function linkedSession(id: string, workItemId: string, status: SessionStatus, at: string, outcome: AttemptOutcome = evidence(status).outcome): void {
  db.prepare(
    `INSERT INTO sessions (id, engine, source, source_ref, status, attempt_outcome, work_item_id, created_at, last_activity)
     VALUES (?, 'claude', 'cron', ?, ?, ?, ?, ?, ?)`,
  ).run(id, `cron:${id}`, status, outcome, workItemId, at, at);
}

/** A session of an employee linked to a work item in the given role. */
function roleSession(id: string, workItemId: string, who: { role: "execute" | "consult"; employee: string }, state: { status: SessionStatus; at: string; outcome?: AttemptOutcome }): void {
  const { role, employee } = who;
  const { status, at, outcome = evidence(status).outcome } = state;
  db.prepare(
    `INSERT INTO sessions (id, engine, source, source_ref, status, attempt_outcome, work_item_id, work_item_role, employee, created_at, last_activity)
     VALUES (?, 'claude', 'web', ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(id, `web:${id}`, status, outcome, workItemId, role, employee, at, at);
}

/** A Workflow phase session linked to the run's bound Todo, carrying what it cost. */
function phaseSession(id: string, workItemId: string, status: SessionStatus, at: string, cost: number): void {
  db.prepare(
    `INSERT INTO sessions (id, engine, source, source_ref, status, attempt_outcome, work_item_id, total_cost,
       workflow_kind, workflow_id, workflow_name, workflow_run_id, workflow_trigger_source,
       workflow_phase_node_id, workflow_phase_name, workflow_phase_index, workflow_phase_round, workflow_phase_attempt,
       created_at, last_activity)
     VALUES (?, 'claude', 'workflow', ?, ?, ?, ?, ?, 'phase', 'pipeline', 'Pipeline', 'run-1', 'workflow',
       'plan', 'Plan', 1, 1, 1, ?, ?)`,
  ).run(id, `workflow:pipeline:run-1:plan:1`, status, evidence(status).outcome, workItemId, cost, at, at);
}

beforeAll(async () => {
  store = await import("../store.js");
  reconcile = await import("../reconcile.js");
  tr = await import("../transitions.js");
  eventLog = await import("../event-log.js");
  attemptEvidence = await import("../attempt-evidence.js");
  db = (await import("../../shared/db.js")).initDb();
});

describe("deriveWorkItemStatus — pure truth table (GRS-021a elevated vocabulary)", () => {
  const D = () => (
    current: Parameters<Reconcile["deriveWorkItemStatus"]>[0],
    statuses: SessionStatus[],
    source?: Parameters<Reconcile["deriveWorkItemStatus"]>[2],
  ) => reconcile.deriveWorkItemStatus(current, statuses.map((status) => evidence(status)), source);

  it("keeps sticky terminals (done/cancelled) regardless of session evidence", () => {
    expect(D()("done", ["running"])).toBe("done");
    expect(D()("done", ["error", "interrupted"])).toBe("done");
    expect(D()("cancelled", ["idle"])).toBe("cancelled");
  });

  it("keeps a DECLARED block (an escalation is one) regardless of session evidence", () => {
    const declared = { blockDeclared: true };
    const derive = (statuses: SessionStatus[]) =>
      reconcile.deriveWorkItemStatus("blocked", statuses.map((status) => evidence(status)), undefined, declared);
    expect(derive(["running"])).toBe("blocked"); // operator queue never silently drained
    expect(derive(["idle"])).toBe("blocked");
  });

  it("leaves an item with NO linked sessions untouched (no evidence — backlog safe)", () => {
    expect(D()("backlog", [])).toBe("backlog");
    expect(D()("executing", [])).toBe("executing");
    expect(D()("blocked", [])).toBe("blocked");
  });

  it("is executing when any linked session is in flight (running/waiting)", () => {
    expect(D()("backlog", ["running"])).toBe("executing");
    expect(D()("blocked", ["waiting"])).toBe("executing");
    expect(D()("backlog", ["interrupted", "running"])).toBe("executing");
    expect(D()("blocked", ["error", "waiting"])).toBe("executing");
  });

  it("does not regress a reviewed Todo to executing because a linked session is active", () => {
    expect(D()("in_review", ["running"], "delegation")).toBe("in_review");
    expect(D()("in_review", ["waiting", "idle"], "delegation")).toBe("in_review");
  });

  it("does not treat conversational idle without a successful terminal receipt as completed work", () => {
    expect(reconcile.deriveWorkItemStatus("executing", [evidence("idle", null)])).toBe("executing");
    expect(reconcile.deriveWorkItemStatus("backlog", [evidence("idle", null)])).toBe("backlog");
  });

  it("is blocked when the NEWEST attempt failed, even if an older attempt settled idle", () => {
    expect(D()("executing", ["error", "idle"])).toBe("blocked");
    expect(D()("executing", ["interrupted", "idle"])).toBe("blocked");
    expect(D()("executing", ["interrupted"])).toBe("blocked");
    expect(D()("backlog", ["error", "interrupted"])).toBe("blocked");
  });

  it("in-flight anywhere trumps a newer terminal state", () => {
    expect(D()("backlog", ["error", "running"])).toBe("executing");
    expect(D()("blocked", ["interrupted", "waiting"])).toBe("executing");
  });

  it("gives historical Workflow provenance no special lifecycle semantics", () => {
    expect(D()("executing", ["running"], "workflow")).toBe("executing");
    expect(D()("backlog", ["running"], "workflow")).toBe("executing");
    expect(D()("executing", ["idle"], "workflow")).toBe("executing");
    expect(D()("executing", ["interrupted"], "workflow")).toBe("blocked");
    expect(D()("backlog", ["idle"], "workflow")).toBe("backlog");
  });
});

describe("reconcileWorkItem — integration against real store + registry", () => {
  it("returns undefined for an unknown id", () => {
    expect(reconcile.reconcileWorkItem("JIN-999")).toBeUndefined();
  });

  it("treats a historical Workflow Todo as audit-only in direct reconciliation", () => {
    const wi = store.createWorkItem({
      title: "historical workflow audit",
      status: "executing",
      source: "workflow",
      sourceRef: "workflow:legacy:run-1",
    });
    linkedSession("s-workflow-direct", wi.id, "idle", "2026-07-01T00:00:00.000Z");
    const beforeEvents = store.listWorkItemEvents(wi.id);

    expect(reconcile.reconcileWorkItem(wi.id)).toMatchObject({
      changed: false,
      item: { status: "executing", source: "workflow" },
    });
    expect(store.listWorkItemEvents(wi.id)).toEqual(beforeEvents);
  });

  it("never TRUST-closes a historical Workflow Todo already sitting in review", () => {
    const wi = store.createWorkItem({
      title: "historical workflow review",
      status: "in_review",
      source: "workflow",
      sourceRef: "workflow:legacy:run-2",
    });
    linkedSession("s-workflow-review", wi.id, "idle", "2026-07-01T00:00:00.000Z");

    expect(reconcile.reconcileWorkItem(wi.id)).toMatchObject({ changed: false, item: { status: "in_review" } });
    expect(store.getWorkItem(wi.id)?.status).toBe("in_review");
  });

  it("continues normal reconciliation after an operator manually starts an item", () => {
    const wi = store.createWorkItem({ title: "manual start", status: "backlog", source: "human" });
    tr.transition(wi.id, "executing", "operator", { human: true, manual: true });
    linkedSession("s-manual-start", wi.id, "running", new Date(Date.now() + 60_000).toISOString()); // the attempt runs AFTER his dispatch, or it is not evidence about it

    expect(reconcile.reconcileWorkItem(wi.id)).toMatchObject({ changed: false, item: { status: "executing" } });

    db.prepare("UPDATE sessions SET status = 'idle', attempt_outcome = 'succeeded' WHERE id = ?").run("s-manual-start");
    expect(reconcile.reconcileWorkItem(wi.id)).toMatchObject({ changed: false, item: { status: "executing" } });
    expect(store.listWorkItemEvents(wi.id).filter((event) => event.kind === "status_change").map((event) => ({
      from: event.fromStatus,
      to: event.toStatus,
      actor: event.actor,
    }))).toEqual([
      { from: "backlog", to: "executing", actor: "operator" },
    ]);
  });

  it("moves executing → blocked when its only session was interrupted (the split-brain case)", () => {
    const wi = store.createWorkItem({ title: "delegated fix", status: "executing", source: "delegation", sourceRef: "delegate:j1:1" });
    linkedSession("s-int-1", wi.id, "interrupted", "2026-07-01T00:00:00.000Z");

    const r = reconcile.reconcileWorkItem(wi.id);
    expect(r?.changed).toBe(true);
    expect(r?.item.status).toBe("blocked");
    // The derived move is event-audited through the guarded transitions.
    const last = store.listWorkItemEvents(wi.id).at(-1)!;
    expect(last).toMatchObject({ kind: "status_change", fromStatus: "executing", toStatus: "blocked", actor: "reconciler" });
  });

  it("VERIFY-tier settle STAYS executing: a producer's run ending is not the work finishing", () => {
    const wi = store.createWorkItem({ title: "delegation settled", status: "executing", source: "delegation", sourceRef: "delegate:j2:1" });
    linkedSession("s-ok-2", wi.id, "idle", "2026-07-01T01:00:00.000Z");

    expect(reconcile.reconcileWorkItem(wi.id)).toMatchObject({ changed: false, item: { status: "executing" } });
    // Repeated passes (the sweep runs every 20s) never promote it either.
    expect(reconcile.reconcileWorkItem(wi.id)?.changed).toBe(false);
    expect(store.getWorkItem(wi.id)?.status).toBe("executing");
    expect(store.listWorkItemEvents(wi.id).filter((event) => event.kind === "status_change")).toEqual([]);
  });

  it("keeps a delegated in_review Todo in review while its linked callback session is running", () => {
    const wi = store.createWorkItem({
      title: "review callback",
      status: "in_review",
      source: "delegation",
      sourceRef: "delegate:reviewer:callback",
    });
    linkedSession("s-review-callback", wi.id, "running", "2026-07-01T01:30:00.000Z");

    const result = reconcile.reconcileWorkItem(wi.id);
    expect(result?.changed).toBe(false);
    expect(result?.item.status).toBe("in_review");
    expect(store.listWorkItemEvents(wi.id).filter((event) => event.toStatus === "executing")).toHaveLength(0);
  });

  it("keeps an agent-declared block while its linked session is still running", () => {
    const wi = store.createWorkItem({ title: "declared blocker", status: "executing", source: "delegation" });
    linkedSession("s-declared-block", wi.id, "running", "2026-07-01T01:45:00.000Z");
    tr.transition(wi.id, "blocked", "platform-engineer", {
      detail: { note: "operator input required" },
    });

    expect(reconcile.reconcileWorkItem(wi.id)).toMatchObject({
      changed: false,
      item: { status: "blocked" },
    });
    expect(store.getWorkItem(wi.id)?.status).toBe("blocked");
  });

  it("keeps a review bounce executing when the newest attempt receipt succeeded", () => {
    const wi = store.createWorkItem({ title: "review bounce", status: "in_review", source: "delegation" });
    linkedSession("s-review-bounce", wi.id, "idle", "2026-07-01T01:50:00.000Z", "succeeded");
    tr.transition(wi.id, "executing", "reviewer", {
      bounce: true,
      detail: { critique: "address the review finding" },
    });

    expect(reconcile.reconcileWorkItem(wi.id)).toMatchObject({
      changed: false,
      item: { status: "executing" },
    });
    expect(store.getWorkItem(wi.id)?.status).toBe("executing");
  });

  it("TRUST-tier settle auto-closes: executing → in_review → done in ONE pass, both event-audited", () => {
    const wi = store.createWorkItem({ title: "cron fire", status: "executing", source: "cron", sourceRef: "cron:j3:1" });
    linkedSession("s-ok-3", wi.id, "idle", "2026-07-01T01:00:00.000Z");

    const r = reconcile.reconcileWorkItem(wi.id);
    expect(r?.changed).toBe(true);
    expect(r?.item.status).toBe("done");
    expect(r?.item.closedAt).not.toBeNull();
    const kinds = store.listWorkItemEvents(wi.id).map((e) => `${e.fromStatus}→${e.toStatus}:${e.actor}`);
    expect(kinds).toContain("executing→in_review:reconciler");
    expect(kinds).toContain("in_review→done:policy:trust");
  });

  it("ignores a legacy verify_policy left in the column: a cron item still auto-closes", () => {
    const wi = store.createWorkItem({ title: "legacy reviewed cron", status: "executing", source: "cron", sourceRef: "cron:j3b:1" });
    db.prepare("UPDATE work_items SET verify_policy = ? WHERE id = ?").run('{"mode":"verify"}', wi.id);
    linkedSession("s-ok-3b", wi.id, "idle", "2026-07-01T01:00:00.000Z");
    expect(reconcile.reconcileWorkItem(wi.id)?.item.status).toBe("done");
  });

  it("ignores a legacy trust verify_policy on a non-cron item: it stays with its producer", () => {
    const wi = store.createWorkItem({ title: "legacy trusted human", status: "executing", source: "delegation", sourceRef: "delegate:j3d:1" });
    db.prepare("UPDATE work_items SET verify_policy = ? WHERE id = ?").run('{"mode":"trust"}', wi.id);
    linkedSession("s-ok-3d", wi.id, "idle", "2026-07-01T01:00:00.000Z");
    expect(reconcile.reconcileWorkItem(wi.id)?.item.status).toBe("executing");
  });

  it("a pre-existing in_review TRUST item closes on the next sweep pass (hook fires on sitting items too)", () => {
    const wi = store.createWorkItem({ title: "stranded trust", status: "in_review", source: "cron", sourceRef: "cron:j3c:1" });
    linkedSession("s-ok-3c", wi.id, "idle", "2026-07-01T01:00:00.000Z");
    const r = reconcile.reconcileWorkItem(wi.id);
    expect(r?.item.status).toBe("done");
  });

  it("moves executing → blocked when a NEWER attempt failed after an older idle (recency wins)", () => {
    const wi = store.createWorkItem({ title: "regressed", status: "executing", source: "delegation", sourceRef: "delegate:j4:1" });
    linkedSession("s-ok-4", wi.id, "idle", "2026-07-01T00:00:00.000Z");
    linkedSession("s-int-4", wi.id, "interrupted", "2026-07-01T01:00:00.000Z");

    expect(reconcile.reconcileWorkItem(wi.id)?.item.status).toBe("blocked");
  });

  it("is a no-op when derived status already matches (no write, no updated_at churn)", () => {
    const wi = store.createWorkItem({ title: "steady", status: "executing", source: "cron", sourceRef: "cron:j5:1" });
    linkedSession("s-run-5", wi.id, "running", "2026-07-01T00:00:00.000Z");
    const before = store.getWorkItem(wi.id)!.updatedAt;

    const r = reconcile.reconcileWorkItem(wi.id);
    expect(r?.changed).toBe(false);
    expect(store.getWorkItem(wi.id)?.updatedAt).toBe(before);
  });

  it("keeps done sticky even though its session errored; keeps a declared escalation blocked through churn", () => {
    const done = store.createWorkItem({ title: "finished", status: "done", source: "cron", sourceRef: "cron:j6:1" });
    linkedSession("s-err-6", done.id, "error", "2026-07-01T00:00:00.000Z");
    expect(reconcile.reconcileWorkItem(done.id)?.changed).toBe(false);
    expect(store.getWorkItem(done.id)?.status).toBe("done");

    const esc = store.createWorkItem({ title: "with operator", status: "executing", source: "delegation", sourceRef: "delegate:j7:1" });
    tr.transition(esc.id, "blocked", "session:agent-1", { agent: true, detail: { declared: true } });
    linkedSession("s-idle-7", esc.id, "idle", "2026-07-01T00:00:00.000Z");
    expect(reconcile.reconcileWorkItem(esc.id)?.changed).toBe(false);
    expect(store.getWorkItem(esc.id)?.status).toBe("blocked");
  });

  it("leaves an item with no linked sessions untouched (an owned backlog Todo is never clobbered)", () => {
    const wi = store.createWorkItem({ title: "unlinked", status: "backlog", assignee: "ana", source: "human" });
    expect(reconcile.reconcileWorkItem(wi.id)?.changed).toBe(false);
    expect(store.getWorkItem(wi.id)?.status).toBe("backlog");
  });

  it("counts a linked Workflow phase session's spend without deriving the Todo from it", () => {
    const wi = store.createWorkItem({ title: "workflow-bound", status: "executing", source: "human" });
    phaseSession("s-phase-1", wi.id, "idle", "2026-07-01T00:00:00.000Z", 4.5);

    // Spend rolls up: that is the whole point of linking the phase session.
    expect(store.getWorkItemSpend(wi.id)).toBeCloseTo(4.5);
    // Status does not: the RUN decides when the pipeline is finished, so one
    // settled phase must not move the Todo to in_review with phases still to go.
    expect(reconcile.reconcileWorkItem(wi.id)?.changed).toBe(false);
    expect(store.getWorkItem(wi.id)?.status).toBe("executing");
  });

  it("still derives from a delegation session that shares the Todo with a phase session", () => {
    const wi = store.createWorkItem({ title: "mixed evidence", status: "executing", source: "delegation", sourceRef: "delegate:m1:1" });
    phaseSession("s-phase-2", wi.id, "idle", "2026-07-01T02:00:00.000Z", 2);
    linkedSession("s-delegated-2", wi.id, "interrupted", "2026-07-01T01:00:00.000Z");

    // Newest-first ordering puts the phase session at index 0; ignoring it must
    // leave the delegated attempt as the authority, not silence the evidence.
    expect(reconcile.reconcileWorkItem(wi.id)?.changed).toBe(true);
    expect(store.getWorkItem(wi.id)?.status).toBe("blocked");
    expect(store.getWorkItemSpend(wi.id)).toBeCloseTo(2);
  });
});

describe("reconcileWorkItem — the assignee's declared resume of a stopped Todo", () => {
  const FAILED_AT = "2026-11-08T13:00:00.000Z";
  const later = (ms: number) => new Date(Date.now() + ms).toISOString();

  /** A Todo whose only execute attempt ended badly and was blocked by it, then
   *  moved to executing by a session of its assignee that is not linked as an
   *  execution attempt (a stand-in for one the route could not link as executor). */
  function resumedByAssignee(title: string, mover = "dev"): string {
    const wi = store.createWorkItem({ title, status: "executing", source: "session", assignee: "dev" });
    roleSession(`s-${title}-dispatch`, wi.id, { role: "execute", employee: "todo-dispatcher" }, { status: "interrupted", at: FAILED_AT });
    expect(reconcile.reconcileWorkItem(wi.id)).toMatchObject({ changed: true, item: { status: "blocked" } });
    roleSession(`s-${title}-mover`, wi.id, { role: "consult", employee: mover }, { status: "running", at: later(1_000) });
    tr.transition(wi.id, "executing", `session:s-${title}-mover`);
    return wi.id;
  }

  it("keeps the declared move against an older failed execute attempt, across passes, with no escalation", () => {
    const id = resumedByAssignee("resume-keep");

    expect(reconcile.reconcileWorkItem(id)).toMatchObject({ changed: false, item: { status: "executing" } });
    expect(reconcile.reconcileWorkItem(id)).toMatchObject({ changed: false, item: { status: "executing" } });
    expect(store.listWorkItemEvents(id).filter((event) => event.kind === "escalated")).toHaveLength(0);
    expect(store.listWorkItemEvents(id).filter((event) => event.actor === "reconciler" && event.toStatus === "blocked")).toHaveLength(1);
  });

  it("still blocks the Todo when an execute attempt that ran after the declaration failed", () => {
    const id = resumedByAssignee("resume-then-fail");
    roleSession("s-resume-then-fail-retry", id, { role: "execute", employee: "dev" }, { status: "error", at: later(60_000) });

    expect(reconcile.reconcileWorkItem(id)).toMatchObject({ changed: true, item: { status: "blocked" } });
  });

  it("does not protect a declared move by somebody who is not the assignee", () => {
    const id = resumedByAssignee("resume-stranger", "someone-else");

    expect(reconcile.reconcileWorkItem(id)).toMatchObject({ changed: true, item: { status: "blocked" } });
  });

  it("stops protecting the move once the Todo is assigned to somebody else", () => {
    const id = resumedByAssignee("resume-reassigned");
    db.prepare("UPDATE work_items SET assignee = 'other-dev' WHERE id = ?").run(id);

    expect(reconcile.reconcileWorkItem(id)).toMatchObject({ changed: true, item: { status: "blocked" } });
  });

  it("lets a derived resume fall back to ordinary derivation, since only the declaration is protected", () => {
    const id = resumedByAssignee("resume-derived");
    roleSession("s-resume-derived-fail", id, { role: "execute", employee: "dev" }, { status: "error", at: later(60_000) });
    expect(reconcile.reconcileWorkItem(id)).toMatchObject({ changed: true, item: { status: "blocked" } });

    roleSession("s-resume-derived-ok", id, { role: "execute", employee: "dev" }, { status: "idle", at: later(120_000), outcome: "succeeded" });
    expect(reconcile.reconcileWorkItem(id)).toMatchObject({ changed: true, item: { status: "executing" } });
    // The resume was the reconciler's, so a later failure derives blocked again.
    roleSession("s-resume-derived-fail2", id, { role: "execute", employee: "dev" }, { status: "error", at: later(180_000) });
    expect(reconcile.reconcileWorkItem(id)).toMatchObject({ changed: true, item: { status: "blocked" } });
  });

  it("does not protect a move out of review (a bounce has its own guard)", () => {
    const wi = store.createWorkItem({ title: "resume-from-review", status: "in_review", source: "session", assignee: "dev" });
    roleSession("s-resume-from-review", wi.id, { role: "consult", employee: "dev" }, { status: "running", at: later(1_000) });
    tr.transition(wi.id, "executing", "session:s-resume-from-review");

    expect(eventLog.latestAssigneeExecutingDeclaredAt(wi.id, "dev", () => "dev")).toBeUndefined();
  });

  it("applies the floor only while the Todo is executing", () => {
    const id = resumedByAssignee("resume-not-executing");
    const sessionsView = (status?: "executing" | "blocked") => attemptEvidence.collectAttemptEvidence(id, status ? { status, assignee: "dev" } : undefined).attempts;

    expect(sessionsView("executing")).toHaveLength(0);
    expect(sessionsView("blocked")).toHaveLength(1);
    expect(sessionsView()).toHaveLength(1);
  });
});

describe("reconcileActiveWorkItems / startup sweep — the recoverStaleSessions moment", () => {
  it("keeps historical Workflow Todos audit-only during startup reconciliation", () => {
    const wi = store.createWorkItem({
      title: "workflow startup audit",
      status: "executing",
      source: "workflow",
      sourceRef: "workflow:legacy:startup",
    });
    linkedSession("s-workflow-startup", wi.id, "interrupted", "2026-07-01T01:59:00.000Z");

    reconcile.reconcileWorkItemsOnStartup();

    expect(store.getWorkItem(wi.id)?.status).toBe("executing");
    expect(store.listWorkItemEvents(wi.id).filter((event) => event.actor === "reconciler")).toHaveLength(0);
  });

  it("sweeps non-sticky items (incl. in_review) and skips done/cancelled", () => {
    const dying = store.createWorkItem({ title: "sweep-dying", status: "executing", source: "cron", sourceRef: "cron:sw1:1" });
    linkedSession("s-sw-int", dying.id, "interrupted", "2026-07-01T02:00:00.000Z");
    const closed = store.createWorkItem({ title: "sweep-closed", status: "done", source: "cron", sourceRef: "cron:sw2:1" });
    linkedSession("s-sw-err", closed.id, "error", "2026-07-01T02:00:00.000Z");

    const result = reconcile.reconcileActiveWorkItems();
    expect(result.checked).toBeGreaterThanOrEqual(1);
    expect(result.changed).toBeGreaterThanOrEqual(1);

    expect(store.getWorkItem(dying.id)?.status).toBe("blocked");
    expect(store.getWorkItem(closed.id)?.status).toBe("done"); // sticky, untouched
  });

  it("reconcileWorkItemsOnStartup returns the change count and never throws", () => {
    const changed = reconcile.reconcileWorkItemsOnStartup();
    expect(typeof changed).toBe("number");
    expect(changed).toBeGreaterThanOrEqual(0);
  });

  it("startWorkItemReconciler ticks a sweep and stops cleanly", async () => {
    const wi = store.createWorkItem({ title: "periodic", status: "executing", source: "cron", sourceRef: "cron:tick:1" });
    linkedSession("s-tick-1", wi.id, "idle", "2026-07-01T03:00:00.000Z");
    const stop = reconcile.startWorkItemReconciler(20);
    await new Promise((r) => setTimeout(r, 80));
    stop();
    // trust-tier cron item settled → the periodic sweep closed it without a boot.
    expect(store.getWorkItem(wi.id)?.status).toBe("done");
  });

  it("keeps historical Workflow Todos audit-only during periodic reconciliation", async () => {
    const wi = store.createWorkItem({
      title: "workflow periodic audit",
      status: "executing",
      source: "workflow",
      sourceRef: "workflow:legacy:periodic",
    });
    linkedSession("s-workflow-periodic", wi.id, "idle", "2026-07-01T03:30:00.000Z");
    const stop = reconcile.startWorkItemReconciler(20);
    await new Promise((resolve) => setTimeout(resolve, 80));
    stop();

    expect(store.getWorkItem(wi.id)?.status).toBe("executing");
    expect(store.listWorkItemEvents(wi.id).filter((event) => event.actor === "reconciler" || event.actor === "policy:trust")).toHaveLength(0);
  });
});

describe("live todo events from the reconciler", () => {
  it("emits one event when reconcile changes status, none when it no-ops", async () => {
    const live = await import("../live-events.js");
    const events: Array<Record<string, unknown>> = [];
    live.setTodoLiveEmitter((event) => events.push(event as unknown as Record<string, unknown>));
    try {
      const item = store.createWorkItem({ title: "live reconcile item" });
      linkedSession("live-rec-1", item.id, "running", "2026-07-24T10:00:00.000Z");
      const first = reconcile.reconcileWorkItem(item.id);
      expect(first?.changed).toBe(true);
      expect(events).toContainEqual(expect.objectContaining({ entity: "todo", action: "status-transitioned", id: item.id }));
      expect(events).toHaveLength(1);

      events.length = 0;
      const second = reconcile.reconcileWorkItem(item.id);
      expect(second?.changed).toBe(false);
      expect(events).toEqual([]);
    } finally {
      live.setTodoLiveEmitter(null);
    }
  });
});
