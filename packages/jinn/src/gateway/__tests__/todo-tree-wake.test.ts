import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * The gateway's wiring of the Todo-tree wake: the roster is the real org
 * directory, the wake goes through the real outbox and message hop, and a
 * wake that tells an owner's session disarms its child-watch heartbeat once
 * nothing is left open.
 */

const home = fs.mkdtempSync(path.join(os.tmpdir(), "jinn-todo-tree-wake-"));
process.env.JINN_HOME = home;

let wiring: typeof import("../todo-tree-wake.js");
let registry: typeof import("../../sessions/registry.js");
let store: typeof import("../../work-items/store.js");
let transitions: typeof import("../../work-items/transitions.js");
let watch: typeof import("../../heartbeats/child-watch.js");
let heartbeats: typeof import("../../heartbeats/store.js");
let db: import("better-sqlite3").Database;

const config = { gateway: {}, engines: { default: "claude", claude: { model: "sonnet" } }, sessions: {} };
const context = { getConfig: () => config } as unknown as import("../api.js").ApiContext;

beforeAll(async () => {
  fs.mkdirSync(path.join(home, "org", "general"), { recursive: true });
  fs.writeFileSync(path.join(home, "org", "general", "wiring-owner.yaml"),
    "name: wiring-owner\ndisplayName: Wiring Owner\ndepartment: general\nrank: senior\nengine: claude\nmodel: sonnet\npersona: owns the parent\n");
  wiring = await import("../todo-tree-wake.js");
  registry = await import("../../sessions/registry.js");
  store = await import("../../work-items/store.js");
  transitions = await import("../../work-items/transitions.js");
  watch = await import("../../heartbeats/child-watch.js");
  heartbeats = await import("../../heartbeats/store.js");
  db = (await import("../../shared/db.js")).initDb();
  // The callback's HTTP hop: the owner's session accepts what the outbox sends.
  vi.stubGlobal("fetch", async (_url: string, init: { body: string }) => {
    const { callbackDeliveryId } = JSON.parse(init.body) as { callbackDeliveryId: string };
    const delivery = registry.getSessionDelivery(callbackDeliveryId)!;
    registry.acceptSessionDelivery(delivery.id, delivery.targetSessionId, registry.getSession(delivery.targetSessionId)!.sessionKey!);
    return { ok: true, status: 200 } as Response;
  });
}, 60_000);

afterAll(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("startTodoTreeWake", () => {
  it("wakes the roster's owner and disarms its child-watch once the last child has settled", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"] });
    const stop = wiring.startTodoTreeWake(context);
    try {
      const parent = store.createWorkItem({ title: "wired parent", status: "executing", source: "session", assignee: "wiring-owner" });
      const owner = registry.createSession({ engine: "claude", source: "web", sourceRef: "web:wiring-owner", employee: "wiring-owner" });
      db.prepare("UPDATE sessions SET work_item_id = ?, work_item_role = 'execute' WHERE id = ?").run(parent.id, owner.id);
      const first = store.createWorkItem({ title: "first", status: "executing", source: "session", assignee: "wiring-worker", parentId: parent.id });
      const second = store.createWorkItem({ title: "second", status: "executing", source: "session", assignee: "wiring-worker", parentId: parent.id });
      watch.armChildWatch(owner.id);
      const armed = () => heartbeats.listHeartbeatsForSession(owner.id).filter((heartbeat) => heartbeat.purpose === "child-watch");
      expect(armed()).toHaveLength(1);

      transitions.transition(first.id, "in_review", "board-walk");
      await vi.advanceTimersByTimeAsync(10_000);
      // Woken, but one child is still open: the watch stays.
      expect(db.prepare("SELECT count(*) FROM callback_deliveries WHERE target_session_id = ? AND delivery_kind = 'todo-child-settled'").pluck().get(owner.id)).toBe(1);
      expect(armed()).toHaveLength(1);

      transitions.transition(second.id, "done", "operator", { human: true });
      await vi.advanceTimersByTimeAsync(10_000);
      expect(armed()).toHaveLength(0);
      expect(db.prepare("SELECT disarmed_reason FROM heartbeats WHERE owner_session_id = ?").pluck().get(owner.id)).toBe("children-settled");
    } finally {
      stop();
    }
  });

  it("an employee outside the roster is not woken", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"] });
    const stop = wiring.startTodoTreeWake(context);
    try {
      const parent = store.createWorkItem({ title: "unlisted parent", status: "executing", source: "session", assignee: "not-in-the-org" });
      const session = registry.createSession({ engine: "claude", source: "web", sourceRef: "web:unlisted", employee: "not-in-the-org" });
      db.prepare("UPDATE sessions SET work_item_id = ?, work_item_role = 'execute' WHERE id = ?").run(parent.id, session.id);
      const child = store.createWorkItem({ title: "kid", status: "executing", source: "session", parentId: parent.id });
      transitions.transition(child.id, "in_review", "board-walk");
      await vi.advanceTimersByTimeAsync(10_000);
      expect(db.prepare("SELECT outcome FROM work_item_child_settles WHERE parent_id = ?").pluck().get(parent.id)).toBe("recorded");
    } finally {
      stop();
    }
  });
});
