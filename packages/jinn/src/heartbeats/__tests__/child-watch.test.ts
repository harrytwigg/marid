import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { writeAutoStartRow } from "../../work-items/auto-start.js";

const home = fs.mkdtempSync(path.join(os.tmpdir(), "jinn-child-watch-"));
process.env.JINN_HOME = home;

type Watch = typeof import("../child-watch.js");
type Store = typeof import("../store.js");
type Scheduler = typeof import("../scheduler.js");
type Registry = typeof import("../../sessions/registry.js");
type WorkItems = typeof import("../../work-items/store.js");

let watch: Watch;
let store: Store;
let scheduler: Scheduler;
let registry: Registry;
let workItems: WorkItems;
let db: Database.Database;

beforeAll(async () => {
  watch = await import("../child-watch.js");
  store = await import("../store.js");
  scheduler = await import("../scheduler.js");
  registry = await import("../../sessions/registry.js");
  workItems = await import("../../work-items/store.js");
  db = (await import("../../shared/db.js")).initDb();
});

beforeEach(() => {
  db.prepare("DELETE FROM heartbeats").run();
});

let seq = 0;
function session(parentSessionId?: string) {
  return registry.createSession({ engine: "claude", source: "web", sourceRef: `cw-${++seq}`, parentSessionId });
}

function armed(sessionId: string) {
  return store.listHeartbeatsForSession(sessionId).filter((heartbeat) => heartbeat.purpose === "child-watch");
}

/** A Todo the session minted under a parent, as POST /api/work-items stamps it. */
function childTodo(
  owner: string,
  status: "backlog" | "executing" | "in_review" | "done" = "backlog",
  assignee: string | null = status === "backlog" ? "worker" : null,
) {
  const parent = workItems.createWorkItem({ title: "parent", source: "human" });
  return workItems.createWorkItem({
    title: "child", source: "session", sourceRef: `session:${owner}:${++seq}`, parentId: parent.id, status, assignee,
  });
}

function setAutoStart(workItemId: string, autoStart: boolean) {
  writeAutoStartRow(db, workItemId, autoStart, new Date().toISOString());
}

describe("armChildWatch", () => {
  it("arms one hourly child-watch heartbeat with the spec message and a 24 h expiry", () => {
    const owner = session().id;
    const now = 1_000_000;
    watch.armChildWatch(owner, now);
    const [heartbeat] = armed(owner);
    expect(heartbeat).toMatchObject({
      ownerSessionId: owner,
      everySeconds: 3600,
      nextFireAt: now + 3600_000,
      expiresAt: now + 24 * 3600_000,
      maxFires: null,
      purpose: "child-watch",
      message: watch.CHILD_WATCH_MESSAGE,
    });
    expect(heartbeat!.message).toBe(
      "Child check (armed by the gateway because you have open child work): run get_work_item_tree on your Todo " +
      "and read the child sessions you started; act on any child that has settled. If nothing needs you, end your turn.",
    );
  });

  it("does not duplicate on a second trigger and pushes the expiry", () => {
    const owner = session().id;
    watch.armChildWatch(owner, 1_000_000);
    watch.armChildWatch(owner, 5_000_000);
    const rows = armed(owner);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.expiresAt).toBe(5_000_000 + 24 * 3600_000);
    expect(rows[0]!.nextFireAt).toBe(1_000_000 + 3600_000);
  });

  it("is exempt from the manual heartbeat cap", () => {
    const owner = session().id;
    for (let i = 0; i < store.MAX_ARMED_PER_SESSION; i++) {
      store.armHeartbeat({ ownerSessionId: owner, message: `manual ${i}`, everySeconds: 60 });
    }
    watch.armChildWatch(owner);
    expect(store.listHeartbeatsForSession(owner)).toHaveLength(store.MAX_ARMED_PER_SESSION + 1);
    expect(armed(owner)).toHaveLength(1);
  });

  it("does not take a manual slot: a full set of manual heartbeats still arms after the watch", () => {
    const owner = session().id;
    watch.armChildWatch(owner);
    for (let i = 0; i < store.MAX_ARMED_PER_SESSION; i++) {
      store.armHeartbeat({ ownerSessionId: owner, message: `manual ${i}`, everySeconds: 60 });
    }
    expect(store.listHeartbeatsForSession(owner)).toHaveLength(store.MAX_ARMED_PER_SESSION + 1);
    expect(() => store.armHeartbeat({ ownerSessionId: owner, message: "one too many", everySeconds: 60 })).toThrow(/maximum/);
  });

  it("arms again after the session stopped it", () => {
    const owner = session().id;
    watch.armChildWatch(owner);
    expect(store.stopHeartbeat(armed(owner)[0]!.id, owner)).toBe(true);
    watch.armChildWatch(owner);
    expect(armed(owner)).toHaveLength(1);
  });

  it("never throws into the caller", () => {
    const spy = vi.spyOn(db, "transaction").mockImplementation(() => { throw new Error("db down"); });
    try {
      expect(() => watch.armChildWatch("whoever")).not.toThrow();
    } finally {
      spy.mockRestore();
    }
  });

  it("cannot arm a second armed heartbeat of one purpose even around the store", () => {
    const owner = session().id;
    watch.armChildWatch(owner);
    expect(() => db.prepare(`
      INSERT INTO heartbeats (id, owner_session_id, message, every_seconds, next_fire_at, status, created_at, purpose)
      VALUES ('dup', ?, 'm', 3600, 1, 'armed', '2026-01-01T00:00:00Z', 'child-watch')
    `).run(owner)).toThrow(/UNIQUE/);
  });
});

describe("openChildrenOf", () => {
  it("counts backlog and executing child Todos the session created, and ignores settled ones", () => {
    const owner = session().id;
    const open1 = childTodo(owner, "backlog");
    const open2 = childTodo(owner, "executing");
    childTodo(owner, "in_review");
    childTodo(owner, "done");
    childTodo(session().id, "executing");
    expect(watch.openChildrenOf(owner).todoIds.sort()).toEqual([open1.id, open2.id].sort());
  });

  it("counts open children of the Todo the session is linked to, and delegate-created Todos", () => {
    const owner = session().id;
    const parent = workItems.createWorkItem({ title: "linked parent", source: "human" });
    db.prepare("UPDATE sessions SET work_item_id = ? WHERE id = ?").run(parent.id, owner);
    const viaLink = workItems.createWorkItem({ title: "c1", source: "human", parentId: parent.id, status: "executing" });
    const other = workItems.createWorkItem({ title: "other parent", source: "human" });
    const viaDelegate = workItems.createWorkItem({
      title: "c2", source: "session", sourceRef: `delegate:${owner}:abc`, parentId: other.id, status: "backlog", assignee: "worker",
    });
    expect(watch.openChildrenOf(owner).todoIds.sort()).toEqual([viaLink.id, viaDelegate.id].sort());
  });

  it("ignores a parked backlog child: auto-start off, assigned or not, or the operator's", () => {
    const owner = session().id;
    const optedOut = childTodo(owner, "backlog");
    setAutoStart(optedOut.id, false);
    const optedOutUnassigned = childTodo(owner, "backlog", null);
    setAutoStart(optedOutUnassigned.id, false);
    childTodo(owner, "backlog", "@operator");
    expect(watch.openChildrenOf(owner).todoIds).toEqual([]);
  });

  it("counts an unassigned backlog child with auto-start on: the board walk picks its employee", () => {
    const owner = session().id;
    const unassigned = childTodo(owner, "backlog", null);
    expect(unassigned.assignee).toBeNull();
    expect(watch.openChildrenOf(owner).todoIds).toEqual([unassigned.id]);
  });

  it("counts a backlog child that will be dispatched, and a parked one with a session in flight", () => {
    const owner = session().id;
    const dispatched = childTodo(owner, "backlog");
    setAutoStart(dispatched.id, true);
    const parked = childTodo(owner, "backlog", null);
    setAutoStart(parked.id, false);
    const running = session();
    db.prepare("UPDATE sessions SET work_item_id = ? WHERE id = ?").run(parked.id, running.id);
    registry.updateSession(running.id, { status: "idle" });
    expect(watch.openChildrenOf(owner).todoIds).toEqual([dispatched.id]);
    registry.updateSession(running.id, { status: "running" });
    expect(watch.openChildrenOf(owner).todoIds.sort()).toEqual([dispatched.id, parked.id].sort());
  });

  it("counts in-flight child sessions only", () => {
    const owner = session().id;
    const running = session(owner);
    const done = session(owner);
    registry.updateSession(running.id, { status: "running" });
    registry.updateSession(done.id, { status: "idle" });
    expect(watch.openChildrenOf(owner).sessionIds).toEqual([running.id]);
  });
});

describe("child-watch firing", () => {
  it("delivers when children are open", () => {
    const owner = session().id;
    childTodo(owner, "executing");
    watch.armChildWatch(owner, 0);
    const deliver = vi.fn();
    expect(scheduler.sweepOnce({ now: () => 3_600_001, deliver })).toBe(1);
    expect(deliver).toHaveBeenCalledOnce();
    expect(deliver.mock.calls[0]![0]).toMatchObject({ purpose: "child-watch", message: watch.CHILD_WATCH_MESSAGE });
  });

  it("disarms with children-settled and delivers nothing when none are open", () => {
    const owner = session().id;
    childTodo(owner, "done");
    watch.armChildWatch(owner, 0);
    const id = armed(owner)[0]!.id;
    const deliver = vi.fn();
    // Within the 24 h expiry, so the disarm reason is the child check and not "expired".
    expect(scheduler.sweepOnce({ now: () => 3_600_001, deliver })).toBe(0);
    expect(deliver).not.toHaveBeenCalled();
    expect(store.getHeartbeat(id)).toMatchObject({ status: "disarmed", disarmedReason: "children-settled" });
  });

  it("disarms with children-settled when only parked backlog children remain", () => {
    const owner = session().id;
    const unassigned = childTodo(owner, "backlog", null);
    setAutoStart(unassigned.id, false);
    const optedOut = childTodo(owner, "backlog");
    setAutoStart(optedOut.id, false);
    watch.armChildWatch(owner, 0);
    const id = armed(owner)[0]!.id;
    const deliver = vi.fn();
    expect(scheduler.sweepOnce({ now: () => 3_600_001, deliver })).toBe(0);
    expect(deliver).not.toHaveBeenCalled();
    expect(store.getHeartbeat(id)).toMatchObject({ status: "disarmed", disarmedReason: "children-settled" });
  });

  it("keeps delivering for a dispatchable backlog child", () => {
    const owner = session().id;
    childTodo(owner, "backlog");
    watch.armChildWatch(owner, 0);
    const deliver = vi.fn();
    expect(scheduler.sweepOnce({ now: () => 3_600_001, deliver })).toBe(1);
    expect(deliver).toHaveBeenCalledOnce();
  });

  it("leaves a manual heartbeat alone when it comes due with no children", () => {
    const owner = session().id;
    const manual = store.armHeartbeat({ ownerSessionId: owner, message: "mine", everySeconds: 60 }, 0);
    const deliver = vi.fn();
    expect(scheduler.sweepOnce({ now: () => 60_001, deliver })).toBe(1);
    expect(store.getHeartbeat(manual.id)!.status).toBe("armed");
  });
});

describe("releaseChildWatchIfSettled", () => {
  it("drops the watch when only a parked backlog child is left", () => {
    const owner = session().id;
    const parked = childTodo(owner, "backlog", null);
    setAutoStart(parked.id, false);
    watch.armChildWatch(owner);
    expect(watch.releaseChildWatchIfSettled(owner)).toBe(true);
    expect(armed(owner)).toHaveLength(0);
  });

  it("keeps the watch while a child is open and drops it when the last one settles", () => {
    const owner = session().id;
    const child = childTodo(owner, "executing");
    watch.armChildWatch(owner);
    expect(watch.releaseChildWatchIfSettled(owner)).toBe(false);
    expect(armed(owner)).toHaveLength(1);
    db.prepare("UPDATE work_items SET status = 'in_review' WHERE id = ?").run(child.id);
    expect(watch.releaseChildWatchIfSettled(owner)).toBe(true);
    expect(armed(owner)).toHaveLength(0);
    expect(db.prepare("SELECT disarmed_reason FROM heartbeats WHERE owner_session_id = ?").pluck().get(owner)).toBe("children-settled");
  });

  it("disarms once a parent-completion callback to the session is accepted and nothing is left open", async () => {
    const parent = session();
    const child = session(parent.id);
    registry.updateSession(child.id, { status: "idle" });
    watch.armChildWatch(parent.id);
    const callbacks = await import("../../sessions/callbacks.js");
    const fetchStub = vi.fn(async (_url: string, init: { body: string }) => {
      const { callbackDeliveryId } = JSON.parse(init.body) as { callbackDeliveryId: string };
      registry.acceptSessionDelivery(callbackDeliveryId, parent.id, parent.sessionKey || parent.id);
      return { ok: true } as Response;
    });
    vi.stubGlobal("fetch", fetchStub);
    try {
      const { delivery } = registry.claimSessionDelivery({
        targetSessionId: parent.id, sourceKind: "session", sourceId: child.id, sourceAttempt: "a1",
        sourceOutcome: "succeeded", sourceVersion: 1, deliveryKind: "parent-completion",
        payload: { message: "done", displayMessage: "done" },
      });
      await callbacks.deliverClaimedSessionDelivery(delivery.id);
    } finally {
      vi.unstubAllGlobals();
    }
    expect(fetchStub).toHaveBeenCalledOnce();
    expect(armed(parent.id)).toHaveLength(0);
  });

  it("disarms when the delivery was accepted but the callback request itself failed", async () => {
    const parent = session();
    const child = session(parent.id);
    registry.updateSession(child.id, { status: "idle" });
    watch.armChildWatch(parent.id);
    const callbacks = await import("../../sessions/callbacks.js");
    vi.stubGlobal("fetch", vi.fn(async (_url: string, init: { body: string }) => {
      const { callbackDeliveryId } = JSON.parse(init.body) as { callbackDeliveryId: string };
      registry.acceptSessionDelivery(callbackDeliveryId, parent.id, parent.sessionKey || parent.id);
      throw new Error("connection reset after accept");
    }));
    try {
      const { delivery } = registry.claimSessionDelivery({
        targetSessionId: parent.id, sourceKind: "session", sourceId: child.id, sourceAttempt: "a1",
        sourceOutcome: "succeeded", sourceVersion: 1, deliveryKind: "parent-completion",
        payload: { message: "done", displayMessage: "done" },
      });
      expect(await callbacks.deliverClaimedSessionDelivery(delivery.id)).toBe("accepted");
    } finally {
      vi.unstubAllGlobals();
    }
    expect(armed(parent.id)).toHaveLength(0);
  });

  it("keeps the watch after a completion callback when a sibling is still in flight", async () => {
    const parent = session();
    const done = session(parent.id);
    const running = session(parent.id);
    registry.updateSession(done.id, { status: "idle" });
    registry.updateSession(running.id, { status: "running" });
    watch.armChildWatch(parent.id);
    const callbacks = await import("../../sessions/callbacks.js");
    vi.stubGlobal("fetch", vi.fn(async (_url: string, init: { body: string }) => {
      const { callbackDeliveryId } = JSON.parse(init.body) as { callbackDeliveryId: string };
      registry.acceptSessionDelivery(callbackDeliveryId, parent.id, parent.sessionKey || parent.id);
      return { ok: true } as Response;
    }));
    try {
      const { delivery } = registry.claimSessionDelivery({
        targetSessionId: parent.id, sourceKind: "session", sourceId: done.id, sourceAttempt: "a1",
        sourceOutcome: "succeeded", sourceVersion: 1, deliveryKind: "parent-completion",
        payload: { message: "done", displayMessage: "done" },
      });
      await callbacks.deliverClaimedSessionDelivery(delivery.id);
    } finally {
      vi.unstubAllGlobals();
    }
    expect(armed(parent.id)).toHaveLength(1);
  });
});

describe("heartbeats.purpose migration", () => {
  it("adds the column and index to a pre-existing table, and is idempotent", async () => {
    const { migrateHeartbeatsSchema } = await import("../migrate.js");
    const old = new Database(":memory:");
    old.exec(`
      CREATE TABLE heartbeats (
        id TEXT PRIMARY KEY, owner_session_id TEXT NOT NULL, message TEXT NOT NULL,
        every_seconds INTEGER NOT NULL, next_fire_at INTEGER NOT NULL, fire_count INTEGER NOT NULL DEFAULT 0,
        max_fires INTEGER, expires_at INTEGER, status TEXT NOT NULL DEFAULT 'armed',
        created_at TEXT NOT NULL, disarmed_at TEXT, disarmed_reason TEXT
      );
      INSERT INTO heartbeats (id, owner_session_id, message, every_seconds, next_fire_at, created_at)
        VALUES ('h1', 's1', 'm', 60, 1, '2026-01-01T00:00:00Z');
    `);
    migrateHeartbeatsSchema(old);
    migrateHeartbeatsSchema(old);
    const columns = (old.prepare("PRAGMA table_info(heartbeats)").all() as Array<{ name: string }>).filter((c) => c.name === "purpose");
    expect(columns).toHaveLength(1);
    expect(old.prepare("SELECT purpose FROM heartbeats WHERE id = 'h1'").pluck().get()).toBeNull();
    expect(old.prepare("SELECT name FROM sqlite_master WHERE name = 'idx_heartbeats_owner_purpose'").get()).toBeDefined();
    old.close();
  });
});
