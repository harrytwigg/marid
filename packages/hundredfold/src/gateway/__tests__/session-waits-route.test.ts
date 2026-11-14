import { beforeAll, describe, expect, it } from "vitest";
import { as, call, context, sessionOf, startScopedHarness } from "./department-scope-harness.js";
import type { Session } from "../../shared/types.js";
import type { BackgroundTasksReport, DelegatedSessionWait, SessionWaitItem, SessionWaitsResponse } from "../../shared/session-waits.js";
import type { WorkItem } from "../../work-items/store.js";

/**
 * GET /api/sessions/:id/waits against the real API, registry and heartbeat store: the shape, the
 * order, the 404 for a session the caller may not read, and a child it may not read held back.
 */

let workItems: Awaited<ReturnType<typeof startScopedHarness>>["workItems"];
let registry: Awaited<ReturnType<typeof startScopedHarness>>["registry"];
let heartbeats: typeof import("../../heartbeats/store.js");
let todo: WorkItem;

const unknownSession = "00000000-0000-4000-8000-000000000000";
const monitor = { kind: "monitor", id: "mon-1", description: "watch", command: "tail -f x", agentType: null, startedAt: "2026-10-15T10:00:00.000Z", lastOutput: { line: "ready", at: "2026-10-15T10:01:00.000Z" }, timeoutMs: 60_000 } as const;

const reports = new Map<string, BackgroundTasksReport>();

const waits = async (id: string, caller = call): Promise<{ status: number; body: SessionWaitsResponse & { error?: string } }> =>
  caller("GET", `/api/sessions/${id}/waits`) as never;
const asCaller = (id: string) => (method: string, url: string) => as(id)(method, url);
const running = (session: Session) => registry.updateSession(session.id, { status: "running" });

beforeAll(async () => {
  ({ workItems, registry } = await startScopedHarness());
  heartbeats = await import("../../heartbeats/store.js");
  todo = workItems.createWorkItem({ title: "waits-todo", department: "engineering", assignee: "eng-dev" });
  (context as { ptyViewEngines?: unknown }).ptyViewEngines = {
    claude: { name: "claude", run: async () => ({}), backgroundTasks: (id: string) => reports.get(id) ?? { tasks: [] } },
  };
});

describe("GET /api/sessions/:id/waits", () => {
  it("answers 404 for an unknown session", async () => {
    const response = await waits(unknownSession);
    expect(response.status).toBe(404);
  });

  it("is empty for a session waiting on nothing", async () => {
    const parent = await sessionOf("eng-dev");
    const response = await waits(parent.id);
    expect(response.status).toBe(200);
    expect(response.body).toEqual({ sessionId: parent.id, generatedAt: expect.any(String), items: [] });
  });

  it("lists delegated children, the engine's tasks and armed heartbeats in order", async () => {
    const parent = await sessionOf("eng-dev");
    const dev = await sessionOf("eng-dev", { parentSessionId: parent.id });
    const reviewer = await sessionOf("route-worker", { parentSessionId: parent.id });
    workItems.linkSession(todo.id, dev.id, "operator", "execute");
    workItems.linkSession(todo.id, reviewer.id, "operator", "review");
    running(dev);
    running(reviewer);
    const beat = heartbeats.armHeartbeat({ ownerSessionId: parent.id, message: "check back", everySeconds: 120 });

    const body = (await waits(parent.id)).body;

    expect(body.items.map((item: SessionWaitItem) => item.kind)).toEqual(["session", "session", "heartbeat"]);
    const [first, second, heartbeat] = body.items as [SessionWaitItem, SessionWaitItem, SessionWaitItem];
    expect([first, second]).toEqual(expect.arrayContaining([
      expect.objectContaining({
        sessionId: dev.id, reportsTo: parent.id, relation: "delegated", restricted: false, employee: "eng-dev",
        employeeDisplayName: "eng-dev", todo: { id: todo.id, title: "waits-todo" }, status: "running", active: true, endedAt: null, archived: false,
      }),
      expect.objectContaining({ sessionId: reviewer.id, relation: "review", employee: "route-worker", employeeDisplayName: "Route Worker", status: "running", active: true }),
    ]));
    expect(heartbeat).toMatchObject({ kind: "heartbeat", id: beat.id, message: "check back", everySeconds: 120, fireCount: 0, maxFires: null });
  });

  it("lists what the session's engine reports after its sessions and before its heartbeats", async () => {
    const parent = await sessionOf("eng-dev");
    const child = await sessionOf("eng-dev", { parentSessionId: parent.id });
    running(child);
    heartbeats.armHeartbeat({ ownerSessionId: parent.id, message: "later", everySeconds: 600 });
    reports.set(parent.id, { tasks: [monitor], rerun: { startedAt: null } });

    const items = (await waits(parent.id)).body.items;

    expect(items.map((item: SessionWaitItem) => item.kind)).toEqual(["session", "monitor", "rerun", "heartbeat"]);
    expect(items[1]).toEqual(monitor);
    expect(items[2]).toEqual({ kind: "rerun", startedAt: null });
  });

  it("shows a finished child as inactive with its end, until the parent's next turn", async () => {
    const parent = await sessionOf("eng-dev");
    registry.updateSession(parent.id, { lastActivity: "2026-10-15T09:00:00.000Z" });
    const failed = await sessionOf("eng-dev", { parentSessionId: parent.id });
    registry.updateSession(failed.id, { status: "error", lastActivity: "2026-10-15T09:30:00.000Z" });

    const [item] = (await waits(parent.id)).body.items;
    expect(item).toMatchObject({ kind: "session", sessionId: failed.id, status: "error", active: false, endedAt: "2026-10-15T09:30:00.000Z" });

    registry.updateSession(parent.id, { lastActivity: "2026-10-15T10:00:00.000Z" });
    expect((await waits(parent.id)).body.items).toEqual([]);
  });
});

describe("a session the registry lists no longer", () => {
  it("still lists its finished children once it is archived", async () => {
    const parent = await sessionOf("eng-dev");
    registry.updateSession(parent.id, { lastActivity: "2026-10-15T09:00:00.000Z" });
    const done = await sessionOf("eng-dev", { parentSessionId: parent.id });
    registry.updateSession(done.id, { status: "idle", lastActivity: "2026-10-15T09:30:00.000Z" });
    expect((await waits(parent.id)).body.items).toHaveLength(1);

    registry.updateSession(parent.id, { archivedAt: "2026-10-15T09:40:00.000Z" });

    const items = (await waits(parent.id)).body.items;
    expect(items).toEqual([expect.objectContaining({ kind: "session", sessionId: done.id, active: false })]);
  });
});

describe("a scoped caller", () => {
  it("cannot read the waits of a session outside its department, which answers as an unknown id does", async () => {
    const self = await sessionOf("side-dev");
    const outside = await sessionOf("eng-dev");

    const hidden = await waits(outside.id, asCaller(self.id));
    const unknown = await waits(unknownSession, asCaller(self.id));

    expect({ status: hidden.status, body: hidden.body }).toEqual({ status: 404, body: unknown.body });
  });

  it("reads its own waits, and sees a child outside its department as restricted", async () => {
    const self = await sessionOf("side-dev");
    const peer = await sessionOf("side-qa", { parentSessionId: self.id });
    const outside = await sessionOf("eng-dev", { parentSessionId: self.id });
    running(peer);
    running(outside);

    const response = await waits(self.id, asCaller(self.id));

    expect(response.status).toBe(200);
    const sessions = response.body.items.filter((item): item is DelegatedSessionWait => item.kind === "session");
    expect(sessions).toHaveLength(2);
    expect(sessions.find((item) => item.sessionId === peer.id)).toMatchObject({ restricted: false, employee: "side-qa" });
    // The gate's redaction also hides the id of a session outside the department.
    expect(sessions.find((item) => item.restricted)).toMatchObject({
      sessionId: "hidden", reportsTo: self.id, employee: null, employeeDisplayName: null, title: null, todo: null, status: "running",
    });
  });

  it("does not name another department's Todo that a child of its own works", async () => {
    const self = await sessionOf("side-dev");
    const peer = await sessionOf("side-qa", { parentSessionId: self.id });
    // The store refuses this link for a bound session; only a link made around it, by an unscoped
    // actor or before the department was bound, can leave one standing.
    const { initDb } = await import("../../shared/db.js");
    initDb().prepare("UPDATE sessions SET work_item_id = ?, work_item_role = 'execute' WHERE id = ?").run(todo.id, peer.id);
    running(peer);

    const [item] = (await waits(self.id, asCaller(self.id))).body.items;

    expect(item).toMatchObject({ sessionId: peer.id, restricted: false, relation: "delegated", employee: "side-qa", todo: null });
    expect(JSON.stringify(item)).not.toContain("waits-todo");
  });
});
