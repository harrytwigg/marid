import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import type { ServerResponse } from "node:http";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { ApiContext } from "../api.js";
import type { Engine, JinnConfig } from "../../shared/types.js";

const home = fs.mkdtempSync(path.join(os.tmpdir(), "jinn-talk-universal-control-"));
process.env.JINN_HOME = home;
fs.mkdirSync(path.join(home, "org", "platform"), { recursive: true });
fs.writeFileSync(path.join(home, "org", "platform", "a-worker.yaml"), [
  "name: a-worker",
  "displayName: A Worker",
  "department: platform",
  "rank: senior",
  "engine: test-engine",
  "model: test-model",
  "persona: Complete bounded platform work.",
  "",
].join("\n"));

let handleApiRequest: typeof import("../api.js").handleApiRequest;
let workItems: typeof import("../../work-items/store.js");
let comments: typeof import("../../work-items/comments.js");
let sessions: typeof import("../../sessions/registry.js");
let buildManifest: typeof import("../../talk/control/manifest.js").buildTalkControlManifest;

beforeAll(async () => {
  ({ handleApiRequest } = await import("../api.js"));
  workItems = await import("../../work-items/store.js");
  comments = await import("../../work-items/comments.js");
  sessions = await import("../../sessions/registry.js");
  ({ buildTalkControlManifest: buildManifest } = await import("../../talk/control/manifest.js"));
  (await import("../../shared/db.js")).initDb();
});

afterAll(async () => {
  vi.unstubAllGlobals();
  (await import("../../shared/db.js")).__closeDbForTest();
  try {
    fs.rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  } catch {}
});

function request(method: string, url: string, body?: unknown, authorized = true) {
  const req = body === undefined ? Readable.from([]) : Readable.from([Buffer.from(JSON.stringify(body))]);
  Object.assign(req, {
    method,
    url,
    headers: {
      host: "localhost",
      "content-type": "application/json",
      ...(authorized ? { authorization: "Bearer test-token" } : {}),
    },
  });
  return req as unknown as Parameters<typeof handleApiRequest>[0];
}

function response() {
  let status = 200;
  const chunks: Buffer[] = [];
  const res = {
    setHeader: vi.fn(),
    writeHead(code: number) { status = code; return this; },
    write(chunk?: string | Buffer) { if (chunk) chunks.push(Buffer.from(chunk)); return true; },
    end(chunk?: string | Buffer) { if (chunk) chunks.push(Buffer.from(chunk)); },
  } as unknown as ServerResponse;
  return {
    res,
    read: () => ({
      status,
      body: chunks.length
        ? JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>
        : {},
    }),
  };
}

function testContext() {
  const config = {
    gateway: {},
    engines: { default: "test-engine" },
    realtime: { provider: "openai", apiKey: "test-realtime-key", model: "test-realtime-model" },
  } as unknown as JinnConfig;
  const engine: Engine = {
    name: "test-engine",
    run: async () => ({ sessionId: "test-native-session", result: "Done." }),
  };
  const queue = {
    enqueue: vi.fn(async () => undefined),
    getPendingCount: () => 0,
    getTransportState: (_key: string, status: string) => status,
  };
  const context = {
    gatewayAuthToken: "test-token",
    getConfig: () => config,
    connectors: new Map(),
    startTime: Date.now(),
    emit: vi.fn(),
    sessionManager: {
      getEngine: (name: string) => name === engine.name ? engine : undefined,
      getEngines: () => new Map([[engine.name, engine]]),
      getQueue: () => queue,
    },
  } as unknown as ApiContext;
  return { context };
}

async function call(context: ApiContext, method: string, url: string, body?: unknown, authorized = true) {
  const capture = response();
  await handleApiRequest(request(method, url, body, authorized), capture.res, context);
  return capture.read();
}

function control(providerCallId: string, tool: string, args: Record<string, unknown>) {
  return { providerCallId, tool, arguments: JSON.stringify(args) };
}

describe("universal Talk gateway control acceptance", () => {
  it("routes representative Todo, and delegation writes once while refusing browser-consent sends", async () => {
    vi.stubGlobal("fetch", async () => ({
      ok: true,
      json: async () => ({ value: "test-ephemeral-token", expires_at: Math.floor(Date.now() / 1000) + 600 }),
    }));
    const { context } = testContext();
    const todo = workItems.createWorkItem({ title: "Prepare the operator brief", body: "Draft the first version." });
    const opened = await call(context, "POST", "/api/talk/sessions");
    expect(opened.status).toBe(201);
    const talkId = String(opened.body.id);
    const route = `/api/talk/sessions/${talkId}/control`;

    const manifest = buildManifest();
    const names = new Set([
      "talk_edit_todo",
      "talk_comment_todo",
      "talk_assign_todo",
      "talk_delegate_todo",
    ]);
    const journeyOperations = manifest.operations.filter((operation) => names.has(operation.name));
    expect(journeyOperations).toHaveLength(names.size);
    expect(journeyOperations.every((operation) => operation.target === "gateway" && operation.operatorOnly)).toBe(true);

    const edit = control("edit-1", "talk_edit_todo", {
      id: todo.id,
      expectedVersion: todo.version,
      title: "Prepare the verified operator brief",
      priority: 2,
    });
    const edited = await call(context, "POST", route, edit);
    const editReplay = await call(context, "POST", route, edit);
    expect(edited.body).toMatchObject({
      ok: true,
      operation: "talk_edit_todo",
      verified: true,
      replayed: false,
      uiEffect: { navigate: `/todos/${todo.id}` },
    });
    expect(editReplay.body).toMatchObject({ ok: true, replayed: true, receiptId: edited.body.receiptId });
    expect(workItems.getWorkItem(todo.id)).toMatchObject({
      title: "Prepare the verified operator brief",
      priority: 2,
      version: todo.version + 1,
    });

    const comment = control("comment-1", "talk_comment_todo", { id: todo.id, body: "The acceptance evidence is attached." });
    const commented = await call(context, "POST", route, comment);
    await call(context, "POST", route, comment);
    expect(commented.body).toMatchObject({ ok: true, operation: "talk_comment_todo", verified: true, replayed: false });
    expect(comments.listComments(todo.id).comments.map((entry) => entry.body))
      .toEqual(["The acceptance evidence is attached."]);

    const beforeAssignment = workItems.getWorkItem(todo.id)!;
    const assignment = control("assign-1", "talk_assign_todo", { id: todo.id, assignee: "a-worker" });
    const assigned = await call(context, "POST", route, assignment);
    const assignedReplay = await call(context, "POST", route, assignment);
    expect(assigned.body).toMatchObject({
      ok: true,
      verified: true,
      evidence: { id: todo.id, assignee: "a-worker" },
      uiEffect: { navigate: `/todos/${todo.id}` },
    });
    expect(assignedReplay.body).toMatchObject({ ok: true, replayed: true, receiptId: assigned.body.receiptId });
    expect(workItems.getWorkItem(todo.id)).toMatchObject({
      assignee: "a-worker",
      version: beforeAssignment.version + 1,
    });

    const delegation = control("delegate-1", "talk_delegate_todo", {
      id: todo.id,
      employee: "a-worker",
      task: "Complete the bounded verification task.",
    });
    const delegated = await call(context, "POST", route, delegation);
    const delegatedReplay = await call(context, "POST", route, delegation);
    expect(delegated.body).toMatchObject({
      ok: true,
      operation: "talk_delegate_todo",
      verified: true,
      replayed: false,
      data: { todoId: todo.id, employee: "a-worker" },
    });
    expect(delegatedReplay.body).toMatchObject({ ok: true, replayed: true, receiptId: delegated.body.receiptId });
    const delegatedSessions = sessions.listSessionsByWorkItem(todo.id);
    expect(delegatedSessions).toHaveLength(1);
    const delegatedSession = delegatedSessions[0]!;
    expect(delegated.body).toMatchObject({ uiEffect: { navigate: `/?session=${delegatedSession.id}` } });

    // The named-session send is a gateway write now (PLA-224 S3), and it is
    // gated on the operator's own live utterance rather than on a browser
    // sheet. Posted without that binding it is refused before anything runs.
    const message = control("message-1", "talk_send_to_session", {
      id: delegatedSession.id,
      message: "Please include the final evidence summary.",
    });
    const unbound = await call(context, "POST", route, message);
    expect(unbound).toMatchObject({ status: 409, body: { code: "credential-mismatch" } });
    expect(sessions.getMessages(delegatedSession.id).filter((entry) => entry.role === "user").map((entry) => entry.content))
      .toEqual(["Complete the bounded verification task."]);

    // That the bound send really lands is journey step 2 in talk-journey.test.ts.

    const commentCount = comments.listComments(todo.id).comments.length;
    const rejected = await call(context, "POST", route,
      control("comment-unauthorized", "talk_comment_todo", { id: todo.id, body: "Must not be written." }), false);
    expect(rejected).toMatchObject({ status: 401 });
    expect(comments.listComments(todo.id).comments).toHaveLength(commentCount);
    expect(manifest.operations.filter((operation) => operation.mutability === "write" && !operation.operatorOnly)).toEqual([]);
  });
});
