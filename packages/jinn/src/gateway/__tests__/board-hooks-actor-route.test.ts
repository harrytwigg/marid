import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import type { ServerResponse } from "node:http";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { CALLER_SESSION_CAPABILITY_HEADER, CALLER_SESSION_HEADER, TOOL_CALL_HEADER, TOOL_CALL_HEADER_VALUE, ensureSessionCapability } from "../../mcp/identity.js";

/**
 * Who a board event says did it, through the real HTTP handler, for the writes
 * whose audit row does not carry the calling session: a create (its row records
 * only the source kind) and a dispatch. Both must name who did it, and a hook
 * session's own create or dispatch must not fire that hook again.
 */

const spawnMock = vi.fn();
vi.mock("../spawn-session.js", () => ({ spawnSession: (...args: unknown[]) => spawnMock(...args) }));

const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "jinn-board-hooks-actor-"));
process.env.JINN_HOME = tmpHome;
fs.mkdirSync(path.join(tmpHome, "org"), { recursive: true });
fs.writeFileSync(
  path.join(tmpHome, "org", "qa-emp.yaml"),
  ["name: qa-emp", "displayName: QA Employee", "department: qa", "rank: employee", "engine: codex", "model: gpt-5.5", "persona: QA employee for route tests", ""].join("\n"),
);

let api: typeof import("../api.js");
let reg: typeof import("../../sessions/registry.js");
let store: typeof import("../../work-items/store.js");
let runs: typeof import("../../board-hooks/run-store.js");
let boardHooks: typeof import("../../board-hooks/index.js");
let db: ReturnType<typeof import("../../shared/db.js").initDb>;

const baseConfig = {
  gateway: {},
  engines: { default: "claude", claude: { bin: "claude", model: "opus" }, codex: { bin: "codex", model: "gpt-5.5" } },
  models: { claude: { default: "opus", models: [{ id: "opus" }] }, codex: { default: "gpt-5.5", models: [{ id: "gpt-5.5" }] } },
  sessions: {},
  hooks: [] as unknown[],
};
let config: typeof baseConfig = structuredClone(baseConfig);

const apiCtx = {
  getConfig: () => config,
  connectors: new Map(),
  startTime: Date.now(),
  gatewayAuthToken: "test-token",
  emit: () => {},
  sessionManager: { getEngines: () => new Map(), getEngine: () => undefined, getQueue: () => ({}) },
} as unknown as import("../api.js").ApiContext;

function call(method: string, urlPath: string, body?: unknown, headers: Record<string, string> = {}): Promise<{ status: number; body: any }> {
  const payload = body !== undefined ? [Buffer.from(JSON.stringify(body))] : [];
  const req = Object.assign(Readable.from(payload), {
    method, url: urlPath, headers: { host: "localhost", "content-type": "application/json", authorization: "Bearer test-token", ...headers },
  });
  let status = 200;
  const chunks: Buffer[] = [];
  const res = {
    writeHead(s: number) { status = s; return this; },
    setHeader() { return this; },
    end(buf?: Buffer | string) { if (buf) chunks.push(Buffer.isBuffer(buf) ? buf : Buffer.from(buf)); },
  } as unknown as ServerResponse;
  return api.handleApiRequest(req as never, res, apiCtx).then(() => {
    const raw = Buffer.concat(chunks).toString("utf-8");
    let parsed: unknown = raw;
    try { parsed = JSON.parse(raw); } catch { /* not JSON */ }
    return { status, body: parsed };
  });
}

const asSession = (sessionId: string) => ({
  [CALLER_SESSION_HEADER]: sessionId,
  [CALLER_SESSION_CAPABILITY_HEADER]: ensureSessionCapability(sessionId),
  [TOOL_CALL_HEADER]: TOOL_CALL_HEADER_VALUE,
});

const createHook = { name: "on-create", event: "todo.created", action: { spawn: { employee: "qa-emp" } } };
const runsOf = (hook: string) => runs.listRuns({ hook, limit: 100 }).runs;
const create = (title: string, headers: Record<string, string> = {}) =>
  call("POST", "/api/work-items", { title }, headers);

/** Spawns record a real hook-provenance session, the way spawnSession does. */
function spawnHookSessions(): string[] {
  const ids: string[] = [];
  spawnMock.mockImplementation(async (_ctx: unknown, input: { provenance: { source: string; sourceRef: string } }) => {
    const session = reg.createSession({ engine: "codex", source: input.provenance.source, sourceRef: input.provenance.sourceRef, employee: "qa-emp" });
    ids.push(session.id);
    return { ok: true, dispatched: true, session };
  });
  return ids;
}

beforeAll(async () => {
  api = await import("../api.js");
  reg = await import("../../sessions/registry.js");
  store = await import("../../work-items/store.js");
  runs = await import("../../board-hooks/run-store.js");
  boardHooks = await import("../../board-hooks/index.js");
  db = (await import("../../shared/db.js")).initDb();
});

beforeEach(() => {
  config = structuredClone(baseConfig);
  spawnMock.mockReset();
  db.prepare("DELETE FROM board_hook_runs").run();
  boardHooks.installBoardHooks(apiCtx);
});

afterEach(() => boardHooks.stopBoardHooks());
afterAll(() => boardHooks.stopBoardHooks());

describe("todo.created", () => {
  it("names the operator as the creator of an operator's Todo", async () => {
    config.hooks = [{ ...createHook, match: { actor: "operator" } }];
    spawnHookSessions();
    expect((await create("From the operator")).status).toBe(201);
    await vi.waitFor(() => expect(runsOf("on-create")).toHaveLength(1));
    const run = runs.getRun(runsOf("on-create")[0].id)!;
    expect((run.payload as { actor: unknown }).actor).toEqual({ raw: "human", kind: "operator" });
  });

  it("names the employee and session that created a Todo", async () => {
    config.hooks = [{ ...createHook, match: { actor: "qa-emp" } }];
    spawnHookSessions();
    const session = reg.createSession({ engine: "codex", source: "web", sourceRef: "web:actor-test", employee: "qa-emp" });
    expect((await create("From an employee", asSession(session.id))).status).toBe(201);
    await vi.waitFor(() => expect(runsOf("on-create")).toHaveLength(1));
    const run = runs.getRun(runsOf("on-create")[0].id)!;
    expect((run.payload as { actor: unknown }).actor).toEqual({ raw: "session", kind: "employee", employee: "qa-emp", sessionId: session.id });
  });

  it("does not fire the hook again for a Todo its own session creates", async () => {
    config.hooks = [createHook];
    const hookSessions = spawnHookSessions();
    expect((await create("Seed")).status).toBe(201);
    await vi.waitFor(() => expect(runsOf("on-create")[0]?.status).toBe("ok"));

    expect((await create("Split out by the hook session", asSession(hookSessions[0]))).status).toBe(201);
    await vi.waitFor(() => expect(runsOf("on-create")).toHaveLength(2));
    expect(runsOf("on-create")[0]).toMatchObject({ action: "none", status: "suppressed", chain: ["on-create"] });
    expect(spawnMock).toHaveBeenCalledTimes(1);
  });
});

describe("todo.dispatched", () => {
  // The dispatch route records its caller on the link (startTodoDispatcher's
  // `actor`); the Dispatcher itself cannot start in this harness, so the link is
  // written the way it writes it.
  it("does not re-fire a hook already in the chain of the session that dispatched", async () => {
    config.hooks = [createHook, { name: "on-dispatch", event: "todo.dispatched", action: { notify: { connector: "none", channel: "x", text: "{{todo.id}}" } } }];
    const hookSessions = spawnHookSessions();
    const created = await create("Dispatch me");
    await vi.waitFor(() => expect(runsOf("on-create")[0]?.status).toBe("ok"));

    // Stand in for a hook session that on-dispatch is already upstream of.
    db.prepare("UPDATE board_hook_runs SET chain = ? WHERE hook = 'on-create'").run(JSON.stringify(["on-dispatch", "on-create"]));
    const dispatcher = reg.createSession({ engine: "codex", source: "web", sourceRef: "web:dispatcher", employee: "todo-dispatcher" });
    store.linkSession(created.body.workItem.id, dispatcher.id, `session:${hookSessions[0]}`, "execute", { via: "dispatch" });

    await vi.waitFor(() => expect(runsOf("on-dispatch")).toHaveLength(1));
    const run = runs.getRun(runsOf("on-dispatch")[0].id)!;
    expect(run).toMatchObject({ status: "suppressed", chain: ["on-dispatch", "on-create"] });
    expect((run.payload as { actor: unknown; sessionId: unknown })).toMatchObject({
      actor: { raw: `session:${hookSessions[0]}`, kind: "employee", employee: "qa-emp", sessionId: hookSessions[0] },
      sessionId: dispatcher.id,
    });
  });
});
