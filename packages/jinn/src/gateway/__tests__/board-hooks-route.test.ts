import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import type { ServerResponse } from "node:http";
import yaml from "js-yaml";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { CALLER_SESSION_CAPABILITY_HEADER, CALLER_SESSION_HEADER, TOOL_CALL_HEADER, TOOL_CALL_HEADER_VALUE, ensureSessionCapability } from "../../mcp/identity.js";

/**
 * Board hooks through the real HTTP handler: a Todo moved by the status route
 * fires hooks after the write, never waits on them, and cannot be moved by a
 * hook's own session into firing the same hook again. spawnSession is stubbed
 * (what it starts is not the subject); everything else is the real gateway code.
 */

const spawnMock = vi.fn();
vi.mock("../spawn-session.js", () => ({ spawnSession: (...args: unknown[]) => spawnMock(...args) }));

const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "jinn-board-hooks-route-"));
process.env.JINN_HOME = tmpHome;
const configPath = path.join(tmpHome, "config.yaml");

fs.mkdirSync(path.join(tmpHome, "org"), { recursive: true });
fs.writeFileSync(
  path.join(tmpHome, "org", "qa-emp.yaml"),
  ["name: qa-emp", "displayName: QA Employee", "department: qa", "rank: employee", "engine: codex", "model: gpt-5.5", "persona: QA employee for route tests", ""].join("\n"),
);

type Api = typeof import("../api.js");
let api: Api;
let reg: typeof import("../../sessions/registry.js");
let store: typeof import("../../work-items/store.js");
let transitions: typeof import("../../work-items/transitions.js");
let labels: typeof import("../../work-items/labels.js");
let runs: typeof import("../../board-hooks/run-store.js");
let boardHooks: typeof import("../../board-hooks/index.js");
let db: ReturnType<typeof import("../../shared/db.js").initDb>;
const emitted: Array<{ event: string; payload: { id: string; hook: string; status: string } }> = [];

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
  reloadConfig: () => { config = { ...config, hooks: (yaml.load(fs.readFileSync(configPath, "utf8")) as { hooks: unknown[] }).hooks }; },
  connectors: new Map(),
  startTime: Date.now(),
  gatewayAuthToken: "test-token",
  emit: (event: string, payload: { id: string; hook: string; status: string }) => emitted.push({ event, payload }),
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

const reviewHook = (extra: Record<string, unknown> = {}) => ({
  name: "on-review",
  event: "todo.status_changed",
  match: { from: "executing", to: "in_review", label: "needs-merge" },
  action: { spawn: { employee: "qa-emp", prompt: "{{todo.id}} is ready" } },
  ...extra,
});

/** A labelled, executing Todo assigned to qa-emp. */
function executingTodo(title = "Hooked"): string {
  const item = store.createWorkItem({ title, assignee: "qa-emp" });
  labels.addWorkItemLabels(item.id, ["needs-merge"], "operator");
  transitions.transition(item.id, "executing", "operator", { human: true, manual: true });
  return item.id;
}

const moveToReview = (id: string, headers: Record<string, string> = {}) =>
  call("POST", `/api/work-items/${id}/status`, { status: "in_review", note: "ready" }, headers);
const runsFor = (todo: string) => runs.listRuns({ todo, limit: 100 }).runs;

beforeAll(async () => {
  api = await import("../api.js");
  reg = await import("../../sessions/registry.js");
  store = await import("../../work-items/store.js");
  transitions = await import("../../work-items/transitions.js");
  labels = await import("../../work-items/labels.js");
  runs = await import("../../board-hooks/run-store.js");
  boardHooks = await import("../../board-hooks/index.js");
  db = (await import("../../shared/db.js")).initDb();
  labels.createLabel({ name: "needs-merge" });
});

beforeEach(() => {
  config = structuredClone(baseConfig);
  emitted.length = 0;
  spawnMock.mockReset();
  db.prepare("DELETE FROM board_hook_runs").run();
  boardHooks.installBoardHooks(apiCtx);
});

afterEach(() => boardHooks.stopBoardHooks());
afterAll(() => boardHooks.stopBoardHooks());

describe("a Todo moved through the status route", () => {
  it("returns 200 whatever the spawn does, then spawns once with the payload and records the session", async () => {
    config.hooks = [reviewHook()];
    spawnMock.mockReturnValue(new Promise(() => undefined));
    const first = executingTodo("never resolves");
    const moved = await moveToReview(first);
    expect(moved.status).toBe(200);
    expect(moved.body.workItem.status).toBe("in_review");
    await vi.waitFor(() => expect(spawnMock).toHaveBeenCalledTimes(1));
    expect(runsFor(first)).toMatchObject([{ action: "spawn", status: "running", sessionId: null }]);

    spawnMock.mockReset();
    spawnMock.mockImplementation(async (_ctx: unknown, input: { provenance: { source: string; sourceRef: string } }) => {
      // By the time the spawn runs, the move it reacts to has committed.
      expect(store.getWorkItem(second)!.status).toBe("in_review");
      const session = reg.createSession({ engine: "codex", source: input.provenance.source, sourceRef: input.provenance.sourceRef, employee: "qa-emp" });
      return { ok: true, dispatched: true, session };
    });
    const second = executingTodo("resolves");
    expect((await moveToReview(second)).status).toBe(200);
    await vi.waitFor(() => expect(runsFor(second)[0]?.status).toBe("ok"));
    expect(spawnMock).toHaveBeenCalledTimes(1);
    const [, input] = spawnMock.mock.calls[0];
    expect(input.employee).toBe("qa-emp");
    expect(input.prompt.startsWith(`${second} is ready\n\n\`\`\`json\n`)).toBe(true);
    const payload = JSON.parse(input.prompt.slice(input.prompt.indexOf("```json\n") + 8, input.prompt.lastIndexOf("\n```")));
    expect(payload).toMatchObject({ hook: "on-review", event: "todo.status_changed", from: "executing", to: "in_review", text: "ready", todo: { id: second, labels: ["needs-merge"] }, actor: { kind: "operator" } });
    const row = runs.getRun(runsFor(second)[0].id)!;
    expect(row.sessionId).toBe(reg.getSessionBySourceRef(input.provenance.sourceRef)!.id);
    expect(emitted.filter((frame) => frame.payload.id === row.id).map((frame) => frame.payload.status)).toEqual(["running", "ok"]);
  });

  it("is not held up by a command that hangs, and records one that fails", async () => {
    config.hooks = [
      reviewHook({ name: "hangs", action: { command: { run: "sleep 1000" } } }),
      reviewHook({ name: "fails", action: { command: { run: "echo no; exit 1" } } }),
    ];
    const id = executingTodo();
    const moved = await moveToReview(id);
    expect(moved.status).toBe(200);
    await vi.waitFor(() => expect(runsFor(id)).toHaveLength(2));
    await vi.waitFor(() => expect(runsFor(id).find((run) => run.hook === "fails")?.status).toBe("error"));
    expect(runsFor(id).find((run) => run.hook === "hangs")?.status).toBe("running");
    expect(runs.getRun(runsFor(id).find((run) => run.hook === "fails")!.id)).toMatchObject({ exitCode: 1, output: "no\n" });
    expect(store.getWorkItem(id)!.status).toBe("in_review");
  });

  it("does not fire the hook again when the session it spawned moves the Todo", async () => {
    config.hooks = [reviewHook()];
    let hookSessionId = "";
    spawnMock.mockImplementation(async (_ctx: unknown, input: { provenance: { source: string; sourceRef: string } }) => {
      const session = reg.createSession({ engine: "codex", source: input.provenance.source, sourceRef: input.provenance.sourceRef, employee: "qa-emp" });
      hookSessionId = session.id;
      return { ok: true, dispatched: true, session };
    });
    const id = executingTodo();
    expect((await moveToReview(id)).status).toBe(200);
    await vi.waitFor(() => expect(runsFor(id)[0]?.status).toBe("ok"));
    expect(reg.getSession(hookSessionId)!.source).toBe("hook");

    transitions.transition(id, "executing", "operator", { human: true });
    const again = await moveToReview(id, asSession(hookSessionId));
    expect(again.status).toBe(200);
    await vi.waitFor(() => expect(runsFor(id)).toHaveLength(2));
    const suppressed = runsFor(id)[0];
    expect(suppressed).toMatchObject({ hook: "on-review", action: "none", status: "suppressed", chain: ["on-review"] });
    expect(suppressed.error).toMatch(/already in this event's chain/);
    expect(spawnMock).toHaveBeenCalledTimes(1);

    // An operator's own move still fires it.
    transitions.transition(id, "executing", "operator", { human: true });
    await moveToReview(id);
    await vi.waitFor(() => expect(spawnMock).toHaveBeenCalledTimes(2));
  });
});

describe("/api/hooks", () => {
  beforeEach(() => {
    fs.writeFileSync(configPath, yaml.dump({ engines: { claude: { bin: "claude", model: "opus" } }, hooks: [reviewHook({ name: "first" }), reviewHook({ name: "second", enabled: false, allowReentry: true, action: { notify: { connector: "telegram", channel: 99, text: "x" } } })] }));
    config.hooks = (yaml.load(fs.readFileSync(configPath, "utf8")) as { hooks: unknown[] }).hooks;
  });

  it("lists the hooks with their last run, and the config problems", async () => {
    config.hooks = [...(config.hooks as unknown[]), { name: "BROKEN", event: "nope", action: {} }];
    spawnMock.mockResolvedValue({ ok: true, dispatched: true, session: { id: "s-listed" } });
    const id = executingTodo();
    await moveToReview(id);
    await vi.waitFor(() => expect(runsFor(id)[0]?.status).toBe("ok"));
    const listed = await call("GET", "/api/hooks");
    expect(listed.status).toBe(200);
    expect(listed.body.hooks).toHaveLength(2);
    expect(listed.body.hooks[0]).toMatchObject({
      name: "first", enabled: true, events: ["todo.status_changed"], allowReentry: false, lastStatus: "ok",
      match: { from: "executing", to: "in_review", label: "needs-merge" }, actions: [{ kind: "spawn", employee: "qa-emp" }],
    });
    expect(listed.body.hooks[0].lastFiredAt).toMatch(/^\d{4}-/);
    expect(listed.body.hooks[1]).toMatchObject({ name: "second", enabled: false, allowReentry: true, lastFiredAt: null, lastStatus: null, actions: [{ kind: "notify", connector: "telegram", channel: "99" }] });
    expect(listed.body.problems.length).toBeGreaterThan(0);
    expect(listed.body.problems.every((problem: string) => problem.startsWith("hooks[2] (BROKEN): "))).toBe(true);
  });

  it("lists runs with filters and a cursor, and reads one with its payload and output", async () => {
    config.hooks = [reviewHook({ name: "cmd", action: { command: { run: "echo hi" } } })];
    const ids = [executingTodo("a"), executingTodo("b"), executingTodo("c")];
    for (const id of ids) await moveToReview(id);
    await vi.waitFor(() => expect(runs.listRuns({ hook: "cmd", status: "ok" }).runs).toHaveLength(3));
    const page = await call("GET", "/api/hooks/runs?hook=cmd&limit=2");
    expect(page.body.runs).toHaveLength(2);
    expect(page.body.runs[0]).not.toHaveProperty("payload");
    expect(page.body.nextBefore).toBe(page.body.runs[1].id);
    const rest = await call("GET", `/api/hooks/runs?hook=cmd&limit=2&before=${page.body.nextBefore}`);
    expect(rest.body.runs).toHaveLength(1);
    expect(rest.body.nextBefore).toBeNull();
    expect((await call("GET", `/api/hooks/runs?todo=${ids[1]}`)).body.runs).toHaveLength(1);
    expect((await call("GET", "/api/hooks/runs?status=suppressed")).body.runs).toEqual([]);
    expect((await call("GET", "/api/hooks/runs?status=bogus")).status).toBe(400);
    const detail = await call("GET", `/api/hooks/runs/${page.body.runs[0].id}`);
    expect(detail.status).toBe(200);
    expect(detail.body.run).toMatchObject({ hook: "cmd", status: "ok", output: "hi\n", payload: { hook: "cmd" } });
    expect((await call("GET", "/api/hooks/runs/bhr_missing")).status).toBe(404);
  });

  it("toggles enabled in config.yaml in place and reloads the config", async () => {
    fs.writeFileSync(configPath, "# keep this comment\nengines:\n  claude:\n    bin: claude\nhooks:\n  - name: first\n    event: todo.status_changed\n    action:\n      command:\n        run: echo hi\n  - name: second # trailing\n    enabled: false\n    event: todo.created\n    action:\n      command:\n        run: echo hi\n");
    config.hooks = (yaml.load(fs.readFileSync(configPath, "utf8")) as { hooks: unknown[] }).hooks;
    expect((await call("POST", "/api/hooks/second/enabled", { enabled: true })).body).toEqual({ ok: true });
    const text = fs.readFileSync(configPath, "utf8");
    expect(text).toContain("# keep this comment");
    expect(text).toContain("# trailing");
    expect((yaml.load(text) as { hooks: Array<{ name: string; enabled?: boolean }> }).hooks.map((hook) => [hook.name, hook.enabled])).toEqual([["first", undefined], ["second", true]]);
    expect((config.hooks as Array<{ enabled?: boolean }>)[1].enabled).toBe(true);
    await call("POST", "/api/hooks/first/enabled", { enabled: false });
    expect((yaml.load(fs.readFileSync(configPath, "utf8")) as { hooks: Array<{ enabled?: boolean }> }).hooks[0].enabled).toBe(false);
    expect((await call("GET", "/api/hooks")).body.hooks.map((hook: { enabled: boolean }) => hook.enabled)).toEqual([false, true]);
  });

  it("answers 404 for an unknown hook and 400 for a bad body", async () => {
    expect((await call("POST", "/api/hooks/nope/enabled", { enabled: true })).status).toBe(404);
    expect((await call("POST", "/api/hooks/first/enabled", { enabled: "yes" })).status).toBe(400);
    expect((await call("POST", "/api/hooks/first/enabled", {})).status).toBe(400);
  });

  it("is operator-only: an employee session is refused on every route", async () => {
    const session = reg.createSession({ engine: "codex", source: "web", sourceRef: "web:qa-emp:hooks", employee: "qa-emp" });
    const headers = asSession(session.id);
    expect((await call("GET", "/api/hooks", undefined, headers)).status).toBe(403);
    expect((await call("GET", "/api/hooks/runs", undefined, headers)).status).toBe(403);
    expect((await call("GET", "/api/hooks/runs/bhr_x", undefined, headers)).status).toBe(403);
    expect((await call("POST", "/api/hooks/first/enabled", { enabled: false }, headers)).status).toBe(403);
    expect((yaml.load(fs.readFileSync(configPath, "utf8")) as { hooks: Array<{ enabled?: boolean }> }).hooks[0].enabled).toBeUndefined();
  });
});
