import { describe, expect, it } from "vitest";
import type { Heartbeat } from "../../heartbeats/types.js";
import type { Session } from "../../shared/types.js";
import { buildDelegatedActivityIndex } from "../delegated-activity.js";
import { buildSessionWaits, type SessionWaitsInput } from "../session-waits.js";

const NOW = Date.parse("2026-10-15T12:00:00.000Z");
const at = (minutes: number) => new Date(NOW + minutes * 60_000).toISOString();

function session(id: string, overrides: Partial<Session> = {}): Session {
  return {
    id,
    engine: "claude",
    employee: null,
    title: `title of ${id}`,
    parentSessionId: null,
    status: "idle",
    createdAt: at(-60),
    lastActivity: at(-30),
    ...overrides,
  } as Session;
}

function build(sessions: Session[], overrides: Partial<SessionWaitsInput> = {}) {
  return buildSessionWaits({
    sessionId: "root",
    now: NOW,
    sessions,
    activeSessionIds: new Set(),
    statusOf: (s) => s.status,
    canRead: () => true,
    employeeDisplayName: (employee) => `Display ${employee}`,
    todoTitle: (id) => `Todo ${id}`,
    openRunStartedAt: () => null,
    engine: null,
    heartbeats: [],
    parentOf: (s) => s.parentSessionId,
    ...overrides,
  });
}

const sessionItems = (response: ReturnType<typeof build>) => response.items.filter((item) => item.kind === "session");

describe("buildSessionWaits", () => {
  it("lists a monitor and two delegated children with their employee, relation and status", () => {
    const sessions = [
      session("root", { lastActivity: at(-10) }),
      session("dev", { parentSessionId: "root", employee: "builder", workItemId: "TODO-1", status: "running", createdAt: at(-20) }),
      session("qa", { parentSessionId: "root", employee: "checker", workItemId: "TODO-1", workItemRole: "review", status: "waiting", createdAt: at(-5) }),
    ];
    const monitor = { kind: "monitor" as const, id: "mon", description: "watch", command: "tail -f x", agentType: null, startedAt: at(-8), lastOutput: { line: "ok", at: at(-1) }, timeoutMs: 600_000 };

    const response = build(sessions, {
      activeSessionIds: new Set(["dev", "qa"]),
      engine: { tasks: [monitor] },
      openRunStartedAt: (s) => (s.id === "dev" ? at(-19) : null),
    });

    expect(response.sessionId).toBe("root");
    expect(response.generatedAt).toBe("2026-10-15T12:00:00.000Z");
    expect(response.items).toEqual([
      {
        kind: "session", sessionId: "dev", reportsTo: "root", relation: "delegated", restricted: false,
        employee: "builder", employeeDisplayName: "Display builder", title: "title of dev",
        todo: { id: "TODO-1", title: "Todo TODO-1" }, status: "running", active: true,
        since: at(-19), endedAt: null, archived: false,
      },
      {
        kind: "session", sessionId: "qa", reportsTo: "root", relation: "review", restricted: false,
        employee: "checker", employeeDisplayName: "Display checker", title: "title of qa",
        todo: { id: "TODO-1", title: "Todo TODO-1" }, status: "waiting", active: true,
        since: at(-5), endedAt: null, archived: false,
      },
      monitor,
    ]);
  });

  it("calls a session with no Todo, and a consult, plain sessions", () => {
    const sessions = [
      session("root"),
      session("spawned", { parentSessionId: "root", employee: "builder" }),
      session("consulted", { parentSessionId: "root", employee: "builder", workItemId: "TODO-2", workItemRole: "consult" }),
    ];

    const items = sessionItems(build(sessions, { activeSessionIds: new Set(["spawned", "consulted"]) }));

    expect(items.map((item) => [item.sessionId, item.relation, item.todo])).toEqual([
      ["consulted", "session", null],
      ["spawned", "session", null],
    ]);
  });

  it.each([
    ["completes", "idle"],
    ["fails", "error"],
    ["is stopped", "interrupted"],
  ] as const)("keeps a child that %s after the parent's last turn, inactive, with its status and end", (_how, status) => {
    const sessions = [
      session("root", { lastActivity: at(-10) }),
      session("done", { parentSessionId: "root", employee: "builder", status, lastActivity: at(-2) }),
    ];

    const [item] = sessionItems(build(sessions));

    expect(item).toMatchObject({ sessionId: "done", reportsTo: "root", status, active: false, endedAt: at(-2) });
  });

  it("drops a finished child once the parent has a newer lastActivity", () => {
    const sessions = [
      session("root", { lastActivity: at(-1) }),
      session("done", { parentSessionId: "root", status: "idle", lastActivity: at(-2) }),
    ];

    expect(build(sessions).items).toEqual([]);
  });

  it("lists active grandchildren under their own parent, and a finished grandchild not at all", () => {
    const sessions = [
      session("root", { lastActivity: at(-10) }),
      session("child", { parentSessionId: "root", status: "running", createdAt: at(-30) }),
      session("grand", { parentSessionId: "child", status: "running", createdAt: at(-20) }),
      session("gone", { parentSessionId: "child", status: "idle", lastActivity: at(-1) }),
    ];

    const items = sessionItems(build(sessions, { activeSessionIds: new Set(["child", "grand"]) }));

    expect(items.map((item) => [item.sessionId, item.reportsTo])).toEqual([["child", "root"], ["grand", "child"]]);
  });

  it("follows the reporting parent, not the raw parent", () => {
    const sessions = [
      session("root"),
      session("other"),
      session("worker", { parentSessionId: "other", status: "running" }),
    ];
    const parentOf = (s: Session) => (s.id === "worker" ? "root" : s.parentSessionId);

    const items = sessionItems(build(sessions, { activeSessionIds: new Set(["worker"]), parentOf }));

    expect(items.map((item) => [item.sessionId, item.reportsTo])).toEqual([["worker", "root"]]);
  });

  it("withholds a child the caller may not read but still says it is there", () => {
    const sessions = [
      session("root"),
      session("secret", { parentSessionId: "root", employee: "builder", workItemId: "TODO-9", status: "running" }),
    ];

    const [item] = sessionItems(build(sessions, { activeSessionIds: new Set(["secret"]), canRead: (s) => s.id !== "secret" }));

    expect(item).toEqual({
      kind: "session", sessionId: "secret", reportsTo: "root", relation: "delegated", restricted: true,
      employee: null, employeeDisplayName: null, title: null, todo: null,
      status: "running", active: true, since: at(-60), endedAt: null, archived: false,
    });
  });

  it("contains a reporting cycle that never reaches the session, and one that runs through it", () => {
    const apart = [
      session("root", { status: "running" }),
      session("a", { parentSessionId: "b", status: "running" }),
      session("b", { parentSessionId: "a", status: "running" }),
    ];
    expect(sessionItems(build(apart, { activeSessionIds: new Set(["root", "a", "b"]) }))).toEqual([]);

    const through = [
      session("root", { parentSessionId: "a", status: "running" }),
      session("a", { parentSessionId: "root", status: "running" }),
    ];
    const items = sessionItems(build(through, { activeSessionIds: new Set(["root", "a"]) }));
    expect(items.map((item) => [item.sessionId, item.reportsTo])).toEqual([["a", "root"]]);
  });

  it("marks an archived child", () => {
    const sessions = [
      session("root", { lastActivity: at(-10) }),
      session("old", { parentSessionId: "root", lastActivity: at(-1), archivedAt: at(-1) }),
    ];

    expect(sessionItems(build(sessions))[0]).toMatchObject({ sessionId: "old", archived: true });
  });

  it("orders active sessions, inactive sessions, then monitor, process, subagent, rerun and heartbeat", () => {
    const task = (kind: "monitor" | "process" | "subagent", id: string, startedAt: string) =>
      ({ kind, id, description: null, command: null, agentType: null, startedAt, lastOutput: null, timeoutMs: null });
    const heartbeat = { id: "hb", ownerSessionId: "root", message: "m".repeat(300), everySeconds: 120, nextFireAt: NOW + 60_000, fireCount: 1, maxFires: 4, expiresAt: null, status: "armed" } as Heartbeat;
    const sessions = [
      session("root", { lastActivity: at(-10) }),
      session("late", { parentSessionId: "root", status: "running", createdAt: at(-5) }),
      session("early", { parentSessionId: "root", status: "running", createdAt: at(-9) }),
      session("ended", { parentSessionId: "root", status: "idle", lastActivity: at(-1) }),
    ];

    const response = build(sessions, {
      activeSessionIds: new Set(["late", "early"]),
      heartbeats: [heartbeat],
      engine: {
        tasks: [task("subagent", "s1", at(-3)), task("process", "p2", at(-4)), task("process", "p1", at(-4)), task("monitor", "m1", at(-2))],
        rerun: { startedAt: null },
      },
    });

    expect(response.items.map((item) => (item.kind === "session" ? item.sessionId : item.kind === "rerun" ? "rerun" : item.id)))
      .toEqual(["early", "late", "ended", "m1", "p1", "p2", "s1", "rerun", "hb"]);
    expect(response.items.at(-1)).toEqual({
      kind: "heartbeat", id: "hb", message: "m".repeat(200), everySeconds: 120,
      nextFireAt: at(1), fireCount: 1, maxFires: 4,
    });
  });

  it("is empty for a session with nothing to wait on, and for an engine that reports nothing", () => {
    expect(build([session("root")]).items).toEqual([]);
    expect(build([session("root")], { engine: { tasks: [] } }).items).toEqual([]);
  });

  it("finds the same active sessions below each session as the delegated-activity count, on random graphs with cycles", () => {
    let seed = 12345;
    const next = (n: number) => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed % n; };
    for (let round = 0; round < 200; round++) {
      const size = 3 + next(8);
      const sessions = Array.from({ length: size }, (_, i) => session(`s${i}`, { parentSessionId: next(4) === 0 ? null : `s${next(size)}` }));
      const active = new Set(sessions.filter(() => next(2) === 0).map((s) => s.id));
      const index = buildDelegatedActivityIndex(sessions, active);
      for (const { id } of sessions) {
        const listed = sessionItems(build(sessions, { sessionId: id, activeSessionIds: active })).filter((item) => item.active);
        expect({ round, id, count: listed.length }).toEqual({ round, id, count: index.get(id)?.activeSessions ?? 0 });
      }
    }
  });
});
