import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

/**
 * opencode server mode against an OpenCode 2 server, end to end on this machine.
 *
 * Real processes throughout: a fake `opencode` (fixtures/fake-opencode-v2.mjs)
 * that speaks the `/api/*` surface of a real 2.0.29 server (shapes taken from
 * its captured event streams and message store). So what is asserted is the
 * process the engine really spawns, the HTTP the pool and the v2 turn really
 * send, and the order they send it in. The real-binary version of the main
 * paths is opencode-v2-e2e.test.ts (gated).
 */

vi.mock("../../shared/logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { OpencodeEngine } from "../opencode.js";
import { OpencodeServerPool, basicAuthHeader } from "../opencode-server.js";
import { cancelledRequestsNotice, SERVER_TURN_TIMING } from "../opencode-server-turn.js";
import { RESEED_PREAMBLE } from "../opencode-server-compaction.js";
import { buildOpencodeViewArgs } from "../opencode-protocol.js";
import { clearOpencodeVersionCache } from "../../shared/opencode-bin-version.js";
import { isDeadSessionError } from "../../shared/rateLimit.js";
import { USER_STOP_INTERRUPTION_REASON } from "../../sessions/interruption-reasons.js";
import { PtyLifecycleManager } from "../pty-lifecycle.js";
import { JINN_HOME } from "../../shared/paths.js";
import type { EngineResult, EngineRunOpts, ResolvedMcpConfig, StreamDelta } from "../../shared/types.js";

const FAKE_V2 = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures", "fake-opencode-v2.mjs");
const TIMING_DEFAULTS = { ...SERVER_TURN_TIMING };
const MODEL = "opencode-go/deepseek-v4.1-flash";
const STOPPED_NOTICE_START = "[Jinn] Before this message, the user stopped the request(s) below before they were finished:";

const TOOLSET_MCP: ResolvedMcpConfig = {
  mcpServers: { jinn: { command: "node", args: ["/opt/jinn/mcp.js", "--jinn-toolset", "board-walk"], env: { JINN_SESSION_ID: "sess-1" } } },
} as ResolvedMcpConfig;
const COMPANY_MCP: ResolvedMcpConfig = {
  mcpServers: { jinn: { command: "node", args: ["/opt/jinn/mcp.js"], env: { JINN_SESSION_ID: "sess-1" } } },
} as ResolvedMcpConfig;

interface Harness {
  lifecycle: PtyLifecycleManager;
  pool: OpencodeServerPool;
  engine: OpencodeEngine;
}

let harnesses: Harness[] = [];

function harness(): Harness {
  const lifecycle = new PtyLifecycleManager({ maxLivePtys: 8, enforceLocalCap: false });
  const pool = new OpencodeServerPool(lifecycle, { limits: () => ({}), bin: () => FAKE_V2 });
  const engine = new OpencodeEngine({ mode: () => "server", servers: pool });
  const h = { lifecycle, pool, engine };
  harnesses.push(h);
  return h;
}

function runOpts(over: Partial<EngineRunOpts> = {}): EngineRunOpts {
  return { prompt: "build it", cwd: JINN_HOME, sessionId: "sess-1", bin: FAKE_V2, model: MODEL, ...over };
}

interface LogEntry { at: number; method: string; path: string; body?: Record<string, any>; answered?: string[] }

/** One call to the fake's HTTP API, as the pool would make it. */
async function call<T = any>(h: Harness, route: string, init: { method?: string; body?: unknown } = {}): Promise<{ status: number; body: T }> {
  const server = h.pool.get("sess-1")!;
  const res = await fetch(`${server.apiUrl}${route}`, {
    method: init.method ?? "GET",
    headers: { authorization: basicAuthHeader(server.password), ...(init.body === undefined ? {} : { "content-type": "application/json" }) },
    ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
  });
  const text = await res.text();
  let body: unknown = text;
  try { body = text ? JSON.parse(text) : undefined; } catch { /* html */ }
  return { status: res.status, body: body as T };
}

const logOf = async (h: Harness): Promise<LogEntry[]> => (await call<LogEntry[]>(h, "/test/log")).body;
const sessionMetadata = async (h: Harness, id: string): Promise<Record<string, any> | undefined> =>
  (await call(h, `/api/session/${id}`)).body.data.metadata;
const promptsOf = (log: LogEntry[]) => log.filter((e) => e.method === "POST" && /\/prompt$/.test(e.path));
const running = async (h: Harness): Promise<string[]> => Object.keys((await call(h, "/api/session/active")).body.data);

async function waitFor(check: () => boolean | Promise<boolean>, timeoutMs = 8000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    let ok = false;
    try { ok = await check(); } catch { ok = false; }
    if (ok) return;
    if (Date.now() > deadline) throw new Error("timed out waiting");
    await new Promise((r) => setTimeout(r, 25));
  }
}

async function streamed(h: Harness, over: Partial<EngineRunOpts> = {}): Promise<{ result: EngineResult; deltas: StreamDelta[] }> {
  const deltas: StreamDelta[] = [];
  const result = await h.engine.run(runOpts({ ...over, onStream: (d) => deltas.push(d) }));
  return { result, deltas };
}

/** The turn is running on the server and the prompt has been delivered to it. */
async function waitDelivered(h: Harness): Promise<void> {
  await waitFor(async () => (await running(h)).length === 1);
  // The engine reads the delivery from the event stream a moment after the server sends it.
  await new Promise((r) => setTimeout(r, 200));
}

const ENV_HOOKS = ["FAKE_V2_OPERATOR_BUSY_MS", "FAKE_V2_LOG", "FAKE_V2_VERSION", "FAKE_V2_SERVE_FAIL", "FAKE_V2_HEARTBEAT_MS"];

beforeEach(() => {
  for (const name of ENV_HOOKS) delete process.env[name];
  clearOpencodeVersionCache();
  Object.assign(SERVER_TURN_TIMING, TIMING_DEFAULTS, { statusPollMs: 30_000, closeWaitMs: 2_000 });
});

afterEach(async () => {
  for (const h of harnesses) {
    h.engine.killAll();
    void h.pool.stopAll();
  }
  for (const h of harnesses) await waitFor(() => h.pool.size() === 0).catch(() => {});
  harnesses = [];
});

describe("an OpenCode 2 server in the pool", { timeout: 30_000 }, () => {
  it("is recognised by its web-page health answer and /api/info, and answers a turn", async () => {
    const logFile = path.join(os.tmpdir(), `fake-opencode-v2-${process.pid}-${Date.now()}.log`);
    process.env.FAKE_V2_LOG = logFile;
    try {
      const h = harness();
      const { result, deltas } = await streamed(h, { systemPrompt: "You are Ada." });
      expect(result.error).toBeUndefined();
      // The system prompt is part of the first prompt; the fake answers with what follows its last `---`.
      expect(result.result).toBe("fake:build it");
      expect(result.sessionId).toMatch(/^ses_test/);
      expect(result.numTurns).toBe(1);
      expect(result.cost).toBeCloseTo(0.01);
      expect(result.contextTokens).toBe(1200);
      expect(deltas.filter((d) => d.type === "text").map((d) => d.content)).toEqual(["fake:build it"]);

      const server = h.pool.get("sess-1")!;
      expect(server.api).toBe(2);
      // The binary was asked its version before it started, and started on the pool's port.
      const verbs = fs.readFileSync(logFile, "utf8").trim().split("\n");
      expect(verbs[0]).toBe("--version");
      expect(verbs.some((l) => l === `serve --port ${server.apiUrl.split(":").pop()} --hostname 127.0.0.1`)).toBe(true);

      const health = await call(h, "/global/health");
      expect(health.status).toBe(200);
      expect(String(health.body)).toContain("<html");
      expect((await call(h, "/api/info")).body.version).toBe("2.0.29");
      const log = await logOf(h);
      // The pool's own probes come first: health (HTML), the version on /api/info, the event stream.
      expect(log.slice(0, 3).map((e) => `${e.method} ${e.path}`)).toEqual(["GET /global/health", "GET /api/info", "GET /api/event"]);
    } finally {
      fs.rmSync(logFile, { force: true });
    }
  });

  it("refuses requests without the server's password", async () => {
    const h = harness();
    await h.pool.acquire("sess-1", { cwd: JINN_HOME, bin: FAKE_V2 });
    const server = h.pool.get("sess-1")!;
    expect((await fetch(`${server.apiUrl}/api/info`)).status).toBe(401);
    h.pool.release("sess-1");
  });

  it("starts nothing for a server that exits at once", async () => {
    process.env.FAKE_V2_SERVE_FAIL = "1";
    const lifecycle = new PtyLifecycleManager({ maxLivePtys: 8, enforceLocalCap: false });
    const pool = new OpencodeServerPool(lifecycle, { limits: () => ({ startTimeoutMs: 3000 }), bin: () => FAKE_V2 });
    await expect(pool.acquire("sess-1", { cwd: JINN_HOME, bin: FAKE_V2 })).rejects.toThrow(/did not start/);
    expect(pool.size()).toBe(0);
  });

  it("tolerates the event stream's heartbeat comments mid-turn", async () => {
    process.env.FAKE_V2_HEARTBEAT_MS = "100";
    const h = harness();
    const { result } = await streamed(h, { prompt: "SLOW heartbeat" });
    expect(result.error).toBeUndefined();
    expect(result.result).toBe("fake:slow");
  });
});

describe("OpencodeEngine turns on an OpenCode 2 server", { timeout: 30_000 }, () => {
  it("creates the session without the question tool and posts the prompt as a queued, Jinn-marked input", async () => {
    const h = harness();
    const { result } = await streamed(h);
    const log = await logOf(h);
    const create = log.find((e) => e.method === "POST" && e.path === "/api/session")!;
    expect(create.body).toEqual({
      model: { providerID: "opencode-go", id: "deepseek-v4.1-flash" },
      permissions: [{ action: "question", resource: "*", effect: "deny" }],
    });
    const [prompt] = promptsOf(log);
    expect(prompt!.path).toBe(`/api/session/${result.sessionId}/prompt`);
    expect(prompt!.body).toEqual({
      id: expect.stringMatching(/^msg_[0-9a-f]{12}[0-9A-Za-z]{14}$/),
      text: "build it",
      metadata: { jinn: "prompt" },
      delivery: "queue",
    });
    // The server saw the event stream open before the prompt was posted.
    const order = log.map((e) => `${e.method} ${e.path}`);
    expect(order.lastIndexOf("GET /api/event")).toBeLessThan(order.indexOf(`POST /api/session/${result.sessionId}/prompt`));
  });

  it("resumes the session on the same server; the same model is not selected again, another one is", async () => {
    const h = harness();
    const first = await h.engine.run(runOpts());
    const server = h.pool.get("sess-1")!;

    const second = await h.engine.run(runOpts({ resumeSessionId: first.sessionId, prompt: "again" }));
    expect(second.result).toBe("fake:again");
    expect(second.sessionId).toBe(first.sessionId);
    expect(h.pool.get("sess-1")).toBe(server);
    let log = await logOf(h);
    expect(log.filter((e) => e.path === "/api/session" && e.method === "POST")).toHaveLength(1);
    expect(log.filter((e) => e.path.endsWith("/model"))).toEqual([]);
    expect(h.pool.holdCount("sess-1")).toBe(0);

    const third = await h.engine.run(runOpts({ resumeSessionId: first.sessionId, prompt: "other model", model: "mock/m2" }));
    expect(third.error).toBeUndefined();
    log = await logOf(h);
    const switched = log.filter((e) => e.path === `/api/session/${first.sessionId}/model`);
    expect(switched.map((e) => e.body)).toEqual([{ model: { providerID: "mock", id: "m2" } }]);
    // Selected before the prompt that needs it.
    const order = log.map((e) => `${e.method} ${e.path}`);
    expect(order.lastIndexOf(`POST /api/session/${first.sessionId}/model`)).toBeLessThan(order.lastIndexOf(`POST /api/session/${first.sessionId}/prompt`));
    // The step ran on the new model.
    const stored = (await call(h, `/api/session/${first.sessionId}/message?limit=5&order=desc`)).body.data;
    expect(stored.find((m: any) => m.type === "assistant").model).toMatchObject({ providerID: "mock", id: "m2" });
  });

  it("reads a resumed session's history before it posts, and with nothing cancelled posts the prompt alone", async () => {
    const h = harness();
    const first = await h.engine.run(runOpts());
    await h.engine.run(runOpts({ resumeSessionId: first.sessionId, prompt: "again" }));
    const log = await logOf(h);
    const tail = log.slice(-4).map((e) => `${e.method} ${e.path}`);
    expect(tail.slice(0, 3).sort()).toEqual([
      "GET /api/session/active",
      `GET /api/session/${first.sessionId}`,
      `GET /api/session/${first.sessionId}/message?limit=100&order=desc`,
    ].sort());
    expect(tail[3]).toBe(`POST /api/session/${first.sessionId}/prompt`);
    expect(log.at(-1)!.body!.text).toBe("again");
    expect(log.at(-1)!.body!.metadata).toEqual({ jinn: "prompt" });
  });

  it("selects the agent a resumed turn names in its cliFlags", async () => {
    const h = harness();
    const first = await h.engine.run(runOpts());
    const second = await h.engine.run(runOpts({ resumeSessionId: first.sessionId, cliFlags: ["--agent", "x"] }));
    expect(second.error).toBeUndefined();
    const log = await logOf(h);
    expect(log.filter((e) => e.path === `/api/session/${first.sessionId}/agent`).map((e) => e.body)).toEqual([{ agent: "x" }]);
    // The session now has it, so the next turn naming it does not select it again.
    await h.engine.run(runOpts({ resumeSessionId: first.sessionId, cliFlags: ["--agent", "x"] }));
    expect((await logOf(h)).filter((e) => e.path.endsWith("/agent"))).toHaveLength(1);
  });

  it("creates a session on the agent the first turn names", async () => {
    const h = harness();
    await h.engine.run(runOpts({ cliFlags: ["--agent", "walker"] }));
    const create = (await logOf(h)).find((e) => e.method === "POST" && e.path === "/api/session")!;
    expect(create.body!.agent).toBe("walker");
  });

  it("streams a tool call and its result, and answers with the text after it", async () => {
    const h = harness();
    const { result, deltas } = await streamed(h, { prompt: "TOOL please" });
    expect(result.error).toBeUndefined();
    expect(result.result).toBe("tool done");
    expect(result.numTurns).toBe(2);
    expect(result.cost).toBeCloseTo(0.02);
    expect(deltas.map((d) => d.type)).toEqual(["tool_use", "tool_result", "text"]);
    expect(deltas[0]).toMatchObject({ toolName: "shell", content: "shell: echo hi-from-tool" });
    expect(deltas[1]).toMatchObject({ toolName: "shell", content: "hi-from-tool\n" });
    expect(deltas[0]!.toolId).toMatch(/^call_/);
  });

  it("reads directives only from the text after the prompt's last `---`", async () => {
    const h = harness();
    const { result } = await streamed(h, { prompt: "plain", systemPrompt: "You may HANG and TOOL and FAIL at will." });
    expect(result.result).toBe("fake:plain");
  });
});

describe("stopping a turn", { timeout: 30_000 }, () => {
  it("interrupts the running execution, reports the reason, and notes the stopped prompt on the session", async () => {
    const h = harness();
    const turn = h.engine.run(runOpts({ prompt: "HANG now" }));
    await waitDelivered(h);
    h.engine.kill("sess-1", USER_STOP_INTERRUPTION_REASON);
    const result = await turn;
    expect(result.error).toBe(USER_STOP_INTERRUPTION_REASON);
    expect(result.result).toBe("");
    expect(h.engine.isAlive("sess-1")).toBe(false);

    const log = await logOf(h);
    const id = result.sessionId!;
    expect(log.some((e) => e.method === "POST" && e.path === `/api/session/${id}/interrupt`)).toBe(true);
    // run() returned only after the note was written.
    expect(await sessionMetadata(h, id)).toEqual({ jinn: { stopped: ["HANG now"] } });
    expect(await running(h)).toEqual([]);
    const idle = (await call(h, `/api/session/${id}/message?limit=1&order=desc`)).body.data[0];
    expect(idle).toMatchObject({ type: "idle", outcome: "interrupted" });
  });

  it("tells the next turn what the user stopped, marks that prompt as carrying a notice, and clears the note", async () => {
    const h = harness();
    const turn = h.engine.run(runOpts({ prompt: "HANG now" }));
    await waitDelivered(h);
    h.engine.kill("sess-1", USER_STOP_INTERRUPTION_REASON);
    const stopped = await turn;

    const next = await h.engine.run(runOpts({ resumeSessionId: stopped.sessionId, prompt: "carry on" }));
    expect(next.error).toBeUndefined();
    expect(next.result).toBe("fake:carry on");
    const log = await logOf(h);
    const prompt = promptsOf(log).at(-1)!.body!;
    expect(prompt.text.startsWith(STOPPED_NOTICE_START)).toBe(true);
    expect(prompt.text).toContain("> HANG now");
    expect(prompt.text.endsWith("\n\n---\n\ncarry on")).toBe(true);
    expect(prompt.metadata).toEqual({ jinn: "prompt", notice: true });
    // The notes were put in the prompt, and then removed from the session.
    expect(await sessionMetadata(h, stopped.sessionId!)).toBeUndefined();
    const patches = log.filter((e) => e.method === "PATCH");
    expect(patches.map((e) => e.body)).toEqual([{ metadata: { jinn: { stopped: ["HANG now"] } } }, { metadata: {} }]);

    // And the turn after that says nothing about it.
    await h.engine.run(runOpts({ resumeSessionId: stopped.sessionId, prompt: "and again" }));
    const last = promptsOf(await logOf(h)).at(-1)!.body!;
    expect(last.text).toBe("and again");
    expect(last.metadata).toEqual({ jinn: "prompt" });
  });

  it("does not note a stop for another reason than the user's", async () => {
    const h = harness();
    const turn = h.engine.run(runOpts({ prompt: "HANG now" }));
    await waitDelivered(h);
    h.engine.kill("sess-1", "Interrupted: gateway shutting down");
    const result = await turn;
    expect(result.error).toBe("Interrupted: gateway shutting down");
    expect(await sessionMetadata(h, result.sessionId!)).toBeUndefined();
  });

  it("takes a prompt still waiting in the inbox back out instead of interrupting the operator's execution", async () => {
    process.env.FAKE_V2_OPERATOR_BUSY_MS = "3000";
    const h = harness();
    const turn = h.engine.run(runOpts({ prompt: "queued behind the operator" }));
    await waitFor(async () => promptsOf(await logOf(h)).length === 1);
    // Posted, and the server is busy with the operator's input.
    await waitFor(async () => (await running(h)).length === 1);
    await new Promise((r) => setTimeout(r, 100));
    const promptId = promptsOf(await logOf(h))[0]!.body!.id as string;
    h.engine.kill("sess-1", USER_STOP_INTERRUPTION_REASON);
    const result = await turn;
    expect(result.error).toBe(USER_STOP_INTERRUPTION_REASON);

    const log = await logOf(h);
    const id = result.sessionId!;
    expect(log.some((e) => e.method === "DELETE" && e.path === `/api/session/${id}/inbox/${promptId}`)).toBe(true);
    expect(log.some((e) => e.path.endsWith("/interrupt"))).toBe(false);
    // The operator's execution is still running, and nothing was noted: the prompt never started.
    expect(await running(h)).toEqual([id]);
    expect(log.some((e) => e.method === "PATCH")).toBe(false);
    expect((await call(h, `/api/session/${id}/inbox`)).body.data).toEqual([]);
  });

  it("interrupts a turn already delivered, when the operator is no longer ahead of it", async () => {
    process.env.FAKE_V2_OPERATOR_BUSY_MS = "300";
    const h = harness();
    const turn = h.engine.run(runOpts({ prompt: "HANG after the operator" }));
    // Wait until the operator's input is done and the turn's own prompt is the one running.
    await waitFor(async () => {
      const id = promptsOf(await logOf(h))[0]?.path.split("/")[3];
      if (!id) return false;
      const items = (await call(h, `/api/session/${id}/message?limit=20&order=desc`)).body.data as any[];
      return items.some((m) => m.type === "user" && m.metadata?.jinn === "prompt");
    });
    await new Promise((r) => setTimeout(r, 200));
    h.engine.kill("sess-1", USER_STOP_INTERRUPTION_REASON);
    const result = await turn;
    expect(result.error).toBe(USER_STOP_INTERRUPTION_REASON);
    const log = await logOf(h);
    expect(log.some((e) => e.path.endsWith("/interrupt"))).toBe(true);
    expect(await sessionMetadata(h, result.sessionId!)).toEqual({ jinn: { stopped: ["HANG after the operator"] } });
  });
});

describe("a prompt queued behind the operator's own input", { timeout: 30_000 }, () => {
  it("answers with its own reply, not the operator's", async () => {
    process.env.FAKE_V2_OPERATOR_BUSY_MS = "400";
    const h = harness();
    const { result, deltas } = await streamed(h, { prompt: "my request" });
    expect(result.error).toBeUndefined();
    expect(result.result).toBe("fake:my request");
    expect(deltas.filter((d) => d.type === "text").map((d) => d.content)).toEqual(["fake:my request"]);
    expect(result.numTurns).toBe(1);

    // The operator's input did run first, in the same execution.
    const items = ((await call(h, `/api/session/${result.sessionId}/message?limit=20&order=asc`)).body.data as any[])
      .filter((m) => m.type === "user" || m.type === "assistant")
      .map((m) => (m.type === "user" ? `user:${m.text}` : `assistant:${m.content[0].text}`));
    expect(items).toEqual([
      "user:operator request",
      "assistant:operator reply",
      "user:my request",
      "assistant:fake:my request",
    ]);
    expect(await running(h)).toEqual([]);
  });
});

describe("what a turn answers to the server's questions", { timeout: 30_000 }, () => {
  it("grants a permission its own step asks for, once", async () => {
    const h = harness();
    const { result } = await streamed(h, { prompt: "PERMISSION please" });
    expect(result.error).toBeUndefined();
    expect(result.result).toBe("permission:once");
    const reply = (await logOf(h)).find((e) => /\/permission\/per_[^/]+\/reply$/.test(e.path))!;
    expect(reply.method).toBe("POST");
    expect(reply.body).toEqual({ decision: "once" });
  });

  it("dismisses a question form its own step raised", async () => {
    const h = harness();
    const { result } = await streamed(h, { prompt: "QUESTION please" });
    expect(result.error).toBeUndefined();
    expect(result.result).toBe("question:dismissed");
    const dismissed = (await logOf(h)).find((e) => e.method === "DELETE" && /\/form\/frm_/.test(e.path));
    expect(dismissed).toBeDefined();
  });
});

describe("a turn that goes wrong", { timeout: 40_000 }, () => {
  it("names the provider error of a failed execution, and is not mistaken for a dead session", async () => {
    const h = harness();
    const { result } = await streamed(h, { prompt: "FAIL please" });
    expect(result.result).toBe("");
    expect(result.error).toContain("provider.invalid-request");
    expect(result.error).toContain("malformed request body (HTTP 400)");
    expect(result.rateLimit).toBeUndefined();
    // The conversation exists: one turn, so a resume id is kept.
    expect(result.numTurns).toBe(1);
    expect(isDeadSessionError(result)).toBe(false);
    expect(result.sessionId).toMatch(/^ses_test/);
  });

  it("waits out a provider retry that is due soon, and answers", async () => {
    const h = harness();
    const { result } = await streamed(h, { prompt: "RETRY please" });
    expect(result.error).toBeUndefined();
    expect(result.result).toBe("fake:retried");
    expect(result.numTurns).toBe(1);
  });

  it("follows a fallback model's step on the same reply, and answers with its text", async () => {
    const h = harness();
    const { result } = await streamed(h, { prompt: "FALLBACK please" });
    expect(result.error).toBeUndefined();
    expect(result.result).toBe("fallback answer on fallback");
    // The session is put back on its own model afterwards.
    await waitFor(async () => (await call(h, `/api/session/${result.sessionId}`)).body.data.model.id === "deepseek-v4.1-flash");
  });

  it("ends a turn whose provider retry is far off after the grace window, with the reset time", async () => {
    SERVER_TURN_TIMING.retryGraceMs = 300;
    const h = harness();
    const before = Date.now();
    const { result } = await streamed(h, { prompt: "RETRYFAR please" });
    expect(result.result).toBe("");
    expect(result.error).toMatch(/mock 429; opencode would not retry it for 60 min/);
    expect(result.rateLimit?.status).toBe("rejected");
    const resetsAt = result.rateLimit!.resetsAt!;
    expect(resetsAt * 1000).toBeGreaterThan(before + 3_500_000);
    expect(resetsAt * 1000).toBeLessThan(Date.now() + 3_700_000);
    // The conversation exists; the abandoned turn is stopped on the server.
    expect(result.numTurns).toBe(1);
    expect((await logOf(h)).some((e) => e.path.endsWith("/interrupt"))).toBe(true);
    await waitFor(async () => (await running(h)).length === 0);
  });

  it("recovers a turn the stream never ended through the status poll, and reports the drift", async () => {
    SERVER_TURN_TIMING.statusPollMs = 100;
    const h = harness();
    const { result, deltas } = await streamed(h, { prompt: "NOIDLE please" });
    expect(result.error).toBeUndefined();
    expect(result.result).toBe("fake:noidle");
    // The stored reply's step accounting arrives with the recovery.
    expect(result.numTurns).toBe(1);
    // Streamed once, not again from the store.
    expect(deltas.filter((d) => d.type === "text")).toHaveLength(1);
    expect(h.pool.unsupportedReason("local")).toMatch(/API drift: the turn ended without the stream saying so/);
  });

  it("fails a turn whose event stream closes mid-turn, keeping the conversation", async () => {
    const h = harness();
    const { result } = await streamed(h, { prompt: "DROPSTREAM please" });
    expect(result.result).toBe("");
    expect(result.error).toContain("closed the event stream mid-turn");
    expect(result.numTurns).toBe(1);
    expect(isDeadSessionError(result)).toBe(false);
  });

  it("fails a resume of a session the server does not have, with zero turns (a dead session)", async () => {
    const h = harness();
    const result = await h.engine.run(runOpts({ resumeSessionId: "ses_test_missing" }));
    expect(result.error).toMatch(/404.*SessionNotFoundError/);
    expect(result.result).toBe("");
    expect(result.numTurns ?? 0).toBe(0);
    expect(isDeadSessionError(result)).toBe(true);
    expect(promptsOf(await logOf(h))).toEqual([]);
  });
});

describe("requests the operator cancelled in the session", { timeout: 30_000 }, () => {
  /** An operator prompt posted straight to the server and interrupted: what a
   *  Stop in opencode's own terminal leaves behind. */
  async function operatorCancelled(h: Harness, text: string): Promise<string> {
    const server = await h.pool.acquire("sess-1", { cwd: JINN_HOME, bin: FAKE_V2 });
    h.pool.release("sess-1");
    expect(server.api).toBe(2);
    const created = await call(h, "/api/session", { method: "POST", body: { model: { providerID: "opencode-go", id: "deepseek-v4.1-flash" } } });
    const id = created.body.data.id as string;
    await call(h, `/api/session/${id}/prompt`, { method: "POST", body: { text, delivery: "steer" } });
    await waitFor(async () => (await running(h)).includes(id));
    await call(h, `/api/session/${id}/interrupt`, { method: "POST" });
    await waitFor(async () => (await running(h)).length === 0);
    return id;
  }

  it("is told to the model in the next Jinn turn's prompt, which then carries a notice", async () => {
    const h = harness();
    const id = await operatorCancelled(h, "HANG while I think");
    const { result } = await streamed(h, { resumeSessionId: id, prompt: "what next" });
    expect(result.error).toBeUndefined();
    expect(result.result).toBe("fake:what next");
    const prompt = promptsOf(await logOf(h)).at(-1)!.body!;
    expect(prompt.text).toBe(`${cancelledRequestsNotice(["HANG while I think"])}\n\n---\n\nwhat next`);
    expect(prompt.metadata).toEqual({ jinn: "prompt", notice: true });
  });

  it("is told once: the next turn finds the history ended by an answered execution", async () => {
    const h = harness();
    const id = await operatorCancelled(h, "HANG while I think");
    await h.engine.run(runOpts({ resumeSessionId: id, prompt: "what next" }));
    await h.engine.run(runOpts({ resumeSessionId: id, prompt: "and then" }));
    const prompt = promptsOf(await logOf(h)).at(-1)!.body!;
    expect(prompt.text).toBe("and then");
    expect(prompt.metadata).toEqual({ jinn: "prompt" });
  });
});

describe("/compact on an OpenCode 2 server", { timeout: 30_000 }, () => {
  it("compacts through the server, notes the system-prompt re-seed, and has the next turn send it", async () => {
    const h = harness();
    const first = await h.engine.run(runOpts({ systemPrompt: "You are Ada." }));
    const result = await h.engine.run(runOpts({ resumeSessionId: first.sessionId, prompt: "/compact", systemPrompt: "You are Ada." }));
    expect(result.error).toBeUndefined();
    expect(result.sessionId).toBe(first.sessionId);
    expect(result.numTurns).toBe(1);
    expect(result.compaction?.preTokens).toBe(1200);
    expect(result.cost).toBeCloseTo(0.01);
    expect(await sessionMetadata(h, first.sessionId!)).toEqual({ jinn: { reseed: true } });

    // The compaction was queued, and its outcome awaited, over the event stream.
    const log = await logOf(h);
    const queued = log.find((e) => e.path === `/api/session/${first.sessionId}/compact`)!;
    expect(queued).toMatchObject({ method: "POST", body: { delivery: "queue" } });
    const stored = (await call(h, `/api/session/${first.sessionId}/message?limit=5&order=desc`)).body.data as any[];
    expect(stored.find((m) => m.type === "compaction")).toMatchObject({ status: "completed" });

    const next = await h.engine.run(runOpts({ resumeSessionId: first.sessionId, prompt: "after compaction", systemPrompt: "You are Ada." }));
    expect(next.result).toBe("fake:after compaction");
    const prompt = promptsOf(await logOf(h)).at(-1)!.body!;
    expect(prompt.text).toBe(`${RESEED_PREAMBLE}\n\nYou are Ada.\n\n---\n\nafter compaction`);
    expect(prompt.metadata).toEqual({ jinn: "prompt", notice: true });
    expect(await sessionMetadata(h, first.sessionId!)).toBeUndefined();
  });

  it("notes no re-seed when the turn has no system prompt", async () => {
    const h = harness();
    const first = await h.engine.run(runOpts());
    const result = await h.engine.run(runOpts({ resumeSessionId: first.sessionId, prompt: "/compact" }));
    expect(result.error).toBeUndefined();
    expect(await sessionMetadata(h, first.sessionId!)).toBeUndefined();
  });

  it("switches to the turn's model before compacting, as a turn does", async () => {
    const h = harness();
    const first = await h.engine.run(runOpts());
    await h.engine.run(runOpts({ resumeSessionId: first.sessionId, prompt: "/compact", model: "mock/m2" }));
    const log = await logOf(h);
    const order = log.map((e) => `${e.method} ${e.path}`);
    expect(order.lastIndexOf(`POST /api/session/${first.sessionId}/model`)).toBeLessThan(order.lastIndexOf(`POST /api/session/${first.sessionId}/compact`));
  });

  it("fails with the server's reason when the compaction fails, keeping the conversation", async () => {
    const h = harness();
    const first = await h.engine.run(runOpts({ prompt: "hello FAILCOMPACT" }));
    expect(first.result).toBe("fake:hello FAILCOMPACT");
    const result = await h.engine.run(runOpts({ resumeSessionId: first.sessionId, prompt: "/compact", systemPrompt: "You are Ada." }));
    expect(result.error).toBe("opencode compaction failed: Compaction summary did not match the required template");
    expect(result.numTurns).toBe(1);
    expect(result.compaction).toBeUndefined();
    expect(isDeadSessionError(result)).toBe(false);
    // A failed compaction summarized nothing away: no re-seed is due.
    expect(await sessionMetadata(h, first.sessionId!)).toBeUndefined();
    const stored = (await call(h, `/api/session/${first.sessionId}/message?limit=5&order=desc`)).body.data as any[];
    expect(stored.find((m) => m.type === "compaction")).toMatchObject({ status: "failed" });
  });

  it("fails a compaction of a session the server does not have, with no turns", async () => {
    const h = harness();
    await h.pool.acquire("sess-1", { cwd: JINN_HOME, bin: FAKE_V2 });
    h.pool.release("sess-1");
    const result = await h.engine.run(runOpts({ resumeSessionId: "ses_test_missing", prompt: "/compact" }));
    expect(result.error).toMatch(/opencode compaction failed:.*404/);
    expect(result.numTurns ?? 0).toBe(0);
  });
});

describe("the config staged for an OpenCode 2 server", { timeout: 30_000 }, () => {
  it("is in OpenCode 2's own shape, with the confined agent as permission rules", async () => {
    const h = harness();
    const { result } = await streamed(h, { resolvedMcp: TOOLSET_MCP });
    expect(result.error).toBeUndefined();
    const server = h.pool.get("sess-1")!;
    expect(server.stagedApi).toBe(2);

    const info = (await call(h, "/test/info")).body;
    // What the fake itself read at start, from the file the pool pointed OPENCODE_CONFIG at.
    const config = info.config;
    expect(config.mcp.servers.jinn).toMatchObject({ type: "local", command: ["node", "/opt/jinn/mcp.js", "--jinn-toolset", "board-walk"], codemode: false });
    expect(config.mcp.servers.jinn).not.toHaveProperty("enabled");
    expect(config.mcp).not.toHaveProperty("jinn");
    const rules = config.agents["jinn-walk"].permissions as Array<{ action: string; resource: string; effect: string }>;
    expect(Array.isArray(rules)).toBe(true);
    expect(rules[0]).toEqual({ action: "*", resource: "*", effect: "deny" });
    expect(rules.some((r) => r.effect === "allow" && r.action.startsWith("jinn_"))).toBe(true);
    expect(config).not.toHaveProperty("agent");

    // And it is the file the handle names.
    const handle = server.configHandle!;
    expect(handle.staged).toBe(true);
    if (handle.staged) expect(JSON.parse(fs.readFileSync(handle.configPath, "utf8"))).toEqual(config);
  });

  it("has no confined agent for a company toolset session", async () => {
    const h = harness();
    await streamed(h, { resolvedMcp: COMPANY_MCP });
    const config = (await call(h, "/test/info")).body.config;
    expect(config.mcp.servers.jinn.codemode).toBe(false);
    expect(config).not.toHaveProperty("agents");
  });

  it("waits for the MCP servers to connect before the first prompt is posted", async () => {
    const h = harness();
    const { result } = await streamed(h, { resolvedMcp: COMPANY_MCP });
    expect(result.error).toBeUndefined();
    const log = await logOf(h);
    const mcp = log.filter((e) => e.path === "/api/mcp");
    // Nothing listed the first time (opencode connects lazily), connected after.
    expect(mcp.length).toBeGreaterThanOrEqual(2);
    expect(mcp[0]!.answered).toEqual([]);
    expect(mcp.at(-1)!.answered).toEqual(["jinn:connected"]);
    const order = log.map((e) => e.path);
    const lastMcp = order.lastIndexOf("/api/mcp");
    const create = order.indexOf("/api/session");
    expect(lastMcp).toBeLessThan(create);
    const promptAt = log.findIndex((e) => /\/prompt$/.test(e.path));
    expect(lastMcp).toBeLessThan(promptAt);
    // And it let them settle: the server is not used the moment they report connected.
    expect(log[promptAt]!.at - log[lastMcp]!.at).toBeGreaterThanOrEqual(900);
    expect(h.pool.get("sess-1")!.ready).toBe(true);
  });

  it("does not ask about MCP servers when none are staged", async () => {
    const h = harness();
    await streamed(h);
    expect((await logOf(h)).some((e) => e.path === "/api/mcp")).toBe(false);
    expect((await call(h, "/test/info")).body.config).toBeNull();
  });
});

describe("the terminal view of an OpenCode 2 session", () => {
  it("attaches with --server, naming the session; 1.x keeps attach", () => {
    expect(buildOpencodeViewArgs("http://127.0.0.1:4321", "ses_test0001", 2)).toEqual(["--server", "http://127.0.0.1:4321", "-s", "ses_test0001"]);
    expect(buildOpencodeViewArgs("http://127.0.0.1:4321", undefined, 2)).toEqual(["--server", "http://127.0.0.1:4321"]);
    expect(buildOpencodeViewArgs("http://127.0.0.1:4321", "ses_test0001", 1)).toEqual(["attach", "http://127.0.0.1:4321", "-s", "ses_test0001"]);
    expect(buildOpencodeViewArgs("http://127.0.0.1:4321", "ses_test0001")).toEqual(["attach", "http://127.0.0.1:4321", "-s", "ses_test0001"]);
  });

  it("is given the argv for the API the pool found the server to speak", async () => {
    const h = harness();
    await streamed(h);
    const server = h.pool.get("sess-1")!;
    expect(buildOpencodeViewArgs(server.hostUrl, "ses_test0001", server.api)).toEqual(["--server", server.hostUrl, "-s", "ses_test0001"]);
  });
});
