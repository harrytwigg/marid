import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import type { ServerResponse } from "node:http";
import {
  CALLER_SESSION_CAPABILITY_HEADER,
  CALLER_SESSION_HEADER,
  TOOL_CALL_HEADER,
  TOOL_CALL_HEADER_VALUE,
  ensureSessionCapability,
} from "../../mcp/identity.js";

/**
 * the connector's session-control tools, driven through the REAL
 * handleApiRequest as a connector anchor — read a session's tail, message it,
 * delegate to a named employee, assign a Todo the connector did not create —
 * with the engine stubbed so every dispatched turn is observable. The anchor
 * itself must never reach the engine, even when a reply is addressed to it.
 */

const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "jinn-remote-mcp-session-control-"));
process.env.JINN_HOME = tmpHome;
process.env.JINN_WORKFLOW_EVIDENCE_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "jinn-remote-mcp-session-control-wf-"));
fs.mkdirSync(path.join(tmpHome, "org"), { recursive: true });
for (const [name, rank, reportsTo] of [["qa-emp", "employee", "org-root"], ["org-root", "executive", ""]] as const) {
  fs.writeFileSync(path.join(tmpHome, "org", `${name}.yaml`), [
    `name: ${name}`, "department: qa", `rank: ${rank}`, ...(reportsTo ? [`reportsTo: ${reportsTo}`] : []),
    "engine: codex", "model: gpt-5.5", "persona: Session-control fixture", "",
  ].join("\n"));
}

type Session = import("../../shared/types.js").Session;
let api: typeof import("../api.js");
let registry: typeof import("../../sessions/registry.js");
let store: typeof import("../../work-items/store.js");
let connector: Session;
let target: Session;
const processFetch = globalThis.fetch;

const engineRuns: string[] = [];
const engineStub = {
  name: "stub",
  run: async (opts: Record<string, unknown>) => {
    engineRuns.push(String(opts.sessionId));
    return { result: "Finished: the build passes." };
  },
  isAlive: () => false,
  kill: () => {},
  killAll: () => {},
};
const queueStub = {
  enqueue: async (_key: string, fn: () => Promise<void>) => { await fn(); },
  clearCancelled: () => {}, clearQueue: () => {}, pauseQueue: () => {}, resumeQueue: () => {},
  getPendingCount: () => 0,
  getTransportState: (_key: string, status: string) => status,
  holdForCallbackDrain: () => {}, releaseCallbackDrain: () => {}, hasInFlightItem: () => false,
};
const apiCtx = {
  getConfig: () => ({
    gateway: {},
    engines: { default: "codex", codex: { bin: "codex", model: "gpt-5.5" } },
    models: { codex: { default: "gpt-5.5", models: [{ id: "gpt-5.5" }] } },
    sessions: {}, mcp: {}, connectors: {},
  }),
  connectors: new Map(),
  startTime: Date.now(),
  gatewayAuthToken: "test-token",
  emit: () => {},
  sessionManager: {
    getEngines: () => new Map([["codex", engineStub]]),
    getEngine: () => engineStub,
    getQueue: () => queueStub,
  },
} as unknown as import("../api.js").ApiContext;

function connectorHeaders(): Record<string, string> {
  return {
    authorization: "Bearer test-token",
    [TOOL_CALL_HEADER]: TOOL_CALL_HEADER_VALUE,
    [CALLER_SESSION_HEADER]: connector.id,
    [CALLER_SESSION_CAPABILITY_HEADER]: ensureSessionCapability(connector.id),
  };
}
const operator = { authorization: "Bearer test-token" };

async function call(method: string, url: string, body?: unknown, headers: Record<string, string> = connectorHeaders()) {
  const req = Object.assign(Readable.from(body === undefined ? [] : [Buffer.from(JSON.stringify(body))]), {
    method, url, headers: { host: "localhost", "content-type": "application/json", ...headers }, socket: { remoteAddress: "127.0.0.1" },
  });
  let status = 200;
  const chunks: Buffer[] = [];
  const res = {
    writeHead(s: number) { status = s; return this; },
    setHeader() { return this; },
    getHeader() { return undefined; },
    end(buf?: Buffer | string) { if (buf) chunks.push(Buffer.isBuffer(buf) ? buf : Buffer.from(buf)); },
  } as unknown as ServerResponse;
  await api.handleApiRequest(req as never, res, apiCtx);
  const text = Buffer.concat(chunks).toString("utf-8");
  return { status, body: text ? JSON.parse(text) : undefined };
}

/** Let fire-and-forget dispatch and callback promises settle. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 50));

/** Parent callbacks post over HTTP to the gateway; route them into the same handler. */
async function gatewayFetch(input: string | URL, init?: RequestInit): Promise<Response> {
  const url = new URL(String(input));
  const r = await call(init?.method ?? "GET", url.pathname + url.search, init?.body ? JSON.parse(String(init.body)) : undefined, operator);
  return new Response(JSON.stringify(r.body ?? {}), { status: r.status, headers: { "content-type": "application/json" } });
}

beforeAll(async () => {
  globalThis.fetch = vi.fn(gatewayFetch) as unknown as typeof fetch;
  api = await import("../api.js");
  registry = await import("../../sessions/registry.js");
  store = await import("../../work-items/store.js");
  connector = registry.createSession({ engine: "codex", source: "remote-mcp", sourceRef: "remote-mcp:op@example.com" });
  target = registry.createSession({ engine: "codex", source: "web", sourceRef: "web:session-control-target", employee: "qa-emp", title: "A working session" });
  for (const [role, content] of [["user", "one"], ["assistant", "two"], ["user", "three"], ["assistant", "four"]] as const) {
    registry.insertMessage(target.id, role, content);
  }
});

afterAll(() => {
  globalThis.fetch = processFetch;
});

describe("remote MCP session control", () => {
  it("tails a session: the last N messages, not the whole transcript", async () => {
    const r = await call("GET", `/api/sessions/${target.id}?last=2`);
    expect(r.status).toBe(200);
    expect(r.body.messages.map((m: { content: string }) => m.content)).toEqual(["three", "four"]);
  });

  it("messages a running session, which runs a turn on it as a relayed notification", async () => {
    const r = await call("POST", `/api/sessions/${target.id}/message`, { message: "how is it going?" });
    expect(r.status).toBeLessThan(300);
    await settle();
    expect(engineRuns).toContain(target.id);
    const last = registry.getMessages(target.id).find((m) => m.content.includes("how is it going?"));
    expect(last?.role).toBe("notification");
  });

  it("delegates new work to a named employee, tracked by a new Todo", async () => {
    const r = await call("POST", "/api/delegations", { task: "Check the build", employee: "qa-emp" });
    expect(r.status).toBe(201);
    const child = registry.getSession(r.body.sessionId)!;
    expect(child.employee).toBe("qa-emp");
    expect(child.parentSessionId).toBe(connector.id);
    expect(store.getWorkItem(r.body.workItemId)).toBeTruthy();
    await settle();
    expect(engineRuns).toContain(child.id);
  });

  it("re-delegates an existing Todo it did not create, like the operator (QA N1)", async () => {
    const todo = (await call("POST", "/api/work-items", { title: "Operator's Todo to hand on" }, operator)).body.workItem.id;
    const r = await call("POST", "/api/delegations", { task: "Pick this up", employee: "qa-emp", workItemId: todo });
    expect(r.status).toBe(201);
    expect(r.body.workItemId).toBe(todo);
    expect(registry.getSession(r.body.sessionId)?.workItemId).toBe(todo);
  });

  it("assigns a Todo it did not create", async () => {
    const todo = (await call("POST", "/api/work-items", { title: "Operator's Todo" }, operator)).body.workItem.id;
    const r = await call("POST", `/api/work-items/${todo}/assign`, { assignee: "qa-emp" });
    expect(r.status).toBe(200);
    expect(store.getWorkItem(todo)?.assignee).toBe("qa-emp");
    const unknown = await call("POST", `/api/work-items/${todo}/assign`, { assignee: "qa-empp" });
    expect(unknown.status).toBe(400);
    expect(unknown.body.error).toContain('Did you mean "qa-emp"');
  });

  it("keeps receiving child completions after the first one (QA of the session-control change)", async () => {
    const children: string[] = [];
    for (const task of ["First errand", "Second errand"]) {
      const r = await call("POST", "/api/delegations", { task, employee: "qa-emp" });
      expect(r.status).toBe(201);
      children.push(r.body.sessionId);
    }
    await vi.waitFor(() => {
      const callbacks = registry.getMessages(connector.id).filter((m) => m.role === "notification");
      for (const child of children) expect(callbacks.some((m) => m.content.includes(child) || JSON.stringify(m).includes(child))).toBe(true);
    }, { timeout: 5000 });
    expect(registry.getSession(connector.id)?.status).toBe("idle");
    expect(registry.getSession(connector.id)?.lastError ?? null).toBeNull();
    expect(registry.getMessages(connector.id).some((m) => m.content.includes("⛔"))).toBe(false);
    expect(engineRuns).not.toContain(connector.id);
  });

  it("never runs the anchor, even when a session replies to it", async () => {
    const r = await call("POST", `/api/sessions/${connector.id}/message`, { message: "done, see the PR" }, {
      ...operator,
      [TOOL_CALL_HEADER]: TOOL_CALL_HEADER_VALUE,
      [CALLER_SESSION_HEADER]: target.id,
      [CALLER_SESSION_CAPABILITY_HEADER]: ensureSessionCapability(target.id),
    });
    expect(r.status).toBeLessThan(300);
    await settle();
    expect(engineRuns).not.toContain(connector.id);
    expect(registry.getMessages(connector.id).some((m) => m.content.includes("done, see the PR"))).toBe(true);
    expect(registry.getSession(connector.id)?.status).toBe("idle");
  });
});
