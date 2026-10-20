import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "jinn-quiet-watch-"));
process.env.JINN_HOME = tmp;

// Deliveries are claimed in the real outbox; only the HTTP hop to the message
// route is stood in for.
const delivered: string[] = [];
vi.mock("../../sessions/callbacks.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../sessions/callbacks.js")>()),
  deliverClaimedSessionDelivery: vi.fn(async (id: string) => {
    delivered.push(id);
    return "accepted";
  }),
}));

let store: typeof import("../store.js");
let transitions: typeof import("../transitions.js");
let watch: typeof import("../quiet-watch.js");
let registry: typeof import("../../sessions/registry.js");
let background: typeof import("../../sessions/background-work.js");
let events: typeof import("../event-log.js");
let db: import("better-sqlite3").Database;

beforeAll(async () => {
  store = await import("../store.js");
  transitions = await import("../transitions.js");
  watch = await import("../quiet-watch.js");
  registry = await import("../../sessions/registry.js");
  background = await import("../../sessions/background-work.js");
  events = await import("../event-log.js");
  db = (await import("../../shared/db.js")).initDb();
});

const OWNER = "quiet-owner";
const DISPATCHER = "todo-dispatcher";
const WORKER = "quiet-worker";
const MIN = 60_000;
let base = Date.now();
let offset = 0;
const deps = {
  isEmployee: (name: string) => name === OWNER || name === WORKER || name === DISPATCHER,
  isSystemEmployee: (name: string) => name === DISPATCHER,
  redispatch: vi.fn((_id: string, _reason: string) => ({ status: "executing" as const })),
  now: () => base + offset,
};

beforeEach(() => {
  delivered.length = 0;
  deps.redispatch.mockClear();
  background.runtimeActivity.clear();
  base = Date.now();
  offset = 0;
});

// Every test's Todos stop being open work, so a later sweep never meets them.
afterEach(() => {
  db.prepare("UPDATE work_items SET status = 'cancelled' WHERE status IN ('backlog', 'executing', 'blocked')").run();
});

let counter = 0;
type SessionStatus = "idle" | "running" | "interrupted" | "error" | "waiting";

function sessionOn(employee: string, workItemId: string | null, status: SessionStatus = "idle", over: { parent?: string } = {}) {
  counter += 1;
  const session = registry.createSession({
    engine: "claude",
    source: "web",
    sourceRef: `web:quiet-${counter}`,
    employee,
    ...(over.parent ? { parentSessionId: over.parent } : {}),
  });
  db.prepare("UPDATE sessions SET status = ?, work_item_id = ?, work_item_role = ?, last_activity = ? WHERE id = ?")
    .run(status, workItemId, workItemId ? "execute" : null, new Date(base).toISOString(), session.id);
  return session.id;
}

/** An `executing` Todo, entered through a real move so it has a stint. */
function executingTodo(assignee: string, parentId?: string) {
  counter += 1;
  const item = store.createWorkItem({ title: `todo ${counter}`, status: "backlog", source: "session", assignee, ...(parentId ? { parentId } : {}) });
  transitions.transition(item.id, "executing", "board-walk");
  return item;
}

/** An executing parent owned by OWNER, its owner session idle, with an executing child worked by WORKER. */
function tree() {
  const parent = executingTodo(OWNER);
  const ownerSession = sessionOn(OWNER, parent.id);
  const child = executingTodo(WORKER, parent.id);
  const workerSession = sessionOn(WORKER, child.id);
  return { parent, ownerSession, child, workerSession };
}

const deliveries = () => delivered.map((id) => registry.getSessionDelivery(id)!);
const kinds = (id: string) => events.listWorkItemEvents(id).map((event) => event.kind).filter((kind) => kind.startsWith("quiet_"));
const sweep = () => watch.sweepQuietTodos(deps);
const at = (minutes: number) => { offset = minutes * MIN; };
/** The session answering a nudge: it spoke, then went quiet again. */
const spoke = (sessionId: string, minutes: number) =>
  db.prepare("UPDATE sessions SET last_activity = ? WHERE id = ?").run(new Date(base + minutes * MIN).toISOString(), sessionId);

describe("a quiet executing Todo", () => {
  it("is left alone for 15 minutes, then its producer is nudged once", () => {
    const { child, workerSession } = tree();
    at(14);
    sweep();
    expect(delivered).toEqual([]);

    at(16);
    sweep();
    expect(deliveries()).toEqual([expect.objectContaining({
      targetSessionId: workerSession,
      sourceKind: "work-item",
      sourceId: child.id,
      deliveryKind: "todo-quiet-nudge",
    })]);
    const { message } = deliveries()[0]!.payload;
    expect(message).toContain(child.id);
    expect(message).toContain("will not wake you");
    expect(message).toContain("`blocked`");
    expect(kinds(child.id)).toEqual(["quiet_nudged"]);

    // The window restarts at the nudge.
    at(20);
    sweep();
    expect(delivered).toHaveLength(1);
  });

  it("escalates to the parent owner once when the nudge does not move it", () => {
    const { child, ownerSession, workerSession } = tree();
    at(16);
    sweep();
    spoke(workerSession, 17);
    at(31);
    sweep();
    expect(delivered).toHaveLength(1);

    at(33);
    sweep();
    expect(deliveries()[1]).toMatchObject({ targetSessionId: ownerSession, sourceId: child.id, deliveryKind: "todo-quiet-escalation" });
    const { message } = deliveries()[1]!.payload;
    expect(message).toContain(child.id);
    expect(message).toContain(workerSession);
    expect(message).toContain("nudged its session");
    expect(message).toContain("send_to_session");
    // Refused while the child's session is idle between turns, so not offered.
    expect(message).not.toContain("dispatch_work_item");
    expect(kinds(child.id)).toEqual(["quiet_nudged", "quiet_escalated"]);

    at(120);
    sweep();
    expect(delivered).toHaveLength(2);
  });

  it("does not nudge the parent, whose executing child is open work, while the child is escalated to it", () => {
    const { parent } = tree();
    at(16);
    sweep();
    at(40);
    sweep();
    expect(kinds(parent.id)).toEqual([]);
    expect(deliveries().every((delivery) => delivery.sourceId !== parent.id)).toBe(true);
  });

  it("re-dispatches an executing parent whose owner has no session that can be messaged", () => {
    const { parent, child, ownerSession } = tree();
    db.prepare("UPDATE sessions SET status = 'error' WHERE id = ?").run(ownerSession);
    at(16);
    sweep();
    at(40);
    sweep();
    expect(deps.redispatch).toHaveBeenCalledTimes(1);
    expect(deps.redispatch.mock.calls[0]![0]).toBe(parent.id);
    expect(deps.redispatch.mock.calls[0]![1]).toContain(child.id);
    expect(kinds(child.id)).toEqual(["quiet_nudged", "quiet_escalated"]);
  });

  it("escalates a root Todo to the session its producer reports to", () => {
    const manager = sessionOn(OWNER, null);
    const item = executingTodo(WORKER);
    sessionOn(WORKER, item.id, "idle", { parent: manager });
    at(16);
    sweep();
    at(40);
    sweep();
    expect(deliveries()[1]).toMatchObject({ targetSessionId: manager, deliveryKind: "todo-quiet-escalation" });
  });

  it("says so on the Todo when nobody above it can be messaged", () => {
    const item = executingTodo(WORKER);
    sessionOn(WORKER, item.id);
    at(16);
    sweep();
    at(40);
    sweep();
    expect(delivered).toHaveLength(1);
    const comments = db.prepare("SELECT body, author_kind FROM work_item_comments WHERE work_item_id = ?").all(item.id) as Array<{ body: string; author_kind: string }>;
    expect(comments).toEqual([expect.objectContaining({ author_kind: "system", body: expect.stringContaining("nobody was told") })]);
  });

  it("goes straight to the escalation when no producer session can be messaged", () => {
    const { child, ownerSession, workerSession } = tree();
    db.prepare("UPDATE sessions SET status = 'error' WHERE id = ?").run(workerSession);
    at(16);
    sweep();
    expect(deliveries()).toEqual([expect.objectContaining({ targetSessionId: ownerSession, deliveryKind: "todo-quiet-escalation" })]);
    expect(deliveries()[0]!.payload.message).toContain("was not nudged");
    expect(deliveries()[0]!.payload.message).toContain("dispatch_work_item");
    expect(deliveries()[0]!.payload.message).toContain(workerSession);
    expect(kinds(child.id)).toEqual(["quiet_escalated"]);
  });

  it("starts again in a new executing stint", () => {
    const { child, workerSession } = tree();
    at(16);
    sweep();
    at(40);
    sweep();
    expect(delivered).toHaveLength(2);
    transitions.transition(child.id, "blocked", "board-walk", { blockKind: "needs_input" });
    transitions.transition(child.id, "executing", "operator", { human: true, manual: true });
    spoke(workerSession, 40);
    at(50);
    sweep();
    expect(delivered).toHaveLength(2);
    at(56);
    sweep();
    expect(deliveries()[2]).toMatchObject({ targetSessionId: workerSession, deliveryKind: "todo-quiet-nudge" });
  });
});

describe("who is nudged and who is told", () => {
  it("never nudges a previous assignee's session after the Todo was reassigned", () => {
    const item = executingTodo(WORKER);
    const previous = sessionOn(WORKER, item.id);
    transitions.assignWorkItem(item.id, OWNER, null, "operator");
    at(16);
    sweep();
    expect(deliveries().map((delivery) => delivery.targetSessionId)).not.toContain(previous);
    expect(kinds(item.id)).toEqual(["quiet_escalated"]);
  });

  it("never nudges the Dispatcher linked to execute a Todo its delegate never reached", () => {
    const item = executingTodo(WORKER);
    const dispatcher = sessionOn(DISPATCHER, item.id);
    at(16);
    sweep();
    expect(deliveries().map((delivery) => delivery.targetSessionId)).not.toContain(dispatcher);
  });

  it("does not escalate a board-walk root to the Dispatcher that started it, but says so on the Todo", () => {
    const dispatcher = sessionOn(DISPATCHER, null);
    const item = executingTodo(WORKER);
    sessionOn(WORKER, item.id, "idle", { parent: dispatcher });
    at(16);
    sweep();
    at(40);
    sweep();
    expect(deliveries().map((delivery) => delivery.targetSessionId)).not.toContain(dispatcher);
    expect(kinds(item.id)).toEqual(["quiet_nudged", "quiet_escalated"]);
    const comments = db.prepare("SELECT body FROM work_item_comments WHERE work_item_id = ?").pluck().all(item.id) as string[];
    expect(comments).toEqual([expect.stringContaining("nobody was told")]);
  });

  it("says one minute, not one minutes", () => {
    const item = executingTodo(WORKER);
    sessionOn(WORKER, item.id);
    offset = 70_000;
    watch.sweepQuietTodos({ ...deps, windows: () => ({ afterMs: 60_000, backgroundTaskMs: 60_000 }) });
    expect(deliveries()[0]!.payload.message).toContain("for 1 minute.");
  });
});

describe("a Todo that is not quiet", () => {
  it("is never nudged while its session runs, waits, or has live background work", () => {
    const running = executingTodo(WORKER);
    sessionOn(WORKER, running.id, "running");
    const waiting = executingTodo(WORKER);
    sessionOn(WORKER, waiting.id, "waiting");
    const backgrounded = executingTodo(WORKER);
    const sub = sessionOn(WORKER, backgrounded.id);
    background.runtimeActivity.set(sub, { activeStreams: 0, backgroundAgents: 1, lastActivityAt: base });
    at(120);
    sweep();
    expect(delivered).toEqual([]);
  });

  it("is never nudged while it has an executing sub-task or a running child session", () => {
    const parent = executingTodo(OWNER);
    sessionOn(OWNER, parent.id);
    executingTodo(WORKER, parent.id);
    const spawner = executingTodo(OWNER);
    const spawnerSession = sessionOn(OWNER, spawner.id);
    sessionOn(WORKER, null, "running", { parent: spawnerSession });
    at(120);
    sweep();
    expect(deliveries().map((delivery) => delivery.sourceId)).not.toContain(parent.id);
    expect(deliveries().map((delivery) => delivery.sourceId)).not.toContain(spawner.id);
  });

  it("gets 60 minutes while its producer still counts a background shell task", () => {
    const item = executingTodo(WORKER);
    const session = sessionOn(WORKER, item.id);
    background.runtimeActivity.set(session, { activeStreams: 0, activeMonitors: 1, lastActivityAt: base });
    at(45);
    sweep();
    expect(delivered).toEqual([]);
    at(61);
    sweep();
    expect(deliveries()).toEqual([expect.objectContaining({ targetSessionId: session, deliveryKind: "todo-quiet-nudge" })]);
    expect(deliveries()[0]!.payload.message).toContain("still counts a background command");
  });

  it("is left alone when blocked, unassigned to an employee, never started, or the watch is off", () => {
    const blocked = executingTodo(WORKER);
    sessionOn(WORKER, blocked.id);
    transitions.transition(blocked.id, "blocked", "board-walk", { blockKind: "needs_input" });
    const operators = executingTodo("@operator");
    sessionOn(WORKER, operators.id);
    executingTodo(WORKER); // no session linked
    at(120);
    expect(watch.sweepQuietTodos({ ...deps, windows: () => null })).toBe(0);
    sweep();
    const ids = deliveries().map((delivery) => delivery.sourceId);
    expect(ids).not.toContain(blocked.id);
    expect(ids).not.toContain(operators.id);
  });
});
