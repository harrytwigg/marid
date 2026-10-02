import { expect } from "vitest";
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
 * The shared harness for the mention and delegation-reuse suites: the real
 * routes, registry and Todo store on a throwaway home, with an org of plain
 * employees. Each suite mocks the outbox's HTTP hop itself (a `vi.mock` only
 * hoists within its own file), so a delivery is the row it claims and nothing
 * leaves the process.
 */

/** Make the throwaway home and its org. Call before anything reads JINN_HOME. */
export function mentionTestHome(prefix: string): string {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  process.env.JINN_HOME = home;
  fs.mkdirSync(path.join(home, "org"), { recursive: true });
  // `stale` is pinned to a model the gateway does not register, so it cannot be started.
  for (const [name, rank, reportsTo, model] of [["org-root", "executive", "", "gpt-5.5"], ["alpha", "employee", "org-root", "gpt-5.5"],
    ["bravo", "employee", "org-root", "gpt-5.5"], ["worker", "employee", "org-root", "gpt-5.5"], ["stale", "employee", "org-root", "legacy-model"]]) {
    fs.writeFileSync(path.join(home, "org", `${name}.yaml`), [
      `name: ${name}`, `displayName: ${name[0].toUpperCase()}${name.slice(1)}`, "department: platform", `rank: ${rank}`,
      ...(reportsTo ? [`reportsTo: ${reportsTo}`] : []), "engine: codex", `model: ${model}`, `persona: ${name} for mention tests`, "",
    ].join("\n"));
  }
  return home;
}

const engineStub = { name: "stub", run: async () => ({ result: "ok" }), isAlive: () => false, kill: () => {}, killAll: () => {} };
const context = {
  getConfig: () => ({
    gateway: {},
    engines: { default: "codex", codex: { bin: "codex", model: "gpt-5.5" } },
    models: { codex: { default: "gpt-5.5", models: [{ id: "gpt-5.5" }] } },
    sessions: {},
  }),
  connectors: new Map(),
  startTime: Date.now(),
  gatewayAuthToken: "test-token",
  emit: () => undefined,
  sessionManager: {
    getEngines: () => new Map(),
    getEngine: () => engineStub,
    // Turns are queued, never run: a started session stays `running`.
    getQueue: () => ({
      enqueue: async () => undefined,
      clearCancelled: () => {},
      clearQueue: () => {},
      pauseQueue: () => {},
      resumeQueue: () => {},
      getPendingCount: () => 0,
      getTransportState: (_key: string, status: string) => status,
    }),
  },
} as unknown as import("../api.js").ApiContext;

export function sessionHeaders(sessionId: string): Record<string, string> {
  return {
    [TOOL_CALL_HEADER]: TOOL_CALL_HEADER_VALUE,
    [CALLER_SESSION_HEADER]: sessionId,
    [CALLER_SESSION_CAPABILITY_HEADER]: ensureSessionCapability(sessionId),
  };
}

/** Import the gateway against the home, install comment routing, and hand
 *  back the modules with the helpers both suites drive them through. */
export async function loadMentionHarness() {
  const api = await import("../api.js");
  const registry = await import("../../sessions/registry.js");
  const store = await import("../../work-items/store.js");
  const records = await import("../../work-items/employee-sessions.js");
  const claims = await import("../../work-items/claims.js");
  const callbacks = await import("../../sessions/callbacks.js");
  const db = (await import("../../shared/db.js")).initDb();
  (await import("../todo-comment-routing.js")).installTodoCommentRouting(context);

  async function call(method: string, url: string, body: unknown, headers: Record<string, string> = {}) {
    const operator = headers[CALLER_SESSION_HEADER] ? {} : { authorization: "Bearer test-token" };
    const req = Object.assign(Readable.from([Buffer.from(JSON.stringify(body))]), {
      method,
      url,
      headers: { host: "localhost", "content-type": "application/json", ...operator, ...headers },
    });
    let status = 200;
    const chunks: Buffer[] = [];
    const res = {
      writeHead(next: number) { status = next; return this; },
      setHeader() { return this; },
      end(chunk?: Buffer | string) { if (chunk) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)); },
    } as unknown as ServerResponse;
    await api.handleApiRequest(req as unknown as Parameters<typeof api.handleApiRequest>[0], res, context);
    return { status, body: JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, any> };
  }

  async function comment(todoId: string, body: string, opts: { as?: string; parentCommentId?: string } = {}) {
    const res = await call("POST", `/api/work-items/${todoId}/comments`, { body, ...(opts.parentCommentId ? { parentCommentId: opts.parentCommentId } : {}) },
      opts.as ? sessionHeaders(opts.as) : {});
    expect(res.status).toBe(201);
    return res.body.comment as { id: string; parentCommentId: string | null; repliedToId?: string };
  }

  const delegate = (todoId: string, employee: string, headers: Record<string, string> = {}) =>
    call("POST", "/api/delegations", { workItemId: todoId, employee, task: `Take ${todoId} over.` }, headers);

  const sessionsOf = (todoId: string, employee: string) =>
    registry.listSessionsByWorkItem(todoId).filter((session) => session.employee === employee);

  const deliveriesTo = (sessionId: string, kind?: string) =>
    (db.prepare("SELECT delivery_kind FROM callback_deliveries WHERE target_session_id = ?").all(sessionId) as Array<{ delivery_kind: string }>)
      .map((row) => row.delivery_kind)
      .filter((deliveryKind) => !kind || deliveryKind === kind);

  const employeeSession = (employee: string, prefix = employee) =>
    registry.createSession({ engine: "codex", source: "web", sourceRef: `${prefix}:${crypto.randomUUID()}`, employee, connector: "web" });

  /** An execution session of `employee` holding the Todo's claim, like a dispatched one. */
  function executing(todoId: string, employee = "worker") {
    const session = employeeSession(employee, "exec");
    store.linkSession(todoId, session.id);
    registry.updateSession(session.id, { status: "running" });
    claims.claimWorkItem({ workItemId: todoId, owner: `delegation:${crypto.randomUUID()}`, sessionId: session.id });
    return registry.getSession(session.id)!;
  }

  /** Put a Todo straight into a status, as an older gateway's row would hold it. */
  const forceStatus = (todoId: string, status: string) => { db.prepare("UPDATE work_items SET status = ? WHERE id = ?").run(status, todoId); };

  return { registry, store, records, claims, callbacks, forceStatus, call, comment, delegate, sessionsOf, deliveriesTo, employeeSession, executing };
}
