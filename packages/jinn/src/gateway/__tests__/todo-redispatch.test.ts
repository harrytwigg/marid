import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ApiContext } from "../api.js";

/**
 * `redispatchTodo` is how availability resume and Todo recovery restart stalled
 * work. It restarts only mid-flight Todos, through the Todo Dispatcher, and
 * folds every way the Dispatcher can decline into an `unavailable` answer so a
 * sweep never throws.
 */

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "jinn-todo-redispatch-"));
process.env.JINN_HOME = tmp;

const startTodoDispatcher = vi.hoisted(() => vi.fn());
vi.mock("../todo-dispatch.js", () => ({ startTodoDispatcher }));

type Store = typeof import("../../work-items/store.js");
type Redispatch = typeof import("../todo-redispatch.js");

let store: Store;
let redispatchTodo: Redispatch["redispatchTodo"];

const context = {} as unknown as ApiContext;
const REASON = "This is a restart: the previous attempt stalled.";

beforeAll(async () => {
  store = await import("../../work-items/store.js");
  ({ redispatchTodo } = await import("../todo-redispatch.js"));
  (await import("../../shared/db.js")).initDb();
});

afterAll(async () => {
  (await import("../../shared/db.js")).__closeDbForTest();
  fs.rmSync(tmp, { recursive: true, force: true });
});

beforeEach(() => {
  startTodoDispatcher.mockReset();
});

describe("redispatchTodo", () => {
  it.each(["in_review", "done"] as const)("refuses a %s Todo without calling the Dispatcher", (status) => {
    const item = store.createWorkItem({ title: `${status} work`, status });

    const result = redispatchTodo(item.id, context, REASON);

    expect(result).toEqual({ unavailable: expect.stringContaining(status) });
    expect(startTodoDispatcher).not.toHaveBeenCalled();
  });

  it("reports a Todo that no longer exists as unavailable", () => {
    expect(redispatchTodo("TST-9999", context, REASON)).toEqual({ unavailable: expect.any(String) });
    expect(startTodoDispatcher).not.toHaveBeenCalled();
  });

  it("starts the Dispatcher for an executing Todo, with the reason as its prompt suffix", () => {
    const item = store.createWorkItem({ title: "stalled work", status: "executing", assignee: "platform-worker" });
    startTodoDispatcher.mockReturnValue({
      ok: true, status: 201, body: { workItemId: item.id, sessionId: "sess-1", status: "running", reused: false },
    });

    const result = redispatchTodo(item.id, context, REASON);

    expect(result).toEqual({ status: "executing" });
    expect(startTodoDispatcher).toHaveBeenCalledTimes(1);
    const [passedItem, passedContext, opts] = startTodoDispatcher.mock.calls[0]!;
    expect(passedItem).toMatchObject({ id: item.id, status: "executing" });
    expect(passedContext).toBe(context);
    expect(opts.promptSuffix).toBe(REASON);
    expect(typeof opts.emitProjectionEvent).toBe("function");
  });

  // Queued work is the operator's to start: a sweep restarts stalled work, never
  // work that has not begun.
  it("refuses a backlog Todo that has an assignee, since a sweep restarts stalled work and not queued work", () => {
    const item = store.createWorkItem({ title: "queued work", status: "backlog", assignee: "platform-worker" });

    expect(redispatchTodo(item.id, context, REASON)).toEqual({ unavailable: expect.stringContaining("backlog") });
    expect(startTodoDispatcher).not.toHaveBeenCalled();
  });

  it("maps a reused Dispatcher to unavailable, since the work is already moving", () => {
    const item = store.createWorkItem({ title: "already moving", status: "executing", assignee: "platform-worker" });
    startTodoDispatcher.mockReturnValue({
      ok: true, status: 200, body: { workItemId: item.id, sessionId: "sess-3", status: "running", reused: true },
    });

    expect(redispatchTodo(item.id, context, REASON)).toEqual({ unavailable: expect.stringMatching(/already running/) });
  });

  it("maps a refused start to unavailable, carrying the Dispatcher's error text", () => {
    const item = store.createWorkItem({ title: "refused start", status: "executing", assignee: "platform-worker" });
    startTodoDispatcher.mockReturnValue({ ok: false, status: 409, body: { error: "no engine is available" } });

    expect(redispatchTodo(item.id, context, REASON)).toEqual({ unavailable: "no engine is available" });
  });
});

/**
 * The real path: an attempt dies on a quota, the reconciler derives the Todo's
 * status from that receipt, and the availability sweep restarts it once the
 * window has passed. Only the Dispatcher's session spawn is stubbed.
 */
describe("a quota-failed attempt, end to end", () => {
  type Registry = typeof import("../../sessions/registry.js");
  type Runs = typeof import("../../work-items/runs.js");
  type Reconcile = typeof import("../../work-items/reconcile.js");
  type Resume = typeof import("../../work-items/availability-resume.js");
  type Transitions = typeof import("../../work-items/transitions.js");
  let registry: Registry;
  let runs: Runs;
  let reconcile: Reconcile;
  let resume: Resume;
  let transitions: Transitions;

  beforeAll(async () => {
    registry = await import("../../sessions/registry.js");
    runs = await import("../../work-items/runs.js");
    reconcile = await import("../../work-items/reconcile.js");
    resume = await import("../../work-items/availability-resume.js");
    transitions = await import("../../work-items/transitions.js");
  });

  function quotaFailedTodo(title: string, { parkedBy }: { parkedBy?: string } = {}) {
    const item = store.createWorkItem({ title, source: "delegation", status: "executing", assignee: "platform-worker" });
    if (parkedBy) transitions.transition(item.id, "blocked", parkedBy);
    const session = registry.createSession({ engine: "claude", source: "delegation", sourceRef: `d:${title}`, employee: "platform-worker" });
    store.linkSession(item.id, session.id);
    runs.openWorkItemRun({ workItemId: item.id, sessionId: session.id });
    registry.updateSession(session.id, { status: "error", attemptOutcome: "failed", lastError: "You've hit your usage limit." });
    reconcile.reconcileWorkItem(item.id);
    return item.id;
  }

  const afterTheWindow = () => new Date(Date.now() + 31 * 60_000);
  const sweep = () => resume.sweepAvailabilityResumes({
    rearm: (id) => redispatchTodo(id, context, REASON),
    now: afterTheWindow,
  });

  it("restarts the Todo the reconciler blocked, through the Dispatcher", () => {
    const id = quotaFailedTodo("quota-killed");
    expect(store.getWorkItem(id)?.status).toBe("blocked");
    startTodoDispatcher.mockReturnValue({
      ok: true, status: 201, body: { workItemId: id, sessionId: "sess-e2e", status: "running", reused: false },
    });

    expect(sweep()).toBe(1);
    expect(startTodoDispatcher).toHaveBeenCalledTimes(1);
    expect(startTodoDispatcher.mock.calls[0]![0]).toMatchObject({ id, status: "blocked" });
  });

  it("leaves a block someone declared alone", () => {
    const id = quotaFailedTodo("parked, then quota-killed", { parkedBy: "operator" });
    expect(store.getWorkItem(id)?.status).toBe("blocked");

    expect(sweep()).toBe(0);
    expect(startTodoDispatcher).not.toHaveBeenCalled();
  });
});
