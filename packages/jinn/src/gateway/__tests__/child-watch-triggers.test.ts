import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { call, startRouteHarness, stopRouteHarness, type Registry, type WorkItems } from "./todo-route-harness.js";

/**
 * The gateway arms the caller's child-watch heartbeat on the three routes that
 * create child work: a Todo with a parent, a delegation, and a session spawn.
 * The owner is the verified caller session, never a body field, and the
 * operator's surface (no session) arms nothing.
 */

let registry: Registry;
let workItems: WorkItems;
let store: typeof import("../../heartbeats/store.js");
let db: import("better-sqlite3").Database;
let ids: { CALLER_SESSION_CAPABILITY_HEADER: string; CALLER_SESSION_HEADER: string; TOOL_CALL_HEADER: string; TOOL_CALL_HEADER_VALUE: string };
let capability: (sessionId: string) => string | undefined;

beforeAll(async () => {
  ({ registry, workItems } = await startRouteHarness());
  store = await import("../../heartbeats/store.js");
  db = (await import("../../shared/db.js")).initDb();
  const identity = await import("../../mcp/identity.js");
  ids = identity;
  capability = identity.ensureSessionCapability;
});
afterAll(stopRouteHarness);
beforeEach(() => { db.prepare("DELETE FROM heartbeats").run(); });

let seq = 0;
const newSession = () => registry.createSession({ engine: "codex", source: "web", sourceRef: `trigger-${++seq}` }).id;

function asSession(sessionId: string): Record<string, string> {
  return {
    [ids.TOOL_CALL_HEADER]: ids.TOOL_CALL_HEADER_VALUE,
    [ids.CALLER_SESSION_HEADER]: sessionId,
    [ids.CALLER_SESSION_CAPABILITY_HEADER]: capability(sessionId)!,
  };
}

const watches = (sessionId: string) =>
  store.listHeartbeatsForSession(sessionId).filter((heartbeat) => heartbeat.purpose === "child-watch");
const allWatches = () => db.prepare("SELECT COUNT(*) FROM heartbeats WHERE purpose = 'child-watch'").pluck().get() as number;

describe("POST /api/work-items with a parentId", () => {
  it("arms one child-watch for the calling session, once, and pushes its expiry on a second child", async () => {
    const caller = newSession();
    const parent = workItems.createWorkItem({ title: "parent", source: "human" });
    const first = await call("POST", "/api/work-items", { title: "c1", parentId: parent.id }, asSession(caller));
    expect(first.status).toBe(201);
    const [armed] = watches(caller);
    expect(armed).toBeDefined();
    db.prepare("UPDATE heartbeats SET expires_at = 1 WHERE id = ?").run(armed!.id);
    const second = await call("POST", "/api/work-items", { title: "c2", parentId: parent.id }, asSession(caller));
    expect(second.status).toBe(201);
    expect(watches(caller)).toHaveLength(1);
    expect(watches(caller)[0]!.expiresAt).toBeGreaterThan(Date.now());
  });

  it("still arms for a session holding the maximum of manual heartbeats", async () => {
    const caller = newSession();
    for (let i = 0; i < store.MAX_ARMED_PER_SESSION; i++) {
      store.armHeartbeat({ ownerSessionId: caller, message: `m${i}`, everySeconds: 60 });
    }
    const parent = workItems.createWorkItem({ title: "parent", source: "human" });
    expect((await call("POST", "/api/work-items", { title: "c", parentId: parent.id }, asSession(caller))).status).toBe(201);
    expect(watches(caller)).toHaveLength(1);
  });

  it("arms nothing for a Todo with no parent, or from the operator surface", async () => {
    const caller = newSession();
    const parent = workItems.createWorkItem({ title: "parent", source: "human" });
    expect((await call("POST", "/api/work-items", { title: "root" }, asSession(caller))).status).toBe(201);
    expect((await call("POST", "/api/work-items", { title: "op child", parentId: parent.id })).status).toBe(201);
    expect(allWatches()).toBe(0);
  });
});

describe("POST /api/delegations", () => {
  it("arms one child-watch for the delegating session, not the delegate", async () => {
    const caller = newSession();
    const delegation = await call("POST", "/api/delegations", { employee: "route-worker", task: "Do the bounded thing." }, asSession(caller));
    expect(delegation.status).toBe(201);
    expect(watches(caller)).toHaveLength(1);
    expect(watches(delegation.body.sessionId as string)).toHaveLength(0);
    await call("POST", "/api/delegations", { employee: "route-worker", task: "And another." }, asSession(caller));
    expect(watches(caller)).toHaveLength(1);
  });

  it("arms nothing for an operator delegation", async () => {
    const delegation = await call("POST", "/api/delegations", { employee: "route-worker", task: "Operator task." });
    expect(delegation.status).toBe(201);
    expect(allWatches()).toBe(0);
  });
});

describe("POST /api/sessions", () => {
  it("arms one child-watch for a session that spawns a child, and not twice", async () => {
    const caller = newSession();
    const spawn = await call("POST", "/api/sessions", { prompt: "Look into it.", engine: "codex" }, asSession(caller));
    expect(spawn.status).toBe(201);
    expect(watches(caller)).toHaveLength(1);
    await call("POST", "/api/sessions", { prompt: "And again.", engine: "codex" }, asSession(caller));
    expect(watches(caller)).toHaveLength(1);
    const listed = await call("GET", "/api/heartbeats", undefined, asSession(caller));
    expect(listed.body.heartbeats.map((h: { purpose: string | null }) => h.purpose)).toEqual(["child-watch"]);
  });

  it("arms nothing for an operator spawn", async () => {
    expect((await call("POST", "/api/sessions", { prompt: "Operator run.", engine: "codex" })).status).toBe(201);
    expect(allWatches()).toBe(0);
  });
});
