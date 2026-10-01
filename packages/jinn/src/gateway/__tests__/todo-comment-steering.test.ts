import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import type { ServerResponse } from "node:http";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { WorkItemComment } from "../../work-items/comments.js";
import {
  CALLER_SESSION_CAPABILITY_HEADER,
  CALLER_SESSION_HEADER,
  TOOL_CALL_HEADER,
  TOOL_CALL_HEADER_VALUE,
  ensureSessionCapability,
} from "../../mcp/identity.js";

const home = fs.mkdtempSync(path.join(os.tmpdir(), "jinn-todo-comment-steering-"));
process.env.JINN_HOME = home;

vi.mock("../../sessions/callbacks.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../sessions/callbacks.js")>();
  return { ...actual, deliverClaimedSessionDelivery: async () => "accepted" as const };
});

type Api = typeof import("../api.js");
type Comments = typeof import("../../work-items/comments.js");
type Registry = typeof import("../../sessions/registry.js");
type Store = typeof import("../../work-items/store.js");
type Steering = typeof import("../todo-comment-steering.js");

let api: Api;
let comments: Comments;
let registry: Registry;
let store: Store;
let steering: Steering;
let database: import("better-sqlite3").Database;

const context = {
  getConfig: () => ({ gateway: {}, engines: {}, sessions: {} }),
  connectors: new Map(),
  startTime: Date.now(),
  gatewayAuthToken: "test-token",
  emit: () => undefined,
  sessionManager: {
    getQueue: () => ({
      getPendingCount: () => 0,
      getTransportState: (_key: string, status: string) => status,
    }),
  },
} as unknown as import("../api.js").ApiContext;

function responseCapture() {
  let status = 200;
  const chunks: Buffer[] = [];
  const res = {
    writeHead(nextStatus: number) {
      status = nextStatus;
      return this;
    },
    setHeader() {
      return this;
    },
    end(chunk?: Buffer | string) {
      if (chunk) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    },
  } as unknown as ServerResponse;
  return {
    res,
    get status() {
      return status;
    },
    get body() {
      return JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, any>;
    },
  };
}

function request(body: string, headers: Record<string, string>) {
  return Object.assign(Readable.from([Buffer.from(JSON.stringify({ body }))]), {
    method: "POST",
    url: "",
    headers: { host: "localhost", "content-type": "application/json", ...headers },
  }) as unknown as Parameters<Api["handleApiRequest"]>[0];
}

const operatorHeaders = { authorization: "Bearer test-token" };

function sessionHeaders(sessionId: string): Record<string, string> {
  return {
    [TOOL_CALL_HEADER]: TOOL_CALL_HEADER_VALUE,
    [CALLER_SESSION_HEADER]: sessionId,
    [CALLER_SESSION_CAPABILITY_HEADER]: ensureSessionCapability(sessionId),
  };
}

async function postComment(
  todoId: string,
  body: string,
  headers: Record<string, string> = operatorHeaders,
) {
  const req = request(body, headers);
  req.url = `/api/work-items/${todoId}/comments`;
  const captured = responseCapture();
  await api.handleApiRequest(req, captured.res, context);
  expect(captured.status).toBe(201);
  return captured.body.comment as WorkItemComment;
}

function delegatedSession(todoId: string, employee = "a-worker") {
  const session = registry.createSession({
    engine: "codex",
    source: "delegation",
    sourceRef: `delegation:${crypto.randomUUID()}`,
    employee,
  });
  store.linkSession(todoId, session.id);
  return registry.getSession(session.id)!;
}

function todo(title: string) {
  return store.createWorkItem({ title, source: "delegation", status: "executing" });
}

beforeAll(async () => {
  api = await import("../api.js");
  comments = await import("../../work-items/comments.js");
  registry = await import("../../sessions/registry.js");
  store = await import("../../work-items/store.js");
  steering = await import("../todo-comment-steering.js");
  database = (await import("../../shared/db.js")).initDb();
});

beforeEach(() => {
  database.exec("DELETE FROM callback_deliveries; DELETE FROM queue_items; DELETE FROM messages; DELETE FROM sessions;");
});

describe("Todo comments steered into a delegated session", () => {
  it("delivers an operator comment to the newest live delegated session", async () => {
    const item = todo("Steer the delegate");
    const session = delegatedSession(item.id);

    const comment = await postComment(item.id, "Prefer the smaller migration.");

    const deliveries = registry.listPendingSessionDeliveries();
    expect(deliveries).toHaveLength(1);
    expect(deliveries[0]).toMatchObject({
      targetSessionId: session.id,
      sourceKind: "work-item",
      sourceId: item.id,
      sourceAttempt: comment.id,
      sourceOutcome: "todo-comment",
      deliveryKind: "todo-comment-steering",
    });
    expect(deliveries[0]!.payload.message).toContain("Prefer the smaller migration.");
    expect(deliveries[0]!.payload.message).toContain("comment_work_item");
    expect(deliveries[0]!.payload.message).toContain(comment.id);
  });

  it("skips a newer session the removed Workflow runtime left on the Todo", async () => {
    const item = todo("Steer past a legacy phase");
    const worker = delegatedSession(item.id);
    const phase = registry.createSession({ engine: "codex", source: "workflow", sourceRef: "wf:legacy:run:plan", employee: "a-worker" });
    database.prepare("UPDATE sessions SET status = 'idle', workflow_kind = 'phase', last_activity = ? WHERE id = ?")
      .run(new Date(Date.now() + 60_000).toISOString(), phase.id);
    store.linkSession(item.id, phase.id);

    await postComment(item.id, "Carry on with the worker's plan.");

    const deliveries = registry.listPendingSessionDeliveries();
    expect(deliveries).toHaveLength(1);
    expect(deliveries[0]!.targetSessionId).toBe(worker.id);
  });

  it("forwards one comment exactly once however often it is replayed", async () => {
    const item = todo("Replay one comment");
    delegatedSession(item.id);

    const comment = await postComment(item.id, "Only once, please.");
    steering.forwardTodoComment(comment);
    steering.forwardTodoComment(comment);

    expect(registry.listPendingSessionDeliveries()).toHaveLength(1);
  });

  it("steers with a remote MCP connector's comment, as with the operator's (FR-013a(3) lifted)", async () => {
    const item = todo("Steered from claude.ai");
    delegatedSession(item.id);
    const connector = registry.createSession({ engine: "codex", source: "remote-mcp", sourceRef: "remote-mcp:op@example.com" });

    const posted = await postComment(item.id, "Also check the mobile layout.", sessionHeaders(connector.id));
    expect(posted.author).toBe(`session:${connector.id}`);
    const deliveries = registry.listPendingSessionDeliveries();
    expect(deliveries).toHaveLength(1);
    expect(deliveries[0]!.payload.message).toContain("check the mobile layout");
  });

  it("never echoes a session's own comment back to it, but still delivers another author's", async () => {
    const item = todo("Break the echo");
    const session = delegatedSession(item.id);

    const own = await postComment(item.id, "Here is my progress.", sessionHeaders(session.id));
    expect(own.author).toBe("a-worker");
    expect(registry.listPendingSessionDeliveries()).toEqual([]);

    await postComment(item.id, "Thanks — now do the second half.");

    const deliveries = registry.listPendingSessionDeliveries();
    expect(deliveries).toHaveLength(1);
    expect(deliveries[0]!.payload.message).toContain("now do the second half");
  });

  it("caps one Todo at five steered comments and explains the sixth on the Todo", async () => {
    const item = todo("Bound the steering");
    delegatedSession(item.id);

    const posted: WorkItemComment[] = [];
    for (let index = 1; index <= 6; index += 1) {
      posted.push(await postComment(item.id, `Steer ${index}`));
    }

    expect(registry.listPendingSessionDeliveries()).toHaveLength(5);
    const notices = comments.listComments(item.id, { limit: 50 }).comments
      .filter((comment) => comment.authorKind === "system");
    expect(notices).toHaveLength(1);
    expect(notices[0]).toMatchObject({ parentCommentId: posted[5]!.id });
    expect(notices[0]!.body).toMatch(/not forwarded/i);
    expect(notices[0]!.body).toContain("5");
  });
});
