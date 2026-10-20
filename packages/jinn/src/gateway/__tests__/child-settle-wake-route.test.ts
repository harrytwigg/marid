import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import type { ServerResponse } from "node:http";

/**
 * A parent owner whose session has stopped is resumed by the Todo-tree wake.
 * Everything between the settle and the engine is real: the settle row, the
 * flush, the durable outbox, the callback's HTTP hop (answered in-process by the
 * real `POST /api/sessions/:id/message` route), and the route's own queueing. Only
 * the engine behind the queue is a stand-in.
 */

process.env.JINN_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "jinn-child-settle-route-"));

type Api = typeof import("../api.js");
let api: Api;
let registry: typeof import("../../sessions/registry.js");
let store: typeof import("../../work-items/store.js");
let transitions: typeof import("../../work-items/transitions.js");
let wake: typeof import("../../work-items/child-settle-wake.js");
let db: import("better-sqlite3").Database;

const OWNER = "route-owner";
const ranOn: Array<{ sessionId: string; prompt: string }> = [];
const queued: string[] = [];
const queueStub = {
  // Runs the turn the route queued, as the real queue does for a free session.
  enqueue: async (key: string, run: () => Promise<unknown>) => { queued.push(key); await run(); },
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
const engineStub = {
  name: "codex",
  run: async (opts: { sessionId?: string; prompt: string }) => {
    ranOn.push({ sessionId: opts.sessionId ?? "", prompt: opts.prompt });
    return { result: "on it", sessionId: "engine-session" };
  },
  isAlive: () => false,
  isTurnRunning: () => false,
  kill: () => {},
  killAll: () => {},
};
const apiCtx = {
  getConfig: () => ({ gateway: {}, engines: { default: "codex" }, sessions: {} }),
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

async function request(method: string, pathAndQuery: string, body?: unknown, headers: Record<string, string> = {}) {
  const raw = body === undefined ? undefined : JSON.stringify(body);
  const req = Object.assign(Readable.from(raw ? [Buffer.from(raw)] : []), {
    method,
    url: pathAndQuery,
    headers: { host: "gateway.test", ...(raw ? { "content-type": "application/json" } : {}), ...headers },
  });
  const chunks: Buffer[] = [];
  let status = 0;
  const res = {
    writeHead(code: number) { status = code; return res; },
    setHeader() {},
    end(chunk?: string | Buffer) { if (chunk) chunks.push(Buffer.from(chunk)); },
    write(chunk: string | Buffer) { chunks.push(Buffer.from(chunk)); return true; },
    headersSent: false,
  } as unknown as ServerResponse;
  await api.handleApiRequest(req as unknown as Parameters<Api["handleApiRequest"]>[0], res, apiCtx);
  return { status, text: Buffer.concat(chunks).toString("utf-8") };
}

beforeAll(async () => {
  api = await import("../../gateway/api.js");
  registry = await import("../../sessions/registry.js");
  store = await import("../../work-items/store.js");
  transitions = await import("../../work-items/transitions.js");
  wake = await import("../../work-items/child-settle-wake.js");
  db = (await import("../../shared/db.js")).initDb();
  // The callback's HTTP hop lands on the real route, in process.
  vi.stubGlobal("fetch", async (url: string, init: { method: string; body: string; headers: Record<string, string> }) => {
    const target = new URL(url);
    const answered = await request(init.method, target.pathname, JSON.parse(init.body), {
      authorization: init.headers.authorization ?? "Bearer test-token",
    });
    return { ok: answered.status < 400, status: answered.status, text: async () => answered.text };
  });
}, 60_000);

afterAll(() => {
  vi.unstubAllGlobals();
});

function ownerSession(parentId: string, status: "idle" | "interrupted") {
  const session = registry.createSession({ engine: "codex", source: "web", sourceRef: `web:${status}-${parentId}`, employee: OWNER });
  db.prepare("UPDATE sessions SET status = ?, work_item_id = ?, work_item_role = 'execute' WHERE id = ?").run(status, parentId, session.id);
  return session.id;
}

describe("the wake reaches a stopped owner through the real message route", () => {
  it.each(["interrupted", "idle"] as const)("an %s owner session is accepted and starts a turn that reads the wake", async (status) => {
    const parent = store.createWorkItem({ title: `${status} parent`, status: "executing", source: "session", assignee: OWNER });
    const owner = ownerSession(parent.id, status);
    const child = store.createWorkItem({ title: "board walk child", status: "executing", source: "session", assignee: "route-worker", parentId: parent.id });
    transitions.transition(child.id, "in_review", "board-walk", { detail: { note: "Ready for your review." } });
    ranOn.length = 0;
    queued.length = 0;

    wake.flushChildSettles(parent.id, { isEmployee: (name) => name === OWNER, redispatch: () => ({ status: "executing" }) });

    await vi.waitFor(() => expect(ranOn).toHaveLength(1));
    const delivery = db.prepare("SELECT id, status, queue_item_id AS queueItemId FROM callback_deliveries WHERE target_session_id = ? AND delivery_kind = 'todo-child-settled'")
      .get(owner) as { id: string; status: string; queueItemId: string };
    expect(delivery.status).toBe("accepted");
    expect(queued).toHaveLength(1);
    // The engine got the wake, naming the child and what the owner may do with it.
    expect(ranOn[0]!.prompt).toContain(child.id);
    expect(ranOn[0]!.prompt).toContain("Ready for your review.");
    // The notification is in the owner's transcript too.
    expect(registry.getMessages(owner).some((message) => message.role === "notification" && message.content.includes(child.id))).toBe(true);
    // The turn ran to its end: the session is no longer stopped, and its reply is in the transcript.
    expect(["running", "idle"]).toContain(registry.getSession(owner)!.status);
    expect(registry.getMessages(owner).some((message) => message.role === "assistant" && message.content.includes("on it"))).toBe(true);
  });
});
