import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import type { ServerResponse } from "node:http";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { JinnConfig, Session } from "../../shared/types.js";

/**
 * A department-scoped employee runs only on claude. A delegation to one must
 * start on claude whatever the delegating session runs on and whatever the
 * engine-health reroute would prefer, and must refuse up front, before any
 * session is linked, when the caller or the Todo names another engine. A
 * delegate that died before its first turn must not cost its delegator the
 * one hand-off it had.
 */

const home = fs.mkdtempSync(path.join(os.tmpdir(), "jinn-scoped-delegation-engine-"));
process.env.JINN_HOME = home;
const HEALTH_PATH = path.join(home, "tmp", "engine-health.json");

vi.mock("../../shared/models.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../shared/models.js")>()),
  engineAvailable: () => true,
}));

const { CALLER_SESSION_CAPABILITY_HEADER, CALLER_SESSION_HEADER, TOOL_CALL_HEADER, TOOL_CALL_HEADER_VALUE, ensureSessionCapability } =
  await import("../../mcp/identity.js");
const { resetDepartmentFixtures, writeDepartmentFile, writeEmployeeFile } = await import("./department-fixtures.js");

let api: typeof import("../api.js");
let registry: typeof import("../../sessions/registry.js");
let workItems: typeof import("../../work-items/store.js");
let dispatchConfig: typeof import("../../work-items/dispatch-config.js");
let refreshOrg: typeof import("../org-registry.js").refreshOrg;
let assignWorkItem: typeof import("../../work-items/assignment.js").assignWorkItem;

/** Never answers by default: most tests read the rows a delegation writes, not a turn. */
let engineRun: () => Promise<never> = () => new Promise(() => {});
const engineStub = {
  name: "stub",
  run: () => engineRun(),
  isAlive: () => false,
  kill: () => {},
  killAll: () => {},
};

const queueStub = {
  enqueue: async (_key: string, fn: () => Promise<void>) => fn(),
  clearCancelled: () => {},
  clearQueue: () => {},
  pauseQueue: () => {},
  resumeQueue: () => {},
  holdForCallbackDrain: () => {},
  releaseCallbackDrain: () => {},
  hasInFlightItem: () => false,
  getPendingCount: () => 0,
  getTransportState: (_key: string, status: string) => status,
};

/** A claude whose binary is missing, so a scoped claude turn is refused before it starts. */
const MISSING_CLAUDE = path.join(home, "no-such-bin", "claude");
/**
 * An absolute, executable stub for opencode, so opencode's availability is a
 * property of this fixture rather than of whatever happens to be on the host's
 * PATH. `getModelRegistry` reports `available` from an in-module
 * `engineAvailable` the vi.mock below cannot intercept, so a bare `"opencode"`
 * resolved via PATH (or `~/.local/bin`) and the reroute depended on the host.
 */
const FAKE_OPENCODE = path.join(home, "bin", "opencode");
fs.mkdirSync(path.dirname(FAKE_OPENCODE), { recursive: true });
fs.writeFileSync(FAKE_OPENCODE, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
fs.chmodSync(FAKE_OPENCODE, 0o755);

const config = {
  gateway: { port: 7799, host: "127.0.0.1" },
  engines: {
    default: "claude",
    claude: { bin: MISSING_CLAUDE, model: "sonnet", fallback: ["opencode"] },
    opencode: { bin: FAKE_OPENCODE, model: "deepseek" },
  },
  models: {
    claude: { default: "sonnet", models: [{ id: "sonnet" }] },
    opencode: { default: "deepseek", models: [{ id: "deepseek" }] },
  },
  connectors: {},
  logging: { file: false, stdout: false, level: "error" },
  mcp: { gateway: { enabled: true } },
} as unknown as JinnConfig;

const context = {
  getConfig: () => config,
  connectors: new Map(),
  startTime: Date.now(),
  gatewayAuthToken: "test-token",
  emit: () => undefined,
  reloadOrg: () => {},
  sessionManager: {
    getEngine: () => engineStub,
    getEngines: () => new Map([["claude", engineStub], ["opencode", engineStub]]),
    getQueue: () => queueStub,
  },
} as unknown as import("../api.js").ApiContext;

async function call(url: string, body: unknown, callerSessionId?: string): Promise<{ status: number; body: any }> {
  let status = 200;
  let raw = "";
  const identity: Record<string, string> = callerSessionId
    ? {
        [TOOL_CALL_HEADER]: TOOL_CALL_HEADER_VALUE,
        [CALLER_SESSION_HEADER]: callerSessionId,
        [CALLER_SESSION_CAPABILITY_HEADER]: ensureSessionCapability(callerSessionId),
      }
    : {};
  const req = Object.assign(Readable.from([Buffer.from(JSON.stringify(body))]), {
    method: "POST",
    url,
    headers: { host: "localhost", authorization: "Bearer test-token", "content-type": "application/json", ...identity },
  });
  const res = {
    writeHead(next: number) { status = next; return this; },
    setHeader() { return this; },
    end(chunk?: Buffer | string) { if (chunk) raw += chunk.toString(); },
  } as unknown as ServerResponse;
  await api.handleApiRequest(req as never, res, context);
  return { status, body: raw ? JSON.parse(raw) : undefined };
}

const BRIEF = "Complete the Todo acceptance criteria and report evidence.";

function delegate(callerSessionId: string, workItemId: string, extra: Record<string, unknown> = {}) {
  return call("/api/delegations", { workItemId, employee: "lab-dev", task: BRIEF, ...extra }, callerSessionId);
}

/** The operator presses Dispatch on a Todo assigned to the scoped employee, or to `assignee`. */
async function dispatchedTodo(title: string, assignee = "lab-dev", department = "lab"): Promise<{ id: string; dispatcherId: string }> {
  const item = workItems.createWorkItem({ title, source: "human", status: "backlog", assignee, department });
  const dispatched = await call(`/api/work-items/${item.id}/dispatch`, {});
  expect(dispatched.status).toBe(201);
  return { id: item.id, dispatcherId: dispatched.body.sessionId as string };
}

function claudeSpent(): void {
  const reset = new Date(Date.now() + 60 * 60_000).toISOString();
  fs.mkdirSync(path.dirname(HEALTH_PATH), { recursive: true });
  fs.writeFileSync(HEALTH_PATH, JSON.stringify({
    claude: { state: "exhausted", until: reset, recheckAt: reset, reason: "quota window spent" },
  }));
}

function executeSessions(workItemId: string): Session[] {
  return registry.listSessionsByWorkItem(workItemId).filter((session) => session.employee === "lab-dev");
}

async function settledInError(sessionId: string): Promise<Session> {
  await vi.waitFor(() => expect(registry.getSession(sessionId)?.status).toBe("error"), { timeout: 5_000 });
  return registry.getSession(sessionId)!;
}

beforeAll(async () => {
  const dbModule = await import("../../shared/db.js");
  api = await import("../api.js");
  registry = await import("../../sessions/registry.js");
  workItems = await import("../../work-items/store.js");
  dispatchConfig = await import("../../work-items/dispatch-config.js");
  ({ refreshOrg } = await import("../org-registry.js"));
  ({ assignWorkItem } = await import("../../work-items/assignment.js"));
  dbModule.initDb();
  resetDepartmentFixtures();
  writeDepartmentFile("lab", "name: lab\nscope: scoped\n");
  writeEmployeeFile("lab", "lab-dev", { department: "lab" });
  writeEmployeeFile("lab", "lab-lead", { department: "lab" });
  writeEmployeeFile("platform", "open-dev", { department: "platform" });
  refreshOrg();
  const { setJinnAttachGate } = await import("../../mcp/attachment.js");
  setJinnAttachGate({ ok: true });
});

afterAll(async () => {
  const { setJinnAttachGate } = await import("../../mcp/attachment.js");
  setJinnAttachGate(null);
});

beforeEach(() => {
  fs.rmSync(HEALTH_PATH, { force: true });
  engineRun = () => new Promise(() => {});
});

describe("delegating to a department-scoped employee", () => {
  it("starts the delegate on claude when the caller runs on another engine and claude's allowance is spent", async () => {
    claudeSpent();
    const { id, dispatcherId } = await dispatchedTodo("Routed while claude is spent");
    registry.updateSession(dispatcherId, { engine: "opencode" });

    const delegated = await delegate(dispatcherId, id);

    expect(delegated.status).toBe(201);
    expect(delegated.body.engine).toBe("claude");
    const child = registry.getSession(delegated.body.sessionId)!;
    expect(child.engine).toBe("claude");
    expect((child.transportMeta as Record<string, unknown> | null)?.engineOverride).toBeUndefined();
  });

  it("still reroutes an open employee off a spent engine", async () => {
    claudeSpent();
    const delegated = await call("/api/delegations", { employee: "open-dev", task: BRIEF });
    expect(delegated.status).toBe(201);
    expect(registry.getSession(delegated.body.sessionId)?.engine).toBe("opencode");
  });

  it("refuses a named non-claude engine before linking anything, and a corrected retry succeeds", async () => {
    const { id, dispatcherId } = await dispatchedTodo("Named the wrong engine");

    const refused = await delegate(dispatcherId, id, { engine: "opencode" });

    expect(refused.status).toBe(400);
    expect(refused.body.error).toMatch(/lab-dev.*department "lab".*claude/);
    expect(executeSessions(id)).toHaveLength(0);
    expect(workItems.getWorkItem(id)?.assignee).toBe("lab-dev");

    const retried = await delegate(dispatcherId, id, { engine: "claude" });
    expect(retried.status).toBe(201);
    expect(registry.getSession(retried.body.sessionId)?.engine).toBe("claude");
  });

  it("refuses to set a Todo engine override its scoped delegate cannot run on", async () => {
    const { id } = await dispatchedTodo("Todo pinned to another engine at set time");

    const refused = dispatchConfig.setTodoDispatchConfig(id, { engine: "opencode" }, config);

    expect(refused.ok).toBe(false);
    expect(refused.ok === false && refused.error).toMatch(/run only on the claude engine/);
    expect(dispatchConfig.getTodoDispatchConfig(id)?.engine ?? null).toBeNull();
  });

  it("refuses a stored Todo engine override the scoped delegate cannot run on, before linking anything", async () => {
    const { id, dispatcherId } = await dispatchedTodo("Todo pinned to another engine");
    // As left behind by a release that validated the override against the registry only.
    const db = (await import("../../shared/db.js")).initDb();
    db.prepare("INSERT INTO work_item_dispatch (work_item_id, skills, engine, model, updated_at) VALUES (?, NULL, ?, NULL, ?)")
      .run(id, "opencode", new Date().toISOString());

    const refused = await delegate(dispatcherId, id);

    expect(refused.status).toBe(409);
    expect(refused.body.error).toMatch(/claude/);
    expect(refused.body.error).toContain(id);
    expect(executeSessions(id)).toHaveLength(0);
  });
});

describe("a delegate refused before its engine ever ran", () => {
  it("leaves the Todo re-delegatable by the same caller", async () => {
    const { id, dispatcherId } = await dispatchedTodo("Delegate refused at start");
    const first = await delegate(dispatcherId, id);
    expect(first.status).toBe(201);
    const dead = await settledInError(first.body.sessionId);
    expect(dead.transportMeta).toMatchObject({ engineReach: "never" });

    const again = await delegate(dispatcherId, id);

    expect(again.status).toBe(201);
    expect(again.body.sessionId).not.toBe(first.body.sessionId);
    expect(registry.getSession(again.body.sessionId)).toMatchObject({ employee: "lab-dev", parentSessionId: dispatcherId, workItemId: id });
  });

  it("is judged on the latest execution attempt, whatever consult sessions a mention linked since", async () => {
    const { id, dispatcherId } = await dispatchedTodo("Delegate refused, then a mention");
    const first = await delegate(dispatcherId, id);
    await settledInError(first.body.sessionId);
    const consulted = registry.createSession({ engine: "claude", source: "web", sourceRef: "consult:1", connector: "web", employee: "lab-lead", prompt: "x" });
    workItems.linkSession(id, consulted.id, "test", "consult");

    expect((await delegate(dispatcherId, id)).status).toBe(201);
  });

  it("gives that second chance once: a second refused delegate means the cause persists", async () => {
    const { id, dispatcherId } = await dispatchedTodo("Delegate refused twice");
    await settledInError((await delegate(dispatcherId, id)).body.sessionId);
    const retried = await delegate(dispatcherId, id);
    expect(retried.status).toBe(201);
    await settledInError(retried.body.sessionId);

    const third = await delegate(dispatcherId, id);

    expect(third.status).toBe(403);
    expect(third.body.error).toMatch(/this Dispatcher's hand-off is spent/);
  });

  it("does not hand that second chance to anyone else", async () => {
    const { id, dispatcherId } = await dispatchedTodo("Delegate refused, outsider tries");
    const first = await delegate(dispatcherId, id);
    await settledInError(first.body.sessionId);
    const outsider = registry.createSession({ engine: "claude", source: "web", sourceRef: "outsider:1", connector: "web", employee: "open-dev", prompt: "x" });

    const refused = await delegate(outsider.id, id);

    expect(refused.status).toBe(403);
    expect(refused.body.error).toMatch(/does not own Todo/);
  });

  it("does not override a reassignment made since", async () => {
    const { id, dispatcherId } = await dispatchedTodo("Delegate refused, then reassigned");
    await settledInError((await delegate(dispatcherId, id)).body.sessionId);
    assignWorkItem(id, "lab-lead", "lab", "operator");

    const again = await delegate(dispatcherId, id);

    expect(again.status).toBe(403);
    expect(workItems.getWorkItem(id)?.assignee).toBe("lab-lead");
    // Resuming the old delegate would restart work the operator moved elsewhere.
    expect(again.body.error).not.toContain("send_to_session");
  });

  it("keeps the one-shot rule for a delegate whose engine ran, even when its first turn threw", async () => {
    const { id, dispatcherId } = await dispatchedTodo("Delegate ran, then threw", "open-dev", "platform");
    engineRun = () => Promise.reject(new Error("engine process exited unexpectedly"));
    const first = await call("/api/delegations", { workItemId: id, employee: "open-dev", task: BRIEF }, dispatcherId);
    expect(first.status).toBe(201);
    const dead = await settledInError(first.body.sessionId);
    expect(dead.totalTurns).toBe(0);
    expect(dead.transportMeta).toMatchObject({ engineReach: "reached" });

    const again = await call("/api/delegations", { workItemId: id, employee: "open-dev", task: BRIEF }, dispatcherId);

    expect(again.status).toBe(403);
    expect(again.body.error).toMatch(/this Dispatcher's hand-off is spent/);
    // The Dispatcher is told to stand down, not to resume the dead delegate.
    expect(again.body.error).not.toContain("send_to_session");
  });
});
