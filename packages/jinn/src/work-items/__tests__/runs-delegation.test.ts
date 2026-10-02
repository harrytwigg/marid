import { describe, it, expect, beforeAll, vi } from "vitest";
import os from "node:os";
import fs from "node:fs";
import path from "node:path";

// Point the registry DB at a throwaway dir BEFORE importing it (SESSIONS_DB is
// resolved from JINN_HOME at module load). Keeps the suite off the live DB.
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "jinn-wi-runs-delegation-"));
process.env.JINN_HOME = tmp;

type Store = typeof import("../store.js");
type Runs = typeof import("../runs.js");
type Reconcile = typeof import("../reconcile.js");
type Transitions = typeof import("../transitions.js");

let store: Store;
let runs: Runs;
let reconcile: Reconcile;
let transitions: Transitions;
let db: import("better-sqlite3").Database;

type AttemptOutcome = "succeeded" | "failed" | "interrupted";

/** A delegated session carrying its terminal receipt, linked to the Todo. */
function settledSession(id: string, workItemId: string, outcome: AttemptOutcome): void {
  const status = outcome === "succeeded" ? "idle" : outcome === "failed" ? "error" : "interrupted";
  db.prepare(
    `INSERT INTO sessions (id, engine, source, source_ref, status, attempt_outcome, work_item_id, created_at, last_activity)
     VALUES (?, 'claude', 'web', ?, ?, ?, ?, '2026-08-13T09:00:00.000Z', '2026-08-13T09:00:00.000Z')`,
  ).run(id, `delegation:${id}`, status, outcome, workItemId);
}

/** A settled phase session left by the removed Workflow runtime, linked to its Todo. */
function settledPhaseSession(id: string, workItemId: string): void {
  db.prepare(
    `INSERT INTO sessions (id, engine, source, source_ref, status, attempt_outcome, work_item_id,
       workflow_kind, workflow_id, workflow_name, workflow_run_id, workflow_trigger_source,
       workflow_phase_node_id, workflow_phase_name, workflow_phase_index, workflow_phase_round, workflow_phase_attempt,
       created_at, last_activity)
     VALUES (?, 'claude', 'workflow', ?, 'idle', 'succeeded', ?, 'phase', 'pipeline', 'Pipeline', 'run-1', 'workflow',
       'plan', 'Plan', 1, 1, 1, '2026-08-13T09:00:00.000Z', '2026-08-13T09:00:00.000Z')`,
  ).run(id, `workflow:pipeline:run-1:plan:1`, workItemId);
}

beforeAll(async () => {
  store = await import("../store.js");
  runs = await import("../runs.js");
  reconcile = await import("../reconcile.js");
  transitions = await import("../transitions.js");
  db = (await import("../../shared/db.js")).initDb();
});

/** A Todo cancelled while its delegated child was still running, with the child
 *  since settled. The status sweep never revisits it — `cancelled` is sticky. */
function cancelledMidFlight(title: string, sessionId: string): { id: string; runId: string } {
  const item = store.createWorkItem({ title, status: "executing", source: "delegation" });
  const open = runs.openWorkItemRun({ workItemId: item.id, sessionId });
  transitions.transition(item.id, "cancelled", "operator", { human: true, manual: true });
  settledSession(sessionId, item.id, "failed");
  return { id: item.id, runId: open.id };
}

describe("the reconciler settles the run ledger from attempt receipts (ICI-728)", () => {
  it.each([
    ["succeeded", "completed"],
    ["failed", "blocked"],
    ["interrupted", "abandoned"],
  ] as const)("closes the open run as %s → %s", (receipt, outcome) => {
    const item = store.createWorkItem({ title: `settled ${receipt}`, status: "executing", source: "delegation" });
    const sessionId = `s-settle-${receipt}`;
    settledSession(sessionId, item.id, receipt);
    const open = runs.openWorkItemRun({ workItemId: item.id, sessionId });

    reconcile.reconcileWorkItem(item.id);

    const settled = runs.listWorkItemRuns(item.id);
    expect(settled).toHaveLength(1);
    expect(settled[0]).toMatchObject({ id: open.id, outcome });
    expect(settled[0].endedAt).not.toBeNull();
  });

  it("does not reopen or re-close a run on a second pass", () => {
    const item = store.createWorkItem({ title: "idempotent settle", status: "executing", source: "delegation" });
    settledSession("s-settle-twice", item.id, "succeeded");
    runs.openWorkItemRun({ workItemId: item.id, sessionId: "s-settle-twice" });

    reconcile.reconcileWorkItem(item.id);
    const first = runs.listWorkItemRuns(item.id);
    reconcile.reconcileWorkItem(item.id);

    expect(runs.listWorkItemRuns(item.id)).toEqual(first);
  });

  it("leaves a legacy Workflow phase session's run to the startup sweep — its receipt is not this Todo's evidence", () => {
    const item = store.createWorkItem({ title: "phase-bound", status: "executing", source: "human" });
    settledPhaseSession("s-phase-run", item.id);
    runs.openWorkItemRun({ workItemId: item.id, sessionId: "s-phase-run" });

    reconcile.reconcileWorkItem(item.id);

    expect(runs.listWorkItemRuns(item.id)[0]).toMatchObject({ endedAt: null, outcome: null });
  });

  it("is unbothered by a settled session that never opened a run", () => {
    const item = store.createWorkItem({ title: "no ledger row", status: "executing", source: "delegation" });
    settledSession("s-no-run", item.id, "succeeded");

    expect(reconcile.reconcileWorkItem(item.id)?.item.status).toBe("executing");
    expect(runs.listWorkItemRuns(item.id)).toEqual([]);
  });
});

describe("the startup sweep settles orphaned runs (ICI-728)", () => {
  it("closes a run whose session no longer exists as crashed", () => {
    const item = store.createWorkItem({ title: "vanished session", status: "executing", source: "delegation" });
    const open = runs.openWorkItemRun({ workItemId: item.id, sessionId: "s-vanished" });

    reconcile.reconcileWorkItemsOnStartup();

    const settled = runs.listWorkItemRuns(item.id);
    expect(settled[0]).toMatchObject({ id: open.id, outcome: "crashed" });
    expect(settled[0].endedAt).not.toBeNull();
    expect(settled[0].error).toMatch(/session/i);
  });

  it("returns the status-change count, which an orphan repair does not inflate", () => {
    const item = store.createWorkItem({ title: "orphan only", status: "backlog", source: "delegation" });
    runs.openWorkItemRun({ workItemId: item.id, sessionId: "s-orphan-only" });

    expect(reconcile.reconcileWorkItemsOnStartup()).toBe(0);
    expect(runs.listWorkItemRuns(item.id)[0].outcome).toBe("crashed");
  });
});

describe("both sweeps close a run the status sweep will never reach (ICI-728)", () => {
  it("closes a cancelled Todo's run with its child's outcome on the periodic tick", () => {
    const item = cancelledMidFlight("cancelled, child still running", "s-cancelled-periodic");

    vi.useFakeTimers();
    const stop = reconcile.startWorkItemReconciler(20);
    vi.advanceTimersByTime(20);
    stop();
    vi.useRealTimers();

    const settled = runs.listWorkItemRuns(item.id);
    expect(settled[0]).toMatchObject({ id: item.runId, outcome: "blocked" });
    expect(settled[0].endedAt).not.toBeNull();
  });

  it("closes it on the startup sweep too", () => {
    const item = cancelledMidFlight("cancelled, gateway restarted", "s-cancelled-startup");

    reconcile.reconcileWorkItemsOnStartup();

    expect(runs.listWorkItemRuns(item.id)[0]).toMatchObject({ id: item.runId, outcome: "blocked" });
  });

  // Nothing runs a phase any more, so nothing else would close its run: an open
  // one would read as an attempt still going on that Todo forever.
  it("closes a settled legacy Workflow phase's run in the same sweep that closes a delegated one", () => {
    const delegated = cancelledMidFlight("cancelled alongside a phase", "s-cancelled-beside-phase");
    const phase = store.createWorkItem({ title: "phase-bound, swept", status: "executing", source: "human" });
    settledPhaseSession("s-phase-sweep", phase.id);
    const phaseRun = runs.openWorkItemRun({ workItemId: phase.id, sessionId: "s-phase-sweep" });

    reconcile.reconcileWorkItemsOnStartup();

    expect(runs.listWorkItemRuns(delegated.id)[0]).toMatchObject({ id: delegated.runId, outcome: "blocked" });
    expect(runs.listWorkItemRuns(phase.id)[0]).toMatchObject({ id: phaseRun.id, endedAt: expect.any(String) });
  });
});
