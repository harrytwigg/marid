import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import type { ServerResponse } from "node:http";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { CALLER_SESSION_CAPABILITY_HEADER, CALLER_SESSION_HEADER, TOOL_CALL_HEADER, TOOL_CALL_HEADER_VALUE, ensureSessionCapability } from "../../mcp/identity.js";

/**
 * The worked example in docs/board-hooks.md, through the real HTTP handler: a hook on
 * `todo.status_changed` `to: in_review` with a label spawns a `closeTodos` employee, and
 * the close that employee makes (`in_review → done`) is a board event of its own that the
 * `to: in_review` hook does not match.
 */

const spawnMock = vi.fn();
vi.mock("../spawn-session.js", () => ({ spawnSession: (...args: unknown[]) => spawnMock(...args) }));

const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "jinn-board-hooks-closer-"));
process.env.JINN_HOME = tmpHome;
fs.mkdirSync(path.join(tmpHome, "org"), { recursive: true });
const employeeYaml = (name: string, extra: string[] = []) =>
  [`name: ${name}`, `displayName: ${name}`, "department: ops", "rank: employee", "engine: codex", "model: gpt-5.5", "persona: Route test employee", ...extra, ""].join("\n");
fs.writeFileSync(path.join(tmpHome, "org", "closer-emp.yaml"), employeeYaml("closer-emp", ["closeTodos: true"]));
fs.writeFileSync(path.join(tmpHome, "org", "worker-emp.yaml"), employeeYaml("worker-emp"));

let api: typeof import("../api.js");
let reg: typeof import("../../sessions/registry.js");
let store: typeof import("../../work-items/store.js");
let labels: typeof import("../../work-items/labels.js");
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

const reviewHook = {
  name: "close-on-review",
  event: "todo.status_changed",
  match: { to: "in_review", label: "auto-close" },
  action: { spawn: { employee: "closer-emp", prompt: "{{todo.id}} is in review: check its PR, merge, deploy and close it with a reason." } },
};
const runsOf = (hook: string) => runs.listRuns({ hook, limit: 100 }).runs;

beforeAll(async () => {
  api = await import("../api.js");
  reg = await import("../../sessions/registry.js");
  store = await import("../../work-items/store.js");
  labels = await import("../../work-items/labels.js");
  runs = await import("../../board-hooks/run-store.js");
  boardHooks = await import("../../board-hooks/index.js");
  db = (await import("../../shared/db.js")).initDb();
  labels.createLabel({ name: "auto-close" });
});

beforeEach(() => {
  config = structuredClone(baseConfig);
  spawnMock.mockReset();
  db.prepare("DELETE FROM board_hook_runs").run();
  boardHooks.installBoardHooks(apiCtx);
});

afterEach(() => boardHooks.stopBoardHooks());
afterAll(() => boardHooks.stopBoardHooks());

describe("a to: in_review hook that spawns a closeTodos employee", () => {
  it("fires on the handoff, and the close it makes does not fire it again", async () => {
    config.hooks = [reviewHook];
    const closers: string[] = [];
    spawnMock.mockImplementation(async (_ctx: unknown, input: { provenance: { source: string; sourceRef: string } }) => {
      const session = reg.createSession({ engine: "codex", source: input.provenance.source, sourceRef: input.provenance.sourceRef, employee: "closer-emp" });
      closers.push(session.id);
      return { ok: true, dispatched: true, session };
    });
    const item = store.createWorkItem({ title: "Reviewed work", status: "executing", assignee: "worker-emp" });
    labels.addWorkItemLabels(item.id, ["auto-close"], "operator");
    const worker = reg.createSession({ engine: "codex", source: "web", sourceRef: "web:worker", employee: "worker-emp" });

    const handoff = await call("POST", `/api/work-items/${item.id}/status`, { status: "in_review", note: "PR is up" }, asSession(worker.id));
    expect(handoff.status).toBe(200);
    await vi.waitFor(() => expect(runsOf("close-on-review")[0]?.status).toBe("ok"));
    expect(spawnMock).toHaveBeenCalledTimes(1);

    const closed = await call("POST", `/api/work-items/${item.id}/status`, { status: "done", note: "Merged and deployed" }, asSession(closers[0]));
    expect([closed.status, closed.body.workItem.status]).toEqual([200, "done"]);
    // The hook runs off the write path: give any (wrongly) matched event the tick it needs before counting.
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(runsOf("close-on-review")).toHaveLength(1);
    expect(spawnMock).toHaveBeenCalledTimes(1);
  });

  it("leaves a Todo without the label alone", async () => {
    config.hooks = [reviewHook];
    const item = store.createWorkItem({ title: "Unlabelled", status: "executing", assignee: "worker-emp" });
    const worker = reg.createSession({ engine: "codex", source: "web", sourceRef: "web:worker-2", employee: "worker-emp" });
    expect((await call("POST", `/api/work-items/${item.id}/status`, { status: "in_review", note: "PR is up" }, asSession(worker.id))).status).toBe(200);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(runsOf("close-on-review")).toHaveLength(0);
  });
});
