import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { basicAuthHeader } from "../opencode-server.js";
import { parseSseEvent } from "../opencode-v2-turn.js";
import type { V2Event } from "../opencode-v2-events.js";

/**
 * The fake OpenCode 2 server (fixtures/fake-opencode-v2.mjs) against what the
 * real 2.0.29 server was captured doing: the engine tests lean on it, so its
 * own behaviour is pinned here, without the engine in between.
 */

const FAKE_V2 = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures", "fake-opencode-v2.mjs");
const PASSWORD = "test-password";

let proc: ChildProcess;
let base = "";
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fake-opencode-v2-"));
const logFile = path.join(dir, "verbs.log");
const versionLog = path.join(dir, "version.log");

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as net.AddressInfo;
      server.close(() => resolve(port));
    });
    server.on("error", reject);
  });
}

async function http(method: string, route: string, body?: unknown): Promise<{ status: number; type: string; text: string; json: any }> {
  const res = await fetch(`${base}${route}`, {
    method,
    headers: { authorization: basicAuthHeader(PASSWORD), ...(body === undefined ? {} : { "content-type": "application/json" }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await res.text();
  let json: unknown;
  try { json = text ? JSON.parse(text) : undefined; } catch { /* not JSON */ }
  return { status: res.status, type: res.headers.get("content-type") ?? "", text, json };
}

/** Each blank-line separated block of an SSE body, until the body ends or is aborted. */
async function readBlocks(body: ReadableStream<Uint8Array>, onBlock: (block: string) => void): Promise<void> {
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    for await (const chunk of body as unknown as AsyncIterable<Uint8Array>) {
      buffer += decoder.decode(chunk, { stream: true });
      const blocks = buffer.split("\n\n");
      buffer = blocks.pop() ?? "";
      blocks.forEach(onBlock);
    }
  } catch { /* aborted */ }
}

/** Everything the event stream says until `stop()` is called. */
async function subscribe(): Promise<{ events: V2Event[]; comments: string[]; stop: () => void }> {
  const controller = new AbortController();
  const res = await fetch(`${base}/api/event`, {
    headers: { authorization: basicAuthHeader(PASSWORD), accept: "text/event-stream" },
    signal: controller.signal,
  });
  const events: V2Event[] = [];
  const comments: string[] = [];
  void readBlocks(res.body!, (block) => {
    const event = parseSseEvent(block);
    if (event) events.push(event);
    else if (block.startsWith(":")) comments.push(block);
  });
  await waitFor(() => events.some((e) => e.type === "server.connected"));
  return { events, comments, stop: () => controller.abort() };
}

async function waitFor(check: () => boolean | Promise<boolean>, timeoutMs = 8000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error("timed out waiting");
    await new Promise((r) => setTimeout(r, 20));
  }
}

async function newSession(body: unknown = {}): Promise<string> {
  const created = await http("POST", "/api/session", body);
  expect(created.status).toBe(200);
  return created.json.data.id as string;
}

const typesOf = (events: V2Event[], sessionId: string, ...types: string[]) =>
  events.filter((e) => (types.length === 0 || types.includes(e.type)) && (e.data as any)?.sessionID === sessionId).map((e) => e.type);

beforeAll(async () => {
  const port = await freePort();
  base = `http://127.0.0.1:${port}`;
  proc = spawn(FAKE_V2, ["serve", "--port", String(port), "--hostname", "127.0.0.1"], {
    env: { ...process.env, OPENCODE_SERVER_PASSWORD: PASSWORD, FAKE_V2_LOG: logFile, FAKE_V2_HEARTBEAT_MS: "150" },
    stdio: "ignore",
  });
  await waitFor(async () => {
    try { return (await http("GET", "/api/info")).status === 200; } catch { return false; }
  });
}, 15_000);

afterAll(() => {
  proc?.kill("SIGKILL");
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("the fake OpenCode 2 server", { timeout: 20_000 }, () => {
  it("prints its version", async () => {
    const out = await new Promise<string>((resolve) => {
      const child = spawn(FAKE_V2, ["--version"], { env: { ...process.env, FAKE_V2_LOG: versionLog }, stdio: ["ignore", "pipe", "ignore"] });
      let text = "";
      child.stdout.on("data", (d) => { text += d; });
      child.on("close", () => resolve(text));
    });
    expect(out).toBe("opencode v2.0.29\n");
    expect(fs.readFileSync(versionLog, "utf8")).toBe("--version\n");
    expect(fs.readFileSync(logFile, "utf8")).toContain("serve --port");
  });

  it("wants the password, and answers a web page for routes it does not know (health included)", async () => {
    expect((await fetch(`${base}/api/info`)).status).toBe(401);
    expect((await fetch(`${base}/api/info`, { headers: { authorization: `Basic ${Buffer.from("opencode:wrong").toString("base64")}` } })).status).toBe(401);
    for (const route of ["/global/health", "/session/status", "/no/such/route"]) {
      const res = await http("GET", route);
      expect(res.status).toBe(200);
      expect(res.type).toContain("text/html");
    }
  });

  it("reports its version bare on /api/info, and wraps session answers in {data}", async () => {
    expect((await http("GET", "/api/info")).json).toMatchObject({ version: "2.0.29" });
    const created = await http("POST", "/api/session", { model: { providerID: "mock", id: "m1" }, agent: "build", permissions: [{ action: "question", resource: "*", effect: "deny" }] });
    expect(created.json.data).toMatchObject({ id: expect.stringMatching(/^ses_test/), model: { providerID: "mock", id: "m1", variant: "default" }, agent: "build" });
    expect((await http("GET", `/api/session/${created.json.data.id}`)).json.data.id).toBe(created.json.data.id);
  });

  it("answers an unknown session with 404 and SessionNotFoundError, on every session route", async () => {
    for (const [method, route, body] of [
      ["GET", "/api/session/ses_nope", undefined],
      ["PATCH", "/api/session/ses_nope", { metadata: {} }],
      ["POST", "/api/session/ses_nope/prompt", { text: "x" }],
      ["POST", "/api/session/ses_nope/model", { model: { providerID: "a", id: "b" } }],
      ["GET", "/api/session/ses_nope/message?limit=1&order=desc", undefined],
      ["GET", "/api/session/ses_nope/inbox", undefined],
      ["POST", "/api/session/ses_nope/compact", { delivery: "queue" }],
    ] as const) {
      const res = await http(method, route, body);
      expect(res.status, `${method} ${route}`).toBe(404);
      expect(res.json._tag).toBe("SessionNotFoundError");
    }
  });

  it("replaces the session's metadata whole on PATCH, and clears it with an empty object", async () => {
    const id = await newSession();
    expect((await http("GET", `/api/session/${id}`)).json.data).not.toHaveProperty("metadata");
    expect((await http("PATCH", `/api/session/${id}`, { metadata: { a: 1, jinn: { stopped: ["x"] } } })).status).toBe(204);
    expect((await http("GET", `/api/session/${id}`)).json.data.metadata).toEqual({ a: 1, jinn: { stopped: ["x"] } });
    await http("PATCH", `/api/session/${id}`, { metadata: { b: 2 } });
    expect((await http("GET", `/api/session/${id}`)).json.data.metadata).toEqual({ b: 2 });
    await http("PATCH", `/api/session/${id}`, { metadata: {} });
    expect((await http("GET", `/api/session/${id}`)).json.data).not.toHaveProperty("metadata");
  });

  it("selects a model with a 204 and an event, and leaves a model-switched item", async () => {
    const id = await newSession({ model: { providerID: "mock", id: "m1" } });
    const stream = await subscribe();
    expect((await http("POST", `/api/session/${id}/model`, { model: { providerID: "mock", id: "m2", variant: "high" } })).status).toBe(204);
    await waitFor(() => stream.events.some((e) => e.type === "session.model.selected"));
    stream.stop();
    expect(stream.events.find((e) => e.type === "session.model.selected")!.data).toMatchObject({
      sessionID: id,
      model: { providerID: "mock", id: "m2", variant: "high" },
      previous: { providerID: "mock", id: "m1", variant: "default" },
    });
    expect((await http("GET", `/api/session/${id}`)).json.data.model).toEqual({ providerID: "mock", id: "m2", variant: "high" });
    const items = (await http("GET", `/api/session/${id}/message?limit=5&order=desc`)).json.data;
    expect(items[0]).toMatchObject({ type: "model-switched", model: { id: "m2" }, previous: { id: "m1" } });
  });

  it("sends heartbeat comments on the event stream", async () => {
    const stream = await subscribe();
    await waitFor(() => stream.comments.length >= 2);
    stream.stop();
    expect(stream.comments[0]).toBe(": heartbeat");
  });

  it("runs a prompt as one execution, in the order a real server reports it", async () => {
    const id = await newSession();
    const stream = await subscribe();
    const posted = await http("POST", `/api/session/${id}/prompt`, { id: "msg_test_custom", text: "hello", metadata: { jinn: "prompt" }, delivery: "queue" });
    expect(posted.json.data).toMatchObject({ id: "msg_test_custom", type: "user", payload: { text: "hello", metadata: { jinn: "prompt" } }, delivery: "queue" });
    await waitFor(() => stream.events.some((e) => e.type === "session.execution.succeeded"));
    stream.stop();
    expect(typesOf(stream.events, id)).toEqual([
      "session.inbox.enqueued",
      "session.execution.started",
      "session.inbox.delivered",
      "session.step.started",
      "session.text.started",
      "session.text.ended",
      "session.step.streamed",
      "session.step.ended",
      "session.usage.updated",
      "session.execution.succeeded",
    ]);
    const delivered = stream.events.find((e) => e.type === "session.inbox.delivered")!.data as any;
    expect(delivered.inboxID).toBe("msg_test_custom");
    const items = (await http("GET", `/api/session/${id}/message?limit=10&order=desc`)).json.data;
    expect(items.map((m: any) => m.type)).toEqual(["idle", "assistant", "user"]);
    expect(items[0]).toMatchObject({ outcome: "succeeded" });
    expect(items[1]).toMatchObject({ finish: "stop", content: [{ type: "text", text: "fake:hello" }], tokens: { input: 1200 } });
    expect(items[2]).toMatchObject({ id: "msg_test_custom", text: "hello", metadata: { jinn: "prompt" } });
  });

  it("honours the message listing's limit and order", async () => {
    const id = await newSession();
    await http("POST", `/api/session/${id}/prompt`, { text: "one" });
    await waitFor(async () => (await http("GET", `/api/session/${id}/message?limit=10&order=desc`)).json.data[0]?.type === "idle");
    const asc = (await http("GET", `/api/session/${id}/message?limit=10&order=asc`)).json.data;
    expect(asc.map((m: any) => m.type)).toEqual(["user", "assistant", "idle"]);
    expect((await http("GET", `/api/session/${id}/message?limit=2&order=desc`)).json.data.map((m: any) => m.type)).toEqual(["idle", "assistant"]);
  });

  it("delivers a prompt queued while one runs inside the same execution, after the running one's steps", async () => {
    const id = await newSession();
    const stream = await subscribe();
    const first = await http("POST", `/api/session/${id}/prompt`, { text: "SLOW first", delivery: "queue" });
    await waitFor(() => stream.events.some((e) => e.type === "session.text.started"));
    const second = await http("POST", `/api/session/${id}/prompt`, { text: "second", delivery: "queue" });
    // Waiting in the inbox while the first runs.
    expect((await http("GET", `/api/session/${id}/inbox`)).json.data.map((i: any) => i.id)).toEqual([second.json.data.id]);
    await waitFor(() => stream.events.some((e) => e.type === "session.execution.succeeded"));
    stream.stop();

    const mine = stream.events.filter((e) => (e.data as any)?.sessionID === id);
    expect(mine.filter((e) => e.type === "session.execution.started")).toHaveLength(1);
    expect(mine.filter((e) => e.type === "session.execution.succeeded")).toHaveLength(1);
    const delivered = mine.filter((e) => e.type === "session.inbox.delivered").map((e) => (e.data as any).inboxID);
    expect(delivered).toEqual([first.json.data.id, second.json.data.id]);
    const firstStepEnded = mine.findIndex((e) => e.type === "session.step.ended");
    const secondDelivered = mine.findIndex((e) => e.type === "session.inbox.delivered" && (e.data as any).inboxID === second.json.data.id);
    expect(firstStepEnded).toBeGreaterThan(-1);
    expect(secondDelivered).toBeGreaterThan(firstStepEnded);
    expect((await http("GET", `/api/session/${id}/inbox`)).json.data).toEqual([]);
  });

  it("cancels an inbox item that has not been delivered, and says 404 for one that has", async () => {
    const id = await newSession();
    await http("POST", `/api/session/${id}/prompt`, { text: "SLOW running" });
    await waitFor(async () => Object.keys((await http("GET", "/api/session/active")).json.data).includes(id));
    const queued = await http("POST", `/api/session/${id}/prompt`, { id: "msg_test_queued", text: "never runs" });
    expect((await http("DELETE", `/api/session/${id}/inbox/${queued.json.data.id}`)).status).toBe(204);
    expect((await http("DELETE", `/api/session/${id}/inbox/${queued.json.data.id}`)).status).toBe(404);
    await waitFor(async () => !Object.keys((await http("GET", "/api/session/active")).json.data).includes(id));
    const users = (await http("GET", `/api/session/${id}/message?limit=10&order=asc`)).json.data.filter((m: any) => m.type === "user");
    expect(users.map((m: any) => m.text)).toEqual(["SLOW running"]);
  });

  it("interrupts: the step fails as aborted, the execution ends interrupted, an idle item says so", async () => {
    const id = await newSession();
    const stream = await subscribe();
    expect((await http("POST", `/api/session/${id}/interrupt`)).json).toEqual({ interrupted: false });
    await http("POST", `/api/session/${id}/prompt`, { text: "HANG" });
    await waitFor(() => stream.events.some((e) => e.type === "session.text.started"));
    expect(Object.keys((await http("GET", "/api/session/active")).json.data)).toEqual([id]);
    expect((await http("POST", `/api/session/${id}/interrupt`)).json).toEqual({ interrupted: true });
    await waitFor(() => stream.events.some((e) => e.type === "session.execution.interrupted"));
    stream.stop();
    const failed = stream.events.find((e) => e.type === "session.step.failed")!.data as any;
    expect(failed.error).toEqual({ type: "aborted", message: "Step interrupted" });
    expect(stream.events.find((e) => e.type === "session.execution.interrupted")!.data).toMatchObject({ reason: "user" });
    expect(typesOf(stream.events, id).slice(-2)).toEqual(["session.step.failed", "session.execution.interrupted"]);
    const items = (await http("GET", `/api/session/${id}/message?limit=10&order=desc`)).json.data;
    expect(items[0]).toMatchObject({ type: "idle", outcome: "interrupted" });
    expect(items[1]).toMatchObject({ type: "assistant", finish: "error", error: { type: "aborted" } });
    expect(Object.keys((await http("GET", "/api/session/active")).json.data)).toEqual([]);
  });

  it("runs the TOOL directive as a shell step that finishes tool-calls, then an answer", async () => {
    const id = await newSession();
    const stream = await subscribe();
    await http("POST", `/api/session/${id}/prompt`, { text: "notice\n\n---\n\nTOOL" });
    await waitFor(() => stream.events.some((e) => e.type === "session.execution.succeeded"));
    stream.stop();
    expect(typesOf(stream.events, id, "session.tool.input.started", "session.tool.called", "session.tool.success", "session.step.ended"))
      .toEqual(["session.tool.input.started", "session.tool.called", "session.tool.success", "session.step.ended", "session.step.ended"]);
    const started = stream.events.find((e) => e.type === "session.tool.input.started")!.data as any;
    expect(started.name).toBe("shell");
    const ended = stream.events.filter((e) => e.type === "session.step.ended").map((e) => (e.data as any).finish);
    expect(ended).toEqual(["tool-calls", "stop"]);
    const items = (await http("GET", `/api/session/${id}/message?limit=10&order=desc`)).json.data;
    expect(items[1].content[0].text).toBe("tool done");
    expect(items[2].content[0]).toMatchObject({ type: "tool", name: "shell", state: { status: "completed", content: [{ type: "text", text: "hi-from-tool\n" }] } });
  });

  it("ends a FAIL turn with step.failed, execution.failed and an idle carrying the error", async () => {
    const id = await newSession();
    const stream = await subscribe();
    await http("POST", `/api/session/${id}/prompt`, { text: "FAIL" });
    await waitFor(() => stream.events.some((e) => e.type === "session.execution.failed"));
    stream.stop();
    const failed = stream.events.find((e) => e.type === "session.execution.failed")!.data as any;
    expect(failed.error).toMatchObject({ type: "provider.invalid-request", status: 400 });
    expect(typesOf(stream.events, id).slice(-2)).toEqual(["session.step.failed", "session.execution.failed"]);
    const items = (await http("GET", `/api/session/${id}/message?limit=10&order=desc`)).json.data;
    expect(items[0]).toMatchObject({ type: "idle", outcome: "failed", error: { type: "provider.invalid-request" } });
  });

  it("compacts as an execution of its own: started names the input, ended does not", async () => {
    const id = await newSession();
    await http("POST", `/api/session/${id}/prompt`, { text: "hello" });
    await waitFor(async () => (await http("GET", `/api/session/${id}/message?limit=1&order=desc`)).json.data[0]?.type === "idle");
    const stream = await subscribe();
    const queued = await http("POST", `/api/session/${id}/compact`, { delivery: "queue" });
    expect(queued.json.data).toMatchObject({ type: "compaction", payload: {} });
    await waitFor(() => stream.events.some((e) => e.type === "session.execution.succeeded"));
    stream.stop();
    expect(typesOf(stream.events, id)).toEqual([
      "session.inbox.enqueued",
      "session.execution.started",
      "session.inbox.delivered",
      "session.compaction.started",
      "session.usage.updated",
      "session.compaction.ended",
      "session.execution.succeeded",
    ]);
    expect(stream.events.find((e) => e.type === "session.compaction.started")!.data).toMatchObject({ inputID: queued.json.data.id, reason: "manual" });
    expect(stream.events.find((e) => e.type === "session.compaction.ended")!.data).not.toHaveProperty("inputID");
    const items = (await http("GET", `/api/session/${id}/message?limit=10&order=desc`)).json.data;
    expect(items.find((m: any) => m.type === "compaction")).toMatchObject({ id: queued.json.data.id, status: "completed", summary: expect.stringContaining("Objective") });
  });

  it("answers /api/mcp with nothing the first time and, with no config file, nothing after", async () => {
    // This server has no OPENCODE_CONFIG: there is nothing to connect.
    expect((await http("GET", "/api/mcp")).json.data).toEqual([]);
    expect((await http("GET", "/api/mcp")).json.data).toEqual([]);
  });

  it("keeps a log of the requests it saw, and not its own test routes", async () => {
    const id = await newSession();
    await http("GET", `/api/session/${id}`);
    const log = (await http("GET", "/test/log")).json as Array<{ method: string; path: string; body?: unknown }>;
    expect(log.slice(-2).map((e) => `${e.method} ${e.path}`)).toEqual(["POST /api/session", `GET /api/session/${id}`]);
    expect(log.some((e) => e.path.startsWith("/test/"))).toBe(false);
  });
});
