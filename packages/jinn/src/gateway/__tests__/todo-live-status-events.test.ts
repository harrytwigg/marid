import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import type { ServerResponse } from "node:http";

/**
 * ICI-749 — every status write reaches the dashboard live, exactly once.
 *
 * The board went stale because only the HTTP routes emitted `company:changed`;
 * the reconciler or an approval consequence committed silently.
 * The emit now belongs to `transition()`, so these tests wire BOTH ends the way
 * `startGateway` does (`setTodoLiveEmitter` + `ApiContext.emit`) and count the
 * todo events per write — one, never two, from either lane.
 */

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "jinn-todo-live-status-"));
process.env.JINN_HOME = tmp;
const dbModule = await import("../../shared/db.js");
fs.mkdirSync(path.join(tmp, "org"), { recursive: true });
fs.writeFileSync(
  path.join(tmp, "org", "platform-worker.yaml"),
  "name: platform-worker\ndisplayName: Platform Worker\ndepartment: platform\nrank: employee\nengine: codex\nmodel: default\npersona: Generic route-test worker.\n",
);

type Api = typeof import("../api.js");
type Store = typeof import("../../work-items/store.js");
type Registry = typeof import("../../sessions/registry.js");
type Approvals = typeof import("../../work-items/approvals.js");
type Reconcile = typeof import("../../work-items/reconcile.js");
type LiveEvents = typeof import("../../work-items/live-events.js");

let api: Api;
let store: Store;
let registry: Registry;
let approvals: Approvals;
let reconcile: Reconcile;

const emittedEvents: Array<{ event: string; payload: Record<string, unknown> }> = [];

const ctx = {
  getConfig: () => ({ gateway: {}, engines: {} }),
  connectors: new Map(),
  startTime: Date.now(),
  gatewayAuthToken: "test-token",
  emit: (event: string, payload: Record<string, unknown>) => emittedEvents.push({ event, payload }),
  sessionManager: { getQueue: () => ({ getPendingCount: () => 0, getTransportState: (_k: string, s: string) => s }) },
} as unknown as import("../api.js").ApiContext;

const operatorHeaders = { authorization: "Bearer test-token" };

function makeRes() {
  let status = 200;
  const chunks: Buffer[] = [];
  const res = {
    writeHead(s: number) { status = s; return this; },
    setHeader() { return this; },
    end(buf?: Buffer | string) { if (buf) chunks.push(Buffer.isBuffer(buf) ? buf : Buffer.from(buf)); },
  } as unknown as ServerResponse;
  return {
    res,
    get status() { return status; },
    get body() {
      const raw = Buffer.concat(chunks).toString("utf-8");
      try { return JSON.parse(raw); } catch { return raw; }
    },
  };
}

function makeReq(method: string, urlPath: string, body?: unknown, headers: Record<string, string> = {}) {
  const payload = body !== undefined ? [Buffer.from(JSON.stringify(body))] : [];
  return Object.assign(Readable.from(payload), {
    method,
    url: urlPath,
    headers: { host: "localhost", "content-type": "application/json", ...headers },
  }) as unknown as Parameters<Api["handleApiRequest"]>[0];
}

/** The todo events a single write produced, in emit order. */
function todoEvents(): Array<Record<string, unknown>> {
  return emittedEvents
    .filter((e) => e.event === "company:changed" && e.payload.entity === "todo")
    .map((e) => e.payload);
}

beforeAll(async () => {
  api = await import("../api.js");
  store = await import("../../work-items/store.js");
  registry = await import("../../sessions/registry.js");
  approvals = await import("../../work-items/approvals.js");
  reconcile = await import("../../work-items/reconcile.js");
  dbModule.initDb();
  // Exactly the wiring startGateway installs, so these counts are the ones a
  // running gateway produces rather than an artefact of a half-wired harness.
  const live: LiveEvents = await import("../../work-items/live-events.js");
  live.setTodoLiveEmitter((event) => {
    emittedEvents.push({ event: "company:changed", payload: event as unknown as Record<string, unknown> });
  });
});

beforeEach(() => {
  emittedEvents.length = 0;
});

describe("the reconciler and approval consequences reach the board", () => {
  it("emits one todo event when the reconciler derives a new status", () => {
    const item = store.createWorkItem({ title: "reconciled item" });
    const session = registry.createSession({ engine: "claude", source: "cron", sourceRef: "cron:live:1" });
    registry.updateSession(session.id, { status: "running", lastActivity: new Date().toISOString() });
    store.linkSession(item.id, session.id);

    expect(reconcile.reconcileWorkItem(item.id)?.changed).toBe(true);

    const events = todoEvents();
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ entity: "todo", id: item.id, version: store.getWorkItem(item.id)!.version });
  });

  it("emits one todo event for the transition an approval decision causes", async () => {
    const item = store.createWorkItem({ title: "approve me", status: "in_review" });
    approvals.requestApproval(item.id, { request: "ship it?", actor: "platform-worker" });
    emittedEvents.length = 0;

    const cap = makeRes();
    await api.handleApiRequest(
      makeReq("POST", `/api/work-items/${item.id}/approvals/decide`, { decision: "approve" }, operatorHeaders),
      cap.res,
      ctx,
    );

    expect([cap.status, cap.body.workItem.status]).toEqual([200, "done"]);
    expect(todoEvents()).toHaveLength(1);
  });
});

describe("the operator surface still emits once, not twice", () => {
  it("PUT /status emits one todo event and keeps its body and activity receipt", async () => {
    const item = store.createWorkItem({ title: "operator drags this", status: "backlog" });

    const cap = makeRes();
    await api.handleApiRequest(
      makeReq("PUT", `/api/work-items/${item.id}/status`, { status: "executing" }, operatorHeaders),
      cap.res,
      ctx,
    );

    const written = store.getWorkItem(item.id)!;
    expect(cap.status).toBe(200);
    expect(cap.body).toEqual({ workItem: written, escalated: false });
    expect(cap.body).not.toHaveProperty("activityReceiptId");
    const events = todoEvents();
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ entity: "todo", id: item.id, version: written.version });
  });

  it("a same-status operator note still emits its one event", async () => {
    const item = store.createWorkItem({ title: "blocked with a reason", status: "blocked" });

    const cap = makeRes();
    await api.handleApiRequest(
      makeReq("PUT", `/api/work-items/${item.id}/status`, { status: "blocked", note: "still waiting" }, operatorHeaders),
      cap.res,
      ctx,
    );

    expect(cap.status).toBe(200);
    expect(todoEvents()).toHaveLength(1);
  });

  it("POST /assign emits one todo event when the assignment starts the work", async () => {
    const item = store.createWorkItem({ title: "assign starts it", status: "backlog" });

    const cap = makeRes();
    await api.handleApiRequest(
      makeReq("POST", `/api/work-items/${item.id}/assign`, { assignee: "platform-worker" }, operatorHeaders),
      cap.res,
      ctx,
    );

    expect([cap.status, cap.body.workItem.status]).toEqual([200, "assigned"]);
    expect(todoEvents()).toHaveLength(1);
  });

  it("POST /assign emits one todo event when only the assignee moves", async () => {
    const item = store.createWorkItem({ title: "reassign mid-flight", status: "executing" });

    const cap = makeRes();
    await api.handleApiRequest(
      makeReq("POST", `/api/work-items/${item.id}/assign`, { assignee: "platform-worker" }, operatorHeaders),
      cap.res,
      ctx,
    );

    expect([cap.status, cap.body.workItem.status]).toEqual([200, "executing"]);
    expect(todoEvents()).toHaveLength(1);
  });

  it("POST /archive emits one todo event", async () => {
    const item = store.createWorkItem({ title: "archive me", status: "backlog" });

    const cap = makeRes();
    await api.handleApiRequest(
      makeReq("POST", `/api/work-items/${item.id}/archive`, {}, operatorHeaders),
      cap.res,
      ctx,
    );

    expect([cap.status, cap.body.workItem.status]).toEqual([200, "cancelled"]);
    expect(todoEvents()).toHaveLength(1);
  });
});
