/**
 * PLA-224's acceptance journey, in test form.
 *
 * The five steps come verbatim from the session where the voice agent proved
 * decorative: it narrated instead of reading, drafted instead of sending, and
 * reported a Todo it had never attempted. Each step here is the same act driven
 * through the real control route, so the live replay has something to fail
 * against rather than a first attempt.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import type { ServerResponse } from "node:http";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { ApiContext, } from "../api.js";
import type { Engine, JinnConfig } from "../../shared/types.js";

const home = fs.mkdtempSync(path.join(os.tmpdir(), "jinn-talk-journey-"));
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
let sessions: typeof import("../../sessions/registry.js");

beforeAll(async () => {
  ({ handleApiRequest } = await import("../api.js"));
  sessions = await import("../../sessions/registry.js");
  (await import("../../shared/db.js")).initDb();
});

afterAll(async () => {
  vi.unstubAllGlobals();
  (await import("../../shared/db.js")).__closeDbForTest();
  try {
    fs.rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  } catch { /* the temp home is best-effort */ }
});

function request(method: string, url: string, body?: unknown) {
  const req = body === undefined ? Readable.from([]) : Readable.from([Buffer.from(JSON.stringify(body))]);
  Object.assign(req, {
    method,
    url,
    headers: { host: "localhost", "content-type": "application/json", authorization: "Bearer test-token" },
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
      body: chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown> : {},
    }),
  };
}

function testContext(): ApiContext {
  const config = {
    gateway: {},
    engines: { default: "test-engine" },
    realtime: { provider: "openai", apiKey: "test-realtime-key", model: "test-realtime-model" },
  } as unknown as JinnConfig;
  const engine: Engine = { name: "test-engine", run: async () => ({ sessionId: "native-1", result: "Done." }) };
  return {
    gatewayAuthToken: "test-token",
    getConfig: () => config,
    connectors: new Map(),
    startTime: Date.now(),
    emit: vi.fn(),
    sessionManager: {
      getEngine: (name: string) => name === engine.name ? engine : undefined,
      getEngines: () => new Map([[engine.name, engine]]),
      getQueue: () => ({
        enqueue: vi.fn(async () => undefined),
        getPendingCount: () => 0,
        getTransportState: (_key: string, status: string) => status,
      }),
    },
  } as unknown as ApiContext;
}

async function call(context: ApiContext, method: string, url: string, body?: unknown) {
  const capture = response();
  await handleApiRequest(request(method, url, body), capture.res, context);
  return capture.read();
}

/** The orb, pressed: one live talk session with its credential identity. */
async function pressTheOrb(context: ApiContext) {
  vi.stubGlobal("fetch", async () => ({
    ok: true,
    json: async () => ({ value: "test-ephemeral-token", expires_at: Math.floor(Date.now() / 1000) + 600 }),
  }));
  const opened = await call(context, "POST", "/api/talk/sessions");
  expect(opened.status).toBe(201);
  return {
    route: `/api/talk/sessions/${String(opened.body.id)}/control`,
    browserInstanceId: String(opened.body.browserInstanceId),
    credentialGeneration: Number(opened.body.credentialGeneration),
  };
}

/** A seeded chat with a real title and real last messages, as the sandbox has. */
function seededChat() {
  const chat = sessions.createSession({
    engine: "test-engine",
    source: "web",
    sourceRef: `web:${Date.now()}:${Math.random()}`,
    title: "Platform standup",
    employee: "a-worker",
  });
  sessions.insertMessage(chat.id, "user", "Should the ring stay?");
  sessions.insertMessage(chat.id, "assistant", "The ring keeps the state legible.");
  return chat;
}

describe("PLA-224 journey", () => {
  it("step 1: 'what are we looking at?' reads the focused chat instead of narrating it", async () => {
    const context = testContext();
    const { route } = await pressTheOrb(context);
    const chat = seededChat();

    // The id is what the page context now hands the model (S2). Before it did,
    // this call was uncallable and the model answered from imagination.
    const answered = await call(context, "POST", route, {
      providerCallId: "look-1",
      tool: "read_session",
      arguments: JSON.stringify({ id: chat.id }),
    });

    expect(answered.body).toMatchObject({ ok: true, operation: "read_session", verified: true });
    const data = answered.body.data as { title: string; employee: string; messages: Array<{ role: string; content: string }> };
    expect(data.title).toBe("Platform standup");
    expect(data.employee).toBe("a-worker");
    expect(data.messages.map((message) => message.content)).toEqual([
      "Should the ring stay?",
      "The ring keeps the state legible.",
    ]);
    // The re-read is authoritative, not the adapter's own word for it.
    expect(answered.body.evidence).toMatchObject({ sessionId: chat.id, messages: 2 });
  });

  it("step 2: 'send them a message' runs the prescribed gate and the message arrives", async () => {
    const context = testContext();
    const orb = await pressTheOrb(context);
    const chat = seededChat();
    // Each attempt is its own provider call, as it is on a real turn: a
    // provider call id is single-use, so a retry never reuses one.
    const send = {
      tool: "talk_send_to_session",
      arguments: JSON.stringify({ id: chat.id, message: "ping, are you still on this?" }),
    };

    // The bound-evidence gate: the live browser
    // instance, its credential generation, and the operator's own final
    // transcript item. A model that decided to send on its own has none of them.
    const withoutCredential = await call(context, "POST", orb.route, { ...send, providerCallId: "send-unbound" });
    expect(withoutCredential).toMatchObject({ status: 409, body: { code: "credential-mismatch" } });

    const withoutUtterance = await call(context, "POST", orb.route, {
      ...send,
      providerCallId: "send-no-utterance",
      browserInstanceId: orb.browserInstanceId,
      credentialGeneration: orb.credentialGeneration,
    });
    expect(withoutUtterance.body).toMatchObject({
      ok: false,
      code: "send-evidence-required",
      error: "Sending a message into a session requires bound final transcript evidence.",
    });
    expect(sessions.getMessages(chat.id).filter((message) => message.role === "user")).toHaveLength(1);

    // Gate passed: it sends, and it really lands.
    const sent = await call(context, "POST", orb.route, {
      ...send,
      providerCallId: "send-bound",
      browserInstanceId: orb.browserInstanceId,
      credentialGeneration: orb.credentialGeneration,
      providerTranscriptItemId: "operator-utterance-1",
    });

    expect(sent.body).toMatchObject({ ok: true, operation: "talk_send_to_session", verified: true, replayed: false });
    expect(sessions.getMessages(chat.id).map((message) => message.content)).toEqual([
      "Should the ring stay?",
      "The ring keeps the state legible.",
      "ping, are you still on this?",
    ]);
    // The re-read is what makes "it sent" a fact rather than the adapter's word.
    expect(sent.body.evidence).toMatchObject({ sessionId: chat.id });
  });

  it("steps 3 and 4: a dictated Todo exists on the board, then goes where it is told", async () => {
    const context = testContext();
    const orb = await pressTheOrb(context);
    const workItems = await import("../../work-items/store.js");
    const create = {
      providerCallId: "create-1",
      tool: "talk_create_todo",
      arguments: JSON.stringify({ title: "check the sandbox replay" }),
    };

    const created = await call(context, "POST", orb.route, create);
    expect(created.body).toMatchObject({ ok: true, operation: "talk_create_todo", verified: true, replayed: false });
    const todo = (created.body.data as { todo: { id: string; title: string; status: string } }).todo;

    // The board is what says it exists, not the adapter's word for it — and the
    // id comes back, which is what the agent speaks.
    expect(workItems.getWorkItem(todo.id)).toMatchObject({ title: "check the sandbox replay", status: "backlog" });
    expect(created.body.evidence).toMatchObject({ id: todo.id, title: "check the sandbox replay" });

    // One dictation is one Todo, however many times the provider replays it.
    expect((await call(context, "POST", orb.route, create)).body).toMatchObject({ ok: true, replayed: true });
    expect(workItems.listWorkItems({}).filter((item) => item.title === "check the sandbox replay")).toHaveLength(1);

    const assigned = await call(context, "POST", orb.route, {
      providerCallId: "assign-1",
      tool: "talk_assign_todo",
      arguments: JSON.stringify({ id: todo.id, assignee: "a-worker" }),
    });
    expect(assigned.body).toMatchObject({ ok: true, verified: true, evidence: { assignee: "a-worker" } });

    const moved = await call(context, "POST", orb.route, {
      providerCallId: "status-1",
      tool: "talk_set_todo_status",
      arguments: JSON.stringify({ id: todo.id, status: "executing" }),
    });
    expect(moved.body).toMatchObject({
      ok: true,
      operation: "talk_set_todo_status",
      verified: true,
      evidence: { id: todo.id, status: "executing" },
    });
    expect(workItems.getWorkItem(todo.id)).toMatchObject({ assignee: "a-worker", status: "executing" });

    // Cancelling is the one move the ledger cannot take back, so it is not on
    // the voice surface at all — refused before anything runs.
    const cancel = await call(context, "POST", orb.route, {
      providerCallId: "cancel-1",
      tool: "talk_set_todo_status",
      arguments: JSON.stringify({ id: todo.id, status: "cancelled" }),
    });
    expect(cancel.body).toMatchObject({ ok: false, code: "invalid-arguments" });
    expect(workItems.getWorkItem(todo.id)).toMatchObject({ status: "executing" });

    // A summary spoken with a move into review is posted, as it is from the board.
    const reviewed = await call(context, "POST", orb.route, {
      providerCallId: "status-2",
      tool: "talk_set_todo_status",
      arguments: JSON.stringify({ id: todo.id, status: "in_review", note: "ready for a look" }),
    });
    expect(reviewed.body).toMatchObject({ ok: true, evidence: { status: "in_review" } });
    const { listComments } = await import("../../work-items/comments.js");
    expect(listComments(todo.id).comments.map((c) => [c.body, c.authorKind])).toContainEqual(["ready for a look", "operator"]);

    // Sending it back is the review bounce, by voice as from the board.
    const sentBack = await call(context, "POST", orb.route, {
      providerCallId: "status-3",
      tool: "talk_set_todo_status",
      arguments: JSON.stringify({ id: todo.id, status: "executing", note: "add the midnight case" }),
    });
    expect(sentBack.body).toMatchObject({ ok: true, evidence: { status: "executing" } });
    expect(workItems.getWorkItem(todo.id)).toMatchObject({ status: "executing", rounds: 1 });
    expect(listComments(todo.id).comments.map((c) => c.body)).toContain("add the midnight case");
  });

  it("step 5a: an id that does not exist is refused in the words the operator needs", async () => {
    const context = testContext();
    const { route } = await pressTheOrb(context);

    const answered = await call(context, "POST", route, {
      providerCallId: "missing-1",
      tool: "read_todo",
      arguments: JSON.stringify({ id: "ZZZ-999" }),
    });

    expect(answered.body).toEqual({ ok: false, code: "execution-failed", error: "Todo ZZZ-999 not found" });
  });
});
