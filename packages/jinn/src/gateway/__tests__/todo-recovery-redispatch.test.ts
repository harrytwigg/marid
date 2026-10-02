import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ApiContext } from "../api.js";

/**
 * Todo recovery in `auto` mode restarts a code failure through the same port the
 * availability sweep uses. These run the real registry, run ledger, reconciler
 * and recovery sweep; only the Dispatcher's session spawn is stubbed.
 */

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "jinn-todo-recovery-redispatch-"));
process.env.JINN_HOME = tmp;

const startTodoDispatcher = vi.hoisted(() => vi.fn());
vi.mock("../todo-dispatch.js", () => ({ startTodoDispatcher }));

type Store = typeof import("../../work-items/store.js");
type Registry = typeof import("../../sessions/registry.js");
type Runs = typeof import("../../work-items/runs.js");
type Reconcile = typeof import("../../work-items/reconcile.js");
type Controller = typeof import("../../work-items/recovery-controller.js");
type Recovery = typeof import("../../work-items/recovery.js");
type Transitions = typeof import("../../work-items/transitions.js");
type Redispatch = typeof import("../todo-redispatch.js");

let store: Store;
let registry: Registry;
let runs: Runs;
let reconcile: Reconcile;
let controller: Controller;
let recovery: Recovery;
let transitions: Transitions;
let redispatchTodo: Redispatch["redispatchTodo"];
let db: import("better-sqlite3").Database;

const context = {} as unknown as ApiContext;

beforeAll(async () => {
  store = await import("../../work-items/store.js");
  registry = await import("../../sessions/registry.js");
  runs = await import("../../work-items/runs.js");
  reconcile = await import("../../work-items/reconcile.js");
  controller = await import("../../work-items/recovery-controller.js");
  recovery = await import("../../work-items/recovery.js");
  transitions = await import("../../work-items/transitions.js");
  ({ redispatchTodo } = await import("../todo-redispatch.js"));
  db = (await import("../../shared/db.js")).initDb();
});

afterAll(async () => {
  (await import("../../shared/db.js")).__closeDbForTest();
  fs.rmSync(tmp, { recursive: true, force: true });
});

beforeEach(() => {
  db.exec("DELETE FROM work_item_runs; DELETE FROM sessions;");
  startTodoDispatcher.mockReset();
  startTodoDispatcher.mockImplementation((item: { id: string }) => ({
    ok: true, status: 201, body: { workItemId: item.id, sessionId: `sess-${item.id}`, status: "running", reused: false },
  }));
});

const autoSweep = (now?: Date) => controller.sweepTodoRecovery({
  mode: "auto",
  rearm: (id) => redispatchTodo(id, context, "This is a restart."),
  ...(now ? { now: () => now } : {}),
});

const dispatchedIds = () => startTodoDispatcher.mock.calls.map(([item]) => (item as { id: string }).id);

function failedInTheWork(title: string, { parkedBy }: { parkedBy?: string } = {}) {
  const item = store.createWorkItem({ title, source: "delegation", status: "executing", assignee: "platform-worker" });
  if (parkedBy) transitions.transition(item.id, "blocked", parkedBy);
  const session = registry.createSession({ engine: "claude", source: "delegation", sourceRef: `d:${title}`, employee: "platform-worker" });
  store.linkSession(item.id, session.id);
  runs.openWorkItemRun({ workItemId: item.id, sessionId: session.id });
  registry.updateSession(session.id, { status: "error", attemptOutcome: "failed", lastError: "the test suite failed: 3 assertions" });
  reconcile.reconcileWorkItem(item.id);
  return item.id;
}

describe("auto recovery through the Dispatcher", () => {
  it("restarts a Todo the reconciler blocked after its attempt failed in the work", () => {
    const id = failedInTheWork("broken build");
    expect(store.getWorkItem(id)?.status).toBe("blocked");

    autoSweep();

    expect(dispatchedIds().filter((dispatched) => dispatched === id)).toHaveLength(1);
  });

  it("leaves a block someone declared alone", () => {
    const id = failedInTheWork("parked, then broken", { parkedBy: "operator" });

    autoSweep();

    expect(dispatchedIds()).not.toContain(id);
  });
});

describe("a Todo only a legacy Workflow phase was working", () => {
  function phaseOnly(source: "human" | "workflow") {
    const item = store.createWorkItem({ title: `phase-only ${source}`, source, status: "backlog", assignee: "platform-worker" });
    transitions.transition(item.id, "executing", "reconciler");
    const phase = registry.createSession({ engine: "claude", source: "workflow", sourceRef: `wf:${source}`, employee: "platform-worker" });
    db.prepare("UPDATE sessions SET status = 'running', workflow_kind = 'phase' WHERE id = ?").run(phase.id);
    store.linkSession(item.id, phase.id);
    runs.openWorkItemRun({ workItemId: item.id, sessionId: phase.id });
    registry.settleLegacyWorkflowPhaseSessions();
    return item.id;
  }

  it.each(["human", "workflow"] as const)("is not read as a failed attempt of a %s-source Todo, so nothing restarts it", (source) => {
    const id = phaseOnly(source);

    expect(controller.classifyWorkItem(store.getWorkItem(id)!).class).not.toBe("code");
    autoSweep();
    expect(dispatchedIds()).not.toContain(id);
  });

  it("is flagged for the operator once it has sat in executing with nothing running for over four hours", () => {
    const id = phaseOnly("human");
    const later = new Date(Date.now() + recovery.EXECUTION_TIMEOUT_MS + 60_000);

    expect(controller.classifyWorkItem(store.getWorkItem(id)!, later)).toMatchObject({
      class: "operator", lane: "manager", reason: recovery.EXECUTING_UNHANDED_REASON,
    });
  });
});
