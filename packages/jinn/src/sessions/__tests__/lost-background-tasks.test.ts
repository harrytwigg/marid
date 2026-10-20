import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const home = fs.mkdtempSync(path.join(os.tmpdir(), "jinn-lost-background-"));
process.env.JINN_HOME = home;

const gatewayConfig: { resumeInterruptedSessions?: boolean } = {};
vi.mock("../../shared/config.js", () => ({
  loadConfig: vi.fn(() => ({ gateway: gatewayConfig })),
}));
vi.mock("../callback-connection.js", () => ({
  internalGatewayConnection: () => ({ baseUrl: "http://lost-background-fixture.invalid" }),
  internalGatewayHeaders: () => ({ "Content-Type": "application/json" }),
}));

type Registry = typeof import("../registry.js");
type LostBackgroundTasks = typeof import("../lost-background-tasks.js");
let registry: Registry;
let lostBackground: LostBackgroundTasks;
let callbacks: typeof import("../callbacks.js");
let db: import("better-sqlite3").Database;
let fetchMock: ReturnType<typeof vi.fn>;

beforeAll(async () => {
  registry = await import("../registry.js");
  lostBackground = await import("../lost-background-tasks.js");
  callbacks = await import("../callbacks.js");
  db = (await import("../../shared/db.js")).initDb();
});

beforeEach(() => {
  db.prepare("DELETE FROM callback_deliveries").run();
  db.prepare("DELETE FROM sessions").run();
  delete gatewayConfig.resumeInterruptedSessions;
  fetchMock = vi.fn(async () => new Response(null, { status: 204 }));
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  callbacks.__resetCallbackRetrySweepForTest();
  vi.unstubAllGlobals();
});

afterAll(() => {
  db.close();
  fs.rmSync(home, { recursive: true, force: true });
});

const TASKS = [
  { id: "bk2tests1", kind: "process" as const, command: "npm test", description: "Run the tests", agentType: null },
  { id: "bk2build2", kind: "monitor" as const, command: "tail -f build.log", description: null, agentType: null },
];

function idleSession(overrides: Record<string, unknown> = {}) {
  const created = registry.createSession({ engine: "claude", source: "web", sourceRef: `web:${Math.random()}` });
  if (Object.keys(overrides).length > 0) registry.updateSession(created.id, overrides);
  return registry.getSession(created.id)!;
}

function sentBodies(): Array<{ message: string; displayMessage: string; role: string }> {
  return fetchMock.mock.calls.map(([, init]) => JSON.parse(String((init as RequestInit).body)));
}

describe("notifyLostBackgroundTasks", () => {
  it("sends exactly one continue turn naming the lost task ids", async () => {
    const session = idleSession();

    const first = lostBackground.notifyLostBackgroundTasks(session.id, TASKS);
    // The same loss reported again (in either order) is the same nudge.
    const again = lostBackground.notifyLostBackgroundTasks(session.id, [...TASKS].reverse());
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));

    expect(first.claimed).toBe(true);
    expect(again).toEqual({ claimed: false, reason: expect.stringMatching(/^already-/) });
    const [url] = fetchMock.mock.calls[0];
    expect(String(url)).toBe(`http://lost-background-fixture.invalid/api/sessions/${session.id}/message`);
    const [body] = sentBodies();
    expect(body.role).toBe("notification");
    // Visible in the transcript as sent.
    expect(body.displayMessage).toBe(body.message);
    expect(body.message).toContain("bk2tests1");
    expect(body.message).toContain("bk2build2");
    expect(body.message).toContain("will never arrive");
  });

  it("nudges a later loss of different tasks again", async () => {
    const session = idleSession();
    lostBackground.notifyLostBackgroundTasks(session.id, TASKS.slice(0, 1));
    lostBackground.notifyLostBackgroundTasks(session.id, TASKS.slice(1));
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
  });

  it("sends nothing with no lost tasks", () => {
    const session = idleSession();
    expect(lostBackground.notifyLostBackgroundTasks(session.id, [])).toEqual({ claimed: false, reason: "no-tasks" });
    expect(db.prepare("SELECT COUNT(*) AS n FROM callback_deliveries").get()).toEqual({ n: 0 });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("leaves an archived session, a board walk turn and an unknown session alone", () => {
    const archived = idleSession({ archivedAt: new Date().toISOString() });
    expect(lostBackground.notifyLostBackgroundTasks(archived.id, TASKS)).toEqual({ claimed: false, reason: "archived" });
    expect(lostBackground.notifyLostBackgroundTasks("no-such-session", TASKS)).toEqual({ claimed: false, reason: "no-session" });
    const created = registry.createSession({ engine: "claude", source: "cron", sourceRef: "board-walk:tick-1", sessionKey: "board-walk:tick-1" });
    expect(lostBackground.notifyLostBackgroundTasks(created.id, TASKS).claimed).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("respects resumeInterruptedSessions: false", () => {
    gatewayConfig.resumeInterruptedSessions = false;
    const session = idleSession();
    expect(lostBackground.notifyLostBackgroundTasks(session.id, TASKS)).toEqual({ claimed: false, reason: "disabled" });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("lostBackgroundTasksMessage", () => {
  it("lists each task with what it was running", () => {
    const message = lostBackground.lostBackgroundTasksMessage([
      ...TASKS,
      { id: "agent-7", kind: "subagent", command: null, description: "Review the diff", agentType: "reviewer" },
    ]);
    expect(message).toContain("- bk2tests1 (background Bash): Run the tests: `npm test`");
    expect(message).toContain("- bk2build2 (Monitor): `tail -f build.log`");
    expect(message).toContain("- agent-7 (background sub-agent): Review the diff: `reviewer`");
    expect(message).toMatch(/^\[Gateway\] This session's engine process ended while 3 background tasks it started were still running/);
  });
});
