/**
 * The honesty contract for the Talk control route.
 *
 * The failure this suite exists for: the operator dictated a Todo, the agent
 * said "that attempt didn't go through", and the gateway log for that window
 * held no trace of the attempt at all. Every dispatch now leaves three marks —
 * the caller's answer carries the adapter's real reason, one server line names
 * the operation and that reason, and the talk session's transcript carries a
 * row saying what could not be done.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import type { ServerResponse } from "node:http";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { ApiContext } from "../api.js";
import type { JinnConfig } from "../../shared/types.js";

const home = fs.mkdtempSync(path.join(os.tmpdir(), "jinn-talk-control-honesty-"));
process.env.JINN_HOME = home;

let handleApiRequest: typeof import("../api.js").handleApiRequest;
let sessions: typeof import("../../sessions/registry.js");
let logger: typeof import("../../shared/logger.js").logger;

beforeAll(async () => {
  ({ handleApiRequest } = await import("../api.js"));
  sessions = await import("../../sessions/registry.js");
  ({ logger } = await import("../../shared/logger.js"));
  (await import("../../shared/db.js")).initDb();
});

afterAll(async () => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
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
  return {
    gatewayAuthToken: "test-token",
    getConfig: () => config,
    connectors: new Map(),
    startTime: Date.now(),
    emit: vi.fn(),
    sessionManager: {
      getEngine: () => undefined,
      getEngines: () => new Map(),
      getQueue: () => ({ getPendingCount: () => 0, getTransportState: (_key: string, status: string) => status }),
    },
  } as unknown as ApiContext;
}

async function call(context: ApiContext, method: string, url: string, body?: unknown) {
  const capture = response();
  await handleApiRequest(request(method, url, body), capture.res, context);
  return capture.read();
}

async function openTalkSession(context: ApiContext) {
  vi.stubGlobal("fetch", async () => ({
    ok: true,
    json: async () => ({ value: "test-ephemeral-token", expires_at: Math.floor(Date.now() / 1000) + 600 }),
  }));
  const opened = await call(context, "POST", "/api/talk/sessions");
  expect(opened.status).toBe(201);
  const talkId = String(opened.body.id);
  const chat = sessions.listSessions({ source: "talk" })
    .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1))[0]!;
  return { talkId, route: `/api/talk/sessions/${talkId}/control`, chatSessionId: chat.id };
}

describe("Talk control honesty", () => {
  it("answers a missing Todo with the adapter's real reason, one log line, and one transcript row", async () => {
    const context = testContext();
    const { route, chatSessionId } = await openTalkSession(context);
    const warn = vi.spyOn(logger, "warn").mockImplementation(() => {});

    const answered = await call(context, "POST", route, {
      providerCallId: "missing-todo-1",
      tool: "read_todo",
      arguments: JSON.stringify({ id: "ZZZ-999" }),
    });

    // 1. The caller is told the real reason, not a house sentence.
    expect(answered.body).toEqual({ ok: false, code: "execution-failed", error: "Todo ZZZ-999 not found" });

    // 2. One server line names the operation and the reason.
    const failed = warn.mock.calls.map(([line]) => line).filter((line) => line.startsWith("talk control failed:"));
    expect(failed).toHaveLength(1);
    expect(failed[0]).toContain("read_todo");
    expect(failed[0]).toContain("Todo ZZZ-999 not found");
    warn.mockRestore();

    // 3. The transcript carries a failure row saying what could not be done.
    const rows = sessions.getMessages(chatSessionId)
      .filter((message) => message.content.startsWith("Couldn't "));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.content).toBe("Couldn't read_todo: Todo ZZZ-999 not found");
    expect(rows[0]!.meta).toMatchObject({ talk: { kind: "control-failure", verified: false, code: "execution-failed" } });
  });

  it("records a name the manifest does not declare rather than dropping it in silence", async () => {
    const context = testContext();
    const { route, chatSessionId } = await openTalkSession(context);
    const warn = vi.spyOn(logger, "warn").mockImplementation(() => {});

    const answered = await call(context, "POST", route, {
      providerCallId: "unknown-1",
      tool: "talk_invent_todo",
      arguments: JSON.stringify({ title: "anything" }),
    });

    expect(answered.body).toMatchObject({
      ok: false,
      code: "unknown-operation",
      error: "talk_invent_todo is not in the Talk manifest.",
    });
    expect(warn.mock.calls.some(([line]) => line.includes("talk control failed:") && line.includes("talk_invent_todo"))).toBe(true);
    warn.mockRestore();
    expect(sessions.getMessages(chatSessionId).map((message) => message.content))
      .toContain("Couldn't talk_invent_todo: talk_invent_todo is not in the Talk manifest.");
  });

  it("records a credential mismatch once at both failure layers", async () => {
    const context = testContext();
    const { route, chatSessionId } = await openTalkSession(context);
    const warn = vi.spyOn(logger, "warn").mockImplementation(() => {});

    const answered = await call(context, "POST", route, {
      providerCallId: "credential-mismatch-1",
      tool: "talk_send_to_session",
      arguments: JSON.stringify({ id: chatSessionId, message: "Must not land." }),
    });

    expect(answered).toMatchObject({ status: 409, body: { ok: false, code: "credential-mismatch" } });
    const failed = warn.mock.calls.map(([line]) => line)
      .filter((line) => line.startsWith("talk control failed:") && line.includes("credential-mismatch-1"));
    expect(failed).toHaveLength(1);
    expect(failed[0]).toContain("credential-mismatch");
    warn.mockRestore();

    const rows = sessions.getMessages(chatSessionId)
      .filter((message) => message.toolId === "credential-mismatch-1");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      content: "Couldn't talk_send_to_session: The control call does not match the active browser credential generation.",
      meta: { talk: { kind: "control-failure", code: "credential-mismatch" } },
    });
  });

  it("logs a verified success too, so the log carries the whole dispatch history", async () => {
    const context = testContext();
    const { route } = await openTalkSession(context);
    const workItems = await import("../../work-items/store.js");
    const todo = workItems.createWorkItem({ title: "Read me back", body: "Body." });
    const info = vi.spyOn(logger, "info").mockImplementation(() => {});

    const answered = await call(context, "POST", route, {
      providerCallId: "read-ok-1",
      tool: "read_todo",
      arguments: JSON.stringify({ id: todo.id }),
    });

    expect(answered.body).toMatchObject({ ok: true, operation: "read_todo", verified: true });
    expect(info.mock.calls.some(([line]) => line.startsWith("talk control ok:") && line.includes("read_todo"))).toBe(true);
    info.mockRestore();
  });
});
