import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import { Readable } from "node:stream";
import type { ServerResponse } from "node:http";
import { ensureSessionCapability } from "../../mcp/identity.js";

/**
 * Terminal sessions against the REAL gateway API and registry: only
 * the operator lists hosts or opens a shell, a terminal is a Session the sidebar
 * groups on its own, it never takes a message or runs a turn, and deleting it
 * ends its shell.
 */

type Api = typeof import("../api.js");
type Registry = typeof import("../../sessions/registry.js");

let api: Api;
let registry: Registry;
let preflight: typeof import("../../sessions/turn/preflight.js");

function makeRes() {
  const chunks: Buffer[] = [];
  const cap = {
    status: 0,
    res: {
      writeHead(status: number) { cap.status = status; return cap.res; },
      setHeader() {},
      end(chunk?: string | Buffer) { if (chunk) chunks.push(Buffer.from(chunk)); },
      write(chunk: string | Buffer) { chunks.push(Buffer.from(chunk)); return true; },
      headersSent: false,
    } as unknown as ServerResponse,
    get text() { return Buffer.concat(chunks).toString("utf-8"); },
  };
  return cap;
}

let terminalConfig: Record<string, unknown> | undefined;
const killedShells: string[] = [];
const emitted: Array<[string, unknown]> = [];
const engineStub = { name: "stub", run: async () => ({ result: "ok" }), isAlive: () => false, kill: () => {}, killAll: () => {} };
const queueStub = { clearQueue: () => {}, enqueue: async () => {}, getPendingCount: () => 0, getTransportState: (_k: string, s: string) => s };
const apiCtx = {
  getConfig: () => ({ gateway: {}, engines: { default: "codex" }, sessions: {}, ...(terminalConfig ? { terminal: terminalConfig } : {}) }),
  connectors: new Map(),
  startTime: Date.now(),
  gatewayAuthToken: "test-token",
  emit: (event: string, payload: unknown) => { emitted.push([event, payload]); },
  sessionManager: {
    getEngines: () => new Map([["codex", engineStub]]),
    getEngine: () => engineStub,
    getQueue: () => queueStub,
  },
  terminalEngine: { forget: (id: string) => { killedShells.push(id); } },
} as unknown as import("../api.js").ApiContext;

const operator = { authorization: "Bearer test-token" };

async function request(method: string, url: string, opts: { headers?: Record<string, string>; body?: unknown } = {}) {
  const raw = opts.body === undefined ? undefined : JSON.stringify(opts.body);
  const req = Object.assign(Readable.from(raw ? [Buffer.from(raw)] : []), {
    method,
    url,
    headers: { host: "gateway.test", ...(raw ? { "content-type": "application/json" } : {}), ...(opts.headers ?? {}) },
  });
  const cap = makeRes();
  await api.handleApiRequest(req as never, cap.res, apiCtx);
  let body: any = cap.text;
  try { body = JSON.parse(cap.text); } catch { /* non-JSON */ }
  return { status: cap.status, body };
}

function asSession(sessionId: string): Record<string, string> {
  return {
    "x-jinn-tool-call": "jinn-mcp",
    "x-jinn-caller-session": sessionId,
    "x-jinn-session-capability": ensureSessionCapability(sessionId)!,
  };
}

beforeAll(async () => {
  api = await import("../api.js");
  registry = await import("../../sessions/registry.js");
  preflight = await import("../../sessions/turn/preflight.js");
}, 60_000);

beforeEach(() => {
  terminalConfig = undefined;
  killedShells.length = 0;
  emitted.length = 0;
});

// Headroom for the first test, which pays the cold import under a loaded full run.
describe("terminal routes", { timeout: 30_000 }, () => {
  it("lists the gateway as a host for the operator", async () => {
    const res = await request("GET", "/api/terminals/hosts", { headers: operator });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ enabled: true, problems: [] });
    expect(res.body.hosts[0]).toMatchObject({ id: "local", kind: "local" });
  });

  it("refuses an agent session both the host list and a shell", async () => {
    const agent = registry.createSession({ engine: "codex", source: "web", sourceRef: "agent" }).id;
    expect((await request("GET", "/api/terminals/hosts", { headers: asSession(agent) })).status).toBe(403);
    const created = await request("POST", "/api/terminals", { headers: asSession(agent), body: { hostId: "local" } });
    expect(created.status).toBe(403);
    expect(created.body.error).toMatch(/operator-only/);
  });

  it("creates a terminal session on a known host and announces it", async () => {
    terminalConfig = { localLabel: "Pi" };
    const res = await request("POST", "/api/terminals", { headers: operator, body: { hostId: "local" } });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ engine: "terminal", source: "terminal", sourceRef: "local", title: "Pi", status: "idle" });
    expect(res.body.employee ?? null).toBeNull();
    expect(emitted).toContainEqual(["session:created", { sessionId: res.body.id }]);
  });

  it("refuses an unknown host and a disabled feature", async () => {
    expect((await request("POST", "/api/terminals", { headers: operator, body: { hostId: "nope" } })).status).toBe(404);
    terminalConfig = { enabled: false };
    expect((await request("POST", "/api/terminals", { headers: operator, body: { hostId: "local" } })).status).toBe(409);
    expect((await request("GET", "/api/terminals/hosts", { headers: operator })).body).toMatchObject({ enabled: false, hosts: [], problems: [] });
  });

  it("never takes a message and never runs a turn", async () => {
    const id = (await request("POST", "/api/terminals", { headers: operator, body: { hostId: "local" } })).body.id;
    const sent = await request("POST", `/api/sessions/${id}/message`, { headers: operator, body: { message: "rm -rf /" } });
    expect(sent.status).toBe(409);
    expect(sent.body.error).toMatch(/never runs an agent turn/);
    expect(registry.getMessages(id)).toHaveLength(0);
    const session = registry.getSession(id)!;
    const verdict = preflight.preflightTurn({ session, engines: new Map([["terminal", engineStub]]), config: {}, engineOverride: engineStub } as never);
    expect(verdict).toMatchObject({ ok: false });
  });

  it("has no turn to stop or reset", async () => {
    const id = (await request("POST", "/api/terminals", { headers: operator, body: { hostId: "local" } })).body.id;
    for (const action of ["stop", "reset"]) {
      const res = await request("POST", `/api/sessions/${id}/${action}`, { headers: operator });
      expect(res.status, action).toBe(409);
    }
    expect(killedShells).toEqual([]);
    expect(registry.getSession(id)!.status).toBe("idle");
  });

  it("is neither the COO portal nor a direct chat: it groups on its own", async () => {
    const id = (await request("POST", "/api/terminals", { headers: operator, body: { hostId: "local" } })).body.id;
    const session = registry.getSession(id)!;
    expect(registry.isPortalAgentSession(session)).toBe(false);
    expect(registry.listSessionsForGroup(registry.TERMINAL_GROUP, 100, 0).map((s) => s.id)).toContain(id);
    expect(registry.listSessionsForGroup(registry.DIRECT_GROUP, 100, 0).map((s) => s.id)).not.toContain(id);
    expect(registry.getSessionGroupCounts()[registry.TERMINAL_GROUP]).toBeGreaterThan(0);
  });

  it("ends the shell when the terminal session is deleted", async () => {
    const id = (await request("POST", "/api/terminals", { headers: operator, body: { hostId: "local" } })).body.id;
    const deleted = await request("DELETE", `/api/sessions/${id}`, { headers: operator });
    expect(deleted.status).toBe(200);
    expect(killedShells).toContain(id);
    expect(registry.getSession(id)).toBeUndefined();
  });
});
