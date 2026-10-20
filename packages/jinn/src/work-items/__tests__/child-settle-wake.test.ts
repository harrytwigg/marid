import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "jinn-child-settle-wake-"));
process.env.JINN_HOME = tmp;

// The wake is claimed in the real outbox; only the HTTP hop to the message
// route is stood in for (the route itself is covered in
// gateway/__tests__/child-settle-wake-route.test.ts).
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
let wake: typeof import("../child-settle-wake.js");
let settles: typeof import("../child-settles.js");
let delegations: typeof import("../open-delegations.js");
let comments: typeof import("../comments.js");
let registry: typeof import("../../sessions/registry.js");
let childWatch: typeof import("../../heartbeats/child-watch.js");
let heartbeatStore: typeof import("../../heartbeats/store.js");
let db: import("better-sqlite3").Database;
let DISPATCHER_ALREADY_RUNNING: string;

beforeAll(async () => {
  ({ DISPATCHER_ALREADY_RUNNING } = await import("../availability-resume.js"));
  store = await import("../store.js");
  transitions = await import("../transitions.js");
  wake = await import("../child-settle-wake.js");
  settles = await import("../child-settles.js");
  delegations = await import("../open-delegations.js");
  comments = await import("../comments.js");
  registry = await import("../../sessions/registry.js");
  childWatch = await import("../../heartbeats/child-watch.js");
  heartbeatStore = await import("../../heartbeats/store.js");
  db = (await import("../../shared/db.js")).initDb();
});

const OWNER = "tree-owner";
const WORKER = "tree-worker";
const deps = {
  isEmployee: (name: string) => name === OWNER || name === WORKER,
  redispatch: vi.fn((_id: string, _reason: string) => ({ status: "executing" as const })),
};

beforeEach(() => {
  // A row an earlier test left pending would be met by this one's startup pass.
  db.prepare("DELETE FROM work_item_child_settles").run();
  delivered.length = 0;
  deps.redispatch.mockClear();
  deps.redispatch.mockImplementation(() => ({ status: "executing" as const }));
  wake.setReleaseChildWatchIfSettled(null);
});

afterEach(() => {
  vi.useRealTimers();
});

let counter = 0;
type SessionStatus = "idle" | "running" | "interrupted" | "error" | "waiting";

/** A session of `employee` linked to `workItemId` to execute it. */
function sessionOn(employee: string, workItemId: string | null, status: SessionStatus = "idle", over: { parent?: string; archived?: boolean; role?: string } = {}) {
  counter += 1;
  const session = registry.createSession({
    engine: "claude",
    source: "web",
    sourceRef: `web:wake-${counter}`,
    employee,
    ...(over.parent ? { parentSessionId: over.parent } : {}),
  });
  db.prepare("UPDATE sessions SET status = ?, work_item_id = ?, work_item_role = ?, archived_at = ? WHERE id = ?")
    .run(status, workItemId, workItemId ? over.role ?? "execute" : null, over.archived ? new Date().toISOString() : null, session.id);
  return session.id;
}

/** An executing parent owned by OWNER, with that employee's session linked to it. */
function parentWithOwner(status: "executing" | "blocked" = "executing", ownerStatus: SessionStatus = "idle") {
  counter += 1;
  const parent = store.createWorkItem({ title: `parent ${counter}`, status, source: "session", assignee: OWNER });
  const ownerSession = sessionOn(OWNER, parent.id, ownerStatus);
  return { parent, ownerSession };
}

function childOf(parentId: string, title = "child") {
  counter += 1;
  return store.createWorkItem({ title: `${title} ${counter}`, status: "executing", source: "session", assignee: WORKER, parentId });
}

function settle(childId: string, to: "in_review" | "blocked" | "done" | "cancelled" = "in_review", actor = "board-walk", note?: string) {
  return transitions.transition(childId, to, actor, { human: true, ...(note ? { detail: { note } } : {}) });
}

const rowsOf = (parentId: string) => db.prepare("SELECT * FROM work_item_child_settles WHERE parent_id = ? ORDER BY id").all(parentId) as Array<{ outcome: string | null; flushed_at: string | null; delivery_id: string | null }>;
const deliveryOf = (id: string) => registry.getSessionDelivery(id)!;

describe("a child Todo with no session parent settling", () => {
  it("wakes the parent owner's session with one delivery that names the child", () => {
    const { parent, ownerSession } = parentWithOwner();
    const child = childOf(parent.id, "board-walk child");
    settle(child.id, "in_review", "board-walk", "Opened the PR and ran the suite.");
    expect(rowsOf(parent.id)).toHaveLength(1);

    wake.flushChildSettles(parent.id, deps);

    expect(delivered).toHaveLength(1);
    const delivery = deliveryOf(delivered[0]!);
    expect(delivery).toMatchObject({
      targetSessionId: ownerSession,
      sourceKind: "work-item",
      sourceId: parent.id,
      sourceOutcome: "children-settled",
      deliveryKind: "todo-child-settled",
    });
    expect(delivery.payload.message).toContain(child.id);
    expect(delivery.payload.message).toContain("executing → in_review");
    expect(delivery.payload.message).toContain("board-walk");
    expect(delivery.payload.message).toContain("Opened the PR and ran the suite.");
    expect(delivery.payload.message).toContain("get_work_item");
    expect(rowsOf(parent.id)).toEqual([expect.objectContaining({ outcome: "woken", delivery_id: delivery.id })]);
    expect(deps.redispatch).not.toHaveBeenCalled();
  });

  it("clips the move's note to 500 characters", () => {
    const { parent } = parentWithOwner();
    settle(childOf(parent.id).id, "in_review", "board-walk", `start ${"x".repeat(2000)} ENDMARK`);
    wake.flushChildSettles(parent.id, deps);
    const { message } = deliveryOf(delivered[0]!).payload;
    expect(message).toContain("start xxx");
    expect(message).not.toContain("ENDMARK");
    expect(message.length).toBeLessThan(2000);
  });

  it("a second flush of the same rows delivers nothing more", () => {
    const { parent } = parentWithOwner();
    settle(childOf(parent.id).id);
    wake.flushChildSettles(parent.id, deps);
    wake.flushChildSettles(parent.id, deps);
    expect(delivered).toHaveLength(1);
  });

  it("tells the heartbeat seam which session it woke", () => {
    const release = vi.fn();
    wake.setReleaseChildWatchIfSettled(release);
    const { parent, ownerSession } = parentWithOwner();
    settle(childOf(parent.id).id);
    wake.flushChildSettles(parent.id, deps);
    expect(release).toHaveBeenCalledExactlyOnceWith(ownerSession);
  });
});

describe("the parent's owner has no session to wake", () => {
  it.each([
    ["errored", { status: "error" as const }],
    ["archived", { status: "idle" as const, archived: true }],
  ])("an %s owner session re-dispatches an executing parent with the children listed", (_name, owner) => {
    const { parent, ownerSession } = parentWithOwner("executing", owner.status);
    if ("archived" in owner) db.prepare("UPDATE sessions SET archived_at = ? WHERE id = ?").run(new Date().toISOString(), ownerSession);
    const first = childOf(parent.id, "first");
    const second = childOf(parent.id, "second");
    settle(first.id);
    settle(second.id, "blocked", "board-walk", "Needs the API key.");

    wake.flushChildSettles(parent.id, deps);

    expect(delivered).toEqual([]);
    expect(deps.redispatch).toHaveBeenCalledTimes(1);
    const [todoId, reason] = deps.redispatch.mock.calls[0]!;
    expect(todoId).toBe(parent.id);
    expect(reason).toContain(first.id);
    expect(reason).toContain(second.id);
    expect(reason).toContain("Needs the API key.");
    expect(rowsOf(parent.id).map((row) => row.outcome)).toEqual(["redispatched", "redispatched"]);
  });

  it("a parent with no session at all is re-dispatched too", () => {
    counter += 1;
    const parent = store.createWorkItem({ title: `lonely ${counter}`, status: "executing", source: "session", assignee: OWNER });
    settle(childOf(parent.id).id);
    wake.flushChildSettles(parent.id, deps);
    expect(deps.redispatch).toHaveBeenCalledTimes(1);
  });

  it("a refused re-dispatch still counts: the new session reads the tree", () => {
    const { parent } = parentWithOwner("executing", "error");
    settle(childOf(parent.id).id);
    deps.redispatch.mockReturnValue({ unavailable: DISPATCHER_ALREADY_RUNNING } as never);
    wake.flushChildSettles(parent.id, deps);
    expect(rowsOf(parent.id)).toEqual([expect.objectContaining({ outcome: "redispatched" })]);
    expect(settles.hasPendingChildSettles(parent.id)).toBe(false);
  });

  it.each([
    "its start date is still ahead",
    "it is held: waiting on a dependency",
    "the Dispatcher could not take its claim",
  ])("a refusal that started nothing (%s) is recorded on the parent, not lost and not retried forever", (reason) => {
    const { parent, ownerSession } = parentWithOwner("executing", "error");
    const child = childOf(parent.id);
    settle(child.id);
    deps.redispatch.mockReturnValue({ unavailable: reason } as never);

    wake.flushChildSettles(parent.id, deps);

    expect(deps.redispatch).toHaveBeenCalledTimes(1);
    expect(rowsOf(parent.id)).toEqual([expect.objectContaining({ outcome: "recorded" })]);
    const posted = comments.listComments(parent.id).comments;
    expect(posted).toHaveLength(1);
    expect(posted[0]!.body).toContain(child.id);
    expect(posted[0]!.body).toContain(reason);
    // Nothing keeps a held parent "in flight" for the stall check.
    expect(settles.hasPendingChildSettles(parent.id)).toBe(false);
    expect(delegations.hasOpenDelegations(parent.id, [{ id: ownerSession }])).toBe(false);
    wake.flushChildSettles(parent.id, deps);
    expect(deps.redispatch).toHaveBeenCalledTimes(1);
    expect(comments.listComments(parent.id).comments).toHaveLength(1);
  });

  it("a re-dispatch that throws leaves the rows for the sweep", () => {
    const { parent } = parentWithOwner("executing", "error");
    settle(childOf(parent.id).id);
    deps.redispatch.mockImplementation(() => { throw new Error("spawn failed"); });
    wake.flushChildSettles(parent.id, deps);
    expect(settles.hasPendingChildSettles(parent.id)).toBe(true);
    expect(rowsOf(parent.id)).toEqual([expect.objectContaining({ outcome: null, flushed_at: null })]);
  });

  it("a blocked parent gets one comment listing the children and is never re-dispatched", () => {
    const { parent } = parentWithOwner("blocked", "error");
    const first = childOf(parent.id, "first");
    const second = childOf(parent.id, "second");
    settle(first.id, "done");
    settle(second.id, "in_review");

    wake.flushChildSettles(parent.id, deps);

    expect(deps.redispatch).not.toHaveBeenCalled();
    expect(delivered).toEqual([]);
    const posted = comments.listComments(parent.id).comments;
    expect(posted).toHaveLength(1);
    expect(posted[0]!.body).toContain(first.id);
    expect(posted[0]!.body).toContain(second.id);
    expect(rowsOf(parent.id).map((row) => row.outcome)).toEqual(["recorded", "recorded"]);
    // A retried flush never posts it twice.
    wake.flushChildSettles(parent.id, deps);
    expect(comments.listComments(parent.id).comments).toHaveLength(1);
  });

  it("a blocked parent whose owner has a live session is woken, not commented on", () => {
    const { parent, ownerSession } = parentWithOwner("blocked", "idle");
    settle(childOf(parent.id).id);
    wake.flushChildSettles(parent.id, deps);
    expect(deliveryOf(delivered[0]!).targetSessionId).toBe(ownerSession);
    expect(comments.listComments(parent.id).comments).toHaveLength(0);
  });
});

describe("a stopped owner session is still woken", () => {
  it.each(["idle", "interrupted"] as const)("delivers to an %s owner session", (status) => {
    const { parent, ownerSession } = parentWithOwner("executing", status);
    settle(childOf(parent.id).id);
    wake.flushChildSettles(parent.id, deps);
    expect(delivered).toHaveLength(1);
    expect(deliveryOf(delivered[0]!).targetSessionId).toBe(ownerSession);
    expect(deps.redispatch).not.toHaveBeenCalled();
  });

  it("takes the newest messageable session of the owner, passing over an errored one", () => {
    const { parent } = parentWithOwner("executing", "error");
    const live = sessionOn(OWNER, parent.id, "interrupted");
    db.prepare("UPDATE sessions SET last_activity = ? WHERE id = ?").run(new Date(Date.now() + 60_000).toISOString(), live);
    settle(childOf(parent.id).id);
    wake.flushChildSettles(parent.id, deps);
    expect(deliveryOf(delivered[0]!).targetSessionId).toBe(live);
  });

  it("falls back to the session through which the owner holds the Todo from outside", () => {
    counter += 1;
    const parent = store.createWorkItem({ title: `outside ${counter}`, status: "executing", source: "session", assignee: OWNER });
    // The creating session stays on its own Todo (none here), so it is not linked to the parent.
    const creator = sessionOn(OWNER, null, "idle");
    db.prepare("UPDATE work_items SET source_ref = ? WHERE id = ?").run(`session:${creator}:wake-${counter}`, parent.id);
    settle(childOf(parent.id).id);
    wake.flushChildSettles(parent.id, deps);
    expect(deliveryOf(delivered[0]!).targetSessionId).toBe(creator);
  });
});

describe("deduping against the move's own callback", () => {
  it("a delegate_task child whose own session moves it wakes the parent once, through the session callback", () => {
    const { parent, ownerSession } = parentWithOwner();
    const child = childOf(parent.id);
    const childSession = sessionOn(WORKER, child.id, "running", { parent: ownerSession });
    settle(child.id, "in_review", `session:${childSession}`);

    wake.flushChildSettles(parent.id, deps);

    expect(delivered).toEqual([]);
    expect(rowsOf(parent.id)).toEqual([expect.objectContaining({ outcome: "deduped", delivery_id: null })]);
  });

  it("a child moved by the operator still wakes the parent", () => {
    const { parent } = parentWithOwner();
    const child = childOf(parent.id);
    sessionOn(WORKER, child.id, "idle", { parent: parentWithOwner().ownerSession });
    settle(child.id, "done", "operator");
    wake.flushChildSettles(parent.id, deps);
    expect(delivered).toHaveLength(1);
  });

  it("a child session that reports elsewhere still wakes the parent", () => {
    const { parent } = parentWithOwner();
    const child = childOf(parent.id);
    const elsewhere = sessionOn("someone-else", null, "idle");
    const childSession = sessionOn(WORKER, child.id, "running", { parent: elsewhere });
    settle(child.id, "in_review", `session:${childSession}`);
    wake.flushChildSettles(parent.id, deps);
    expect(delivered).toHaveLength(1);
  });

  it("the owner's own move is deduped: the owner made it and knows", () => {
    const { parent, ownerSession } = parentWithOwner();
    const child = childOf(parent.id);
    settle(child.id, "blocked", `session:${ownerSession}`);
    wake.flushChildSettles(parent.id, deps);
    expect(delivered).toEqual([]);
    expect(rowsOf(parent.id)).toEqual([expect.objectContaining({ outcome: "deduped" })]);
  });

  it("a deduped row leaves the rest of the batch to wake", () => {
    const { parent, ownerSession } = parentWithOwner();
    const delegated = childOf(parent.id, "delegated");
    const walked = childOf(parent.id, "walked");
    const childSession = sessionOn(WORKER, delegated.id, "running", { parent: ownerSession });
    settle(delegated.id, "in_review", `session:${childSession}`);
    settle(walked.id);
    wake.flushChildSettles(parent.id, deps);
    expect(delivered).toHaveLength(1);
    const { message } = deliveryOf(delivered[0]!).payload;
    expect(message).toContain(walked.id);
    expect(message).not.toContain(delegated.id);
    expect(rowsOf(parent.id).map((row) => row.outcome)).toEqual(["deduped", "woken"]);
  });
});

describe("parents that are not woken", () => {
  it.each(["backlog", "in_review", "done"] as const)("a %s parent records the rows and wakes nobody", (status) => {
    const { parent } = parentWithOwner();
    settle(childOf(parent.id).id);
    db.prepare("UPDATE work_items SET status = ? WHERE id = ?").run(status, parent.id);
    wake.flushChildSettles(parent.id, deps);
    expect(delivered).toEqual([]);
    expect(deps.redispatch).not.toHaveBeenCalled();
    expect(rowsOf(parent.id)).toEqual([expect.objectContaining({ outcome: "recorded" })]);
  });

  it("a parent the operator owns records the rows", () => {
    counter += 1;
    const parent = store.createWorkItem({ title: `operator-owned ${counter}`, status: "executing", source: "human", assignee: "@operator" });
    settle(childOf(parent.id).id);
    wake.flushChildSettles(parent.id, deps);
    expect(delivered).toEqual([]);
    expect(rowsOf(parent.id)).toEqual([expect.objectContaining({ outcome: "recorded" })]);
  });
});

describe("batching", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  it("two children settling inside the window go out in one delivery listing both", () => {
    const { parent } = parentWithOwner();
    const first = childOf(parent.id, "first");
    const second = childOf(parent.id, "second");
    const stop = wake.startChildSettleWake(deps);
    try {
      settle(first.id);
      vi.advanceTimersByTime(4_000);
      settle(second.id, "done");
      expect(delivered).toEqual([]);
      vi.advanceTimersByTime(wake.CHILD_SETTLE_BATCH_MS);
      expect(delivered).toHaveLength(1);
      const { message } = deliveryOf(delivered[0]!).payload;
      expect(message).toContain(first.id);
      expect(message).toContain(second.id);
      expect(rowsOf(parent.id).map((row) => row.outcome)).toEqual(["woken", "woken"]);
    } finally {
      stop();
    }
  });

  it("the window is fixed from the first row: later settles do not push the wake back", () => {
    const { parent } = parentWithOwner();
    const children = [childOf(parent.id), childOf(parent.id), childOf(parent.id)];
    const stop = wake.startChildSettleWake(deps);
    try {
      settle(children[0]!.id);
      vi.advanceTimersByTime(6_000);
      settle(children[1]!.id);
      vi.advanceTimersByTime(3_000);
      settle(children[2]!.id);
      expect(delivered).toEqual([]);
      vi.advanceTimersByTime(1_000);
      expect(delivered).toHaveLength(1);
      expect(deliveryOf(delivered[0]!).payload.message).toContain(children[2]!.id);
    } finally {
      stop();
    }
  });

  it("a settle after the flush starts a new window and a second delivery", () => {
    const { parent } = parentWithOwner();
    const first = childOf(parent.id);
    const second = childOf(parent.id);
    const stop = wake.startChildSettleWake(deps);
    try {
      settle(first.id);
      vi.advanceTimersByTime(wake.CHILD_SETTLE_BATCH_MS);
      settle(second.id);
      vi.advanceTimersByTime(wake.CHILD_SETTLE_BATCH_MS);
      expect(delivered).toHaveLength(2);
      expect(deliveryOf(delivered[0]!).sourceAttempt).not.toBe(deliveryOf(delivered[1]!).sourceAttempt);
    } finally {
      stop();
    }
  });

  it("stopping leaves no timer and no sweep behind", () => {
    const { parent } = parentWithOwner();
    const stop = wake.startChildSettleWake(deps);
    settle(childOf(parent.id).id);
    expect(vi.getTimerCount()).toBeGreaterThan(0);
    stop();
    expect(vi.getTimerCount()).toBe(0);
    vi.advanceTimersByTime(wake.CHILD_SETTLE_SWEEP_MS * 2);
    expect(delivered).toEqual([]);
    // Nor does a settle after the stop schedule anything.
    settle(childOf(parent.id).id);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("a settle heard while an older row is still pending times the flush from the older row", () => {
    const { parent } = parentWithOwner();
    const older = childOf(parent.id);
    const newer = childOf(parent.id);
    const stop = wake.startChildSettleWake(deps);
    try {
      // A row written 7 s ago that nothing signalled (the sweep has not met it yet).
      db.prepare(
        `INSERT INTO work_item_child_settles (parent_id, child_id, event_id, from_status, to_status, actor, created_at)
         VALUES (?, ?, 'wie_older_row', 'executing', 'in_review', 'board-walk', ?)`,
      ).run(parent.id, older.id, new Date(Date.now() - 7_000).toISOString());
      settle(newer.id);
      vi.advanceTimersByTime(2_900);
      expect(delivered).toEqual([]);
      vi.advanceTimersByTime(200);
      expect(delivered).toHaveLength(1);
      expect(deliveryOf(delivered[0]!).payload.message).toContain(older.id);
      expect(deliveryOf(delivered[0]!).payload.message).toContain(newer.id);
    } finally {
      stop();
    }
  });

  it("a rolled-back move records nothing and wakes nobody", () => {
    const { parent } = parentWithOwner();
    const child = childOf(parent.id);
    const stop = wake.startChildSettleWake(deps);
    try {
      expect(() => db.transaction(() => {
        settle(child.id);
        throw new Error("outer failure");
      })()).toThrow("outer failure");
      vi.advanceTimersByTime(wake.CHILD_SETTLE_BATCH_MS * 2);
      expect(rowsOf(parent.id)).toEqual([]);
      expect(delivered).toEqual([]);
    } finally {
      stop();
    }
  });
});

describe("a restart", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  it("delivers rows older than the window once, from the startup pass", () => {
    const { parent } = parentWithOwner();
    settle(childOf(parent.id).id);
    db.prepare("UPDATE work_item_child_settles SET created_at = ? WHERE parent_id = ?")
      .run(new Date(Date.now() - 5 * 60_000).toISOString(), parent.id);

    const stop = wake.startChildSettleWake(deps);
    try {
      expect(delivered).toHaveLength(1);
      vi.advanceTimersByTime(wake.CHILD_SETTLE_SWEEP_MS * 3);
      expect(delivered).toHaveLength(1);
    } finally {
      stop();
    }
    // Another restart finds nothing pending.
    const again = wake.startChildSettleWake(deps);
    again();
    expect(delivered).toHaveLength(1);
  });

  it("schedules a young pending row for the rest of its window", () => {
    const { parent } = parentWithOwner();
    settle(childOf(parent.id).id);
    const stop = wake.startChildSettleWake(deps);
    try {
      expect(delivered).toEqual([]);
      vi.advanceTimersByTime(wake.CHILD_SETTLE_BATCH_MS);
      expect(delivered).toHaveLength(1);
    } finally {
      stop();
    }
  });

  it("the 60 s sweep picks up a row nobody signalled", () => {
    const { parent } = parentWithOwner();
    const stop = wake.startChildSettleWake(deps);
    try {
      // Written with no listener attached to hear it, as after a crash between commit and signal.
      const child = childOf(parent.id);
      const unsignalled = new Date(Date.now() - 30_000).toISOString();
      db.prepare(
        `INSERT INTO work_item_child_settles (parent_id, child_id, event_id, from_status, to_status, actor, created_at)
         VALUES (?, ?, 'wie_unsignalled', 'executing', 'in_review', 'board-walk', ?)`,
      ).run(parent.id, child.id, unsignalled);
      vi.advanceTimersByTime(wake.CHILD_SETTLE_SWEEP_MS);
      expect(delivered).toHaveLength(1);
    } finally {
      stop();
    }
  });
});

describe("the stall check", () => {
  const open = (parentId: string, ownerSession: string) => delegations.hasOpenDelegations(parentId, [{ id: ownerSession }]);
  /** What the message route does with the claimed delivery. */
  const accept = (deliveryId: string, ownerSession: string) =>
    registry.acceptSessionDelivery(deliveryId, ownerSession, registry.getSession(ownerSession)!.sessionKey!);

  it("a parent with a pending wake is in flight; once it has been woken and its only child sits in review, it is not", () => {
    const { parent, ownerSession } = parentWithOwner();
    const child = childOf(parent.id);
    expect(open(parent.id, ownerSession)).toBe(true); // an executing child
    settle(child.id);
    expect(open(parent.id, ownerSession)).toBe(true); // settled, the settle row not yet flushed

    wake.flushChildSettles(parent.id, deps);
    expect(open(parent.id, ownerSession)).toBe(true); // claimed, not yet accepted by the owner's session

    expect(accept(delivered[0]!, ownerSession).accepted).toBe(true);
    expect(store.getWorkItem(child.id)?.status).toBe("in_review");
    expect(open(parent.id, ownerSession)).toBe(false);
  });

  it("a deduped or recorded settle holds nothing", () => {
    const { parent, ownerSession } = parentWithOwner();
    const child = childOf(parent.id);
    settle(child.id, "in_review", `session:${ownerSession}`);
    wake.flushChildSettles(parent.id, deps);
    expect(open(parent.id, ownerSession)).toBe(false);
  });

  it("a wake for a session that is not one of the Todo's attempts still holds the parent", () => {
    const { parent } = parentWithOwner();
    settle(childOf(parent.id).id);
    wake.flushChildSettles(parent.id, deps);
    expect(delegations.hasOpenDelegations(parent.id, [])).toBe(true);
  });
});

describe("the child-watch heartbeat of the session the flush told", () => {
  const watches = (sessionId: string) => heartbeatStore.listHeartbeatsForSession(sessionId).filter((heartbeat) => heartbeat.purpose === "child-watch");

  beforeEach(() => {
    wake.setReleaseChildWatchIfSettled(childWatch.releaseChildWatchIfSettled);
  });

  it("a flush that wakes the owner disarms its watch once no child is left open, and not before", () => {
    const { parent, ownerSession } = parentWithOwner();
    const first = childOf(parent.id);
    const second = childOf(parent.id);
    childWatch.armChildWatch(ownerSession);

    settle(first.id);
    wake.flushChildSettles(parent.id, deps);
    expect(delivered).toHaveLength(1);
    expect(watches(ownerSession)).toHaveLength(1); // the second child is still executing

    settle(second.id, "done");
    wake.flushChildSettles(parent.id, deps);
    expect(delivered).toHaveLength(2);
    expect(watches(ownerSession)).toHaveLength(0);
    expect(db.prepare("SELECT disarmed_reason FROM heartbeats WHERE owner_session_id = ?").pluck().get(ownerSession)).toBe("children-settled");
  });

  it("a flush that only dedupes still disarms the owner's watch once its child session is no longer in flight", () => {
    const { parent, ownerSession } = parentWithOwner();
    const child = childOf(parent.id);
    const childSession = sessionOn(WORKER, child.id, "running", { parent: ownerSession });
    childWatch.armChildWatch(ownerSession);
    settle(child.id, "in_review", `session:${childSession}`);

    wake.flushChildSettles(parent.id, deps);
    expect(delivered).toEqual([]);
    expect(rowsOf(parent.id)).toEqual([expect.objectContaining({ outcome: "deduped" })]);
    // The child's session is still running its turn, so it still counts as open work.
    expect(watches(ownerSession)).toHaveLength(1);

    db.prepare("UPDATE sessions SET status = 'idle' WHERE id = ?").run(childSession);
    settle(childOf(parent.id).id, "in_review", `session:${childSession}`);
    wake.flushChildSettles(parent.id, deps);
    expect(rowsOf(parent.id).map((row) => row.outcome)).toEqual(["deduped", "deduped"]);
    expect(watches(ownerSession)).toHaveLength(0);
  });
});
