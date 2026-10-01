import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

/**
 * opencode server mode, end to end on this machine.
 *
 * Real processes throughout: a fake `opencode` (fixtures/fake-opencode.mjs)
 * that speaks the same CLI and HTTP surface as opencode 1.18.31 — `serve` with
 * basic auth, sessions, `prompt_async` and an SSE `/event` stream, `attach` as the
 * TUI. So what is asserted is the process the engine really spawns, the HTTP
 * the pool really sends, and the order an interrupt really happens in.
 */

vi.mock("../../shared/logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { OpencodeEngine } from "../opencode.js";
import {
  OpencodeServerPool,
  basicAuthHeader,
  compareVersions,
  idleCapForHost,
  MIN_OPENCODE_SERVER_VERSION,
  opencodeMode,
  serverFingerprint,
  unsupportedVersionReason,
} from "../opencode-server.js";
import { SERVER_TURN_TIMING } from "../opencode-server-turn.js";
import { USER_MESSAGE_INTERRUPTION_REASON, USER_STOP_INTERRUPTION_REASON } from "../../sessions/interruption-reasons.js";
import { HELD_FOR_TURN_NOTICE, OpencodeInteractiveEngine, OPENCODE_VIEW_NEEDS_SERVER_MODE } from "../opencode-interactive.js";
import { PtyLifecycleManager } from "../pty-lifecycle.js";
import { JINN_HOME } from "../../shared/paths.js";
import type { OpencodeMode, OpencodeServerConfig } from "../../shared/config-types.js";
import type { EngineRunOpts, ResolvedMcpConfig } from "../../shared/types.js";
import type { PtyControlEvent } from "../pty-view-engine.js";

const FAKE = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures", "fake-opencode.mjs");

const MCP_A: ResolvedMcpConfig = {
  mcpServers: { jinn: { command: "node", args: ["/opt/jinn/mcp.js"], env: { JINN_SESSION_ID: "sess-1", JINN_SESSION_CAPABILITY: "cap-a" } } },
} as ResolvedMcpConfig;
const MCP_B: ResolvedMcpConfig = {
  mcpServers: { jinn: { command: "node", args: ["/opt/jinn/mcp.js"], env: { JINN_SESSION_ID: "sess-1", JINN_WORKFLOW_ATTEMPT: "1" } } },
} as ResolvedMcpConfig;

interface Harness {
  lifecycle: PtyLifecycleManager;
  pool: OpencodeServerPool;
  engine: OpencodeEngine;
  setMode: (m: OpencodeMode) => void;
  limits: OpencodeServerConfig;
}

let harnesses: Harness[] = [];

function harness(limits: OpencodeServerConfig = {}): Harness {
  let mode: OpencodeMode = "server";
  const lifecycle = new PtyLifecycleManager({ maxLivePtys: 8, enforceLocalCap: false });
  const pool = new OpencodeServerPool(lifecycle, { limits: () => limits, bin: () => FAKE });
  const engine = new OpencodeEngine({ mode: () => mode, servers: pool });
  const h = { lifecycle, pool, engine, setMode: (m: OpencodeMode) => { mode = m; }, limits };
  harnesses.push(h);
  return h;
}

function runOpts(over: Partial<EngineRunOpts> = {}): EngineRunOpts {
  return { prompt: "build it", cwd: JINN_HOME, sessionId: "sess-1", bin: FAKE, model: "opencode-go/deepseek-v4.1-flash", ...over };
}

async function api<T = unknown>(pool: OpencodeServerPool, sessionId: string, route: string, opts: { auth?: boolean } = {}): Promise<{ status: number; body: T }> {
  const server = pool.get(sessionId)!;
  const res = await fetch(`${server.apiUrl}${route}`, {
    headers: opts.auth === false ? {} : { authorization: basicAuthHeader(server.password) },
  });
  const text = await res.text();
  let body: unknown = text;
  try { body = text ? JSON.parse(text) : undefined; } catch { /* plain-text answer, e.g. a 401 */ }
  return { status: res.status, body: body as T };
}

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

beforeEach(() => {
  delete process.env.FAKE_OPENCODE_SERVE_FAIL;
  delete process.env.FAKE_OPENCODE_VERSION;
  delete process.env.FAKE_OPENCODE_SERVE_LOG;
  delete process.env.FAKE_OPENCODE_CREATE_DELAY_MS;
  delete process.env.FAKE_OPENCODE_HISTORY_DELAY_MS;
  delete process.env.FAKE_OPENCODE_PATCH_FAIL;
  delete process.env.FAKE_OPENCODE_PATCH_DELAY_MS;
  delete process.env.FAKE_OPENCODE_SUMMARIZE_DELAY_MS;
  delete process.env.FAKE_OPENCODE_BOOTSTRAP_MS;
  SERVER_TURN_TIMING.statusPollMs = 30_000;
  SERVER_TURN_TIMING.connectMs = 15_000;
});

afterEach(async () => {
  for (const h of harnesses) {
    h.engine.killAll();
    void h.pool.stopAll();
  }
  for (const h of harnesses) await waitFor(() => h.pool.size() === 0).catch(() => {});
  harnesses = [];
});

describe("opencodeMode / idle caps / fingerprint", () => {
  it("only `server` is server mode; anything else keeps the old behaviour", () => {
    expect(opencodeMode({ mode: "server" })).toBe("server");
    expect(opencodeMode({ mode: "run" })).toBe("run");
    expect(opencodeMode({ mode: "Server" })).toBe("run");
    expect(opencodeMode(undefined)).toBe("run");
  });

  it("reads the idle cap per host, falling back to maxIdle and then 2", () => {
    const limits = { maxIdle: 3, maxIdleByHost: { local: 0, "10.0.0.5": 6 } };
    expect(idleCapForHost(limits, "local")).toBe(0);
    expect(idleCapForHost(limits, "10.0.0.5")).toBe(6);
    expect(idleCapForHost(limits, "other-box")).toBe(3);
    expect(idleCapForHost(undefined, "local")).toBe(2);
  });

  it("a different MCP set or host is a different server; the model is not", () => {
    const base = { cwd: "/w", bin: FAKE, resolvedMcp: MCP_A };
    expect(serverFingerprint(base)).toBe(serverFingerprint({ ...base }));
    expect(serverFingerprint(base)).not.toBe(serverFingerprint({ ...base, resolvedMcp: MCP_B }));
    expect(serverFingerprint(base)).not.toBe(serverFingerprint({ ...base, remoteHost: "box", remoteCwd: "/w" }));
  });
});

describe("OpencodeServerPool", { timeout: 20_000 }, () => {
  it("starts one password-protected server per session with the session's MCP config, and reuses it", async () => {
    const { pool } = harness();
    const first = await pool.acquire("sess-1", { cwd: JINN_HOME, bin: FAKE, resolvedMcp: MCP_A });
    const again = await pool.acquire("sess-1", { cwd: JINN_HOME, bin: FAKE, resolvedMcp: MCP_A });
    expect(again).toBe(first);
    expect(pool.holdCount("sess-1")).toBe(2);

    expect((await api(pool, "sess-1", "/global/health", { auth: false })).status).toBe(401);
    const info = await api<{ config: { mcp: Record<string, unknown> }; jinnSessionId: string; argv: string[]; cwd: string }>(pool, "sess-1", "/test/info");
    expect(info.status).toBe(200);
    expect(info.body.argv).toEqual(["serve", "--port", first.apiUrl.split(":").pop(), "--hostname", "127.0.0.1"]);
    expect(Object.keys(info.body.config.mcp)).toEqual(["jinn"]);
    expect(info.body.jinnSessionId).toBe("sess-1");
    expect(fs.realpathSync(info.body.cwd)).toBe(fs.realpathSync(JINN_HOME));

    const configPath = first.configHandle && first.configHandle.staged ? first.configHandle.configPath : "";
    expect(fs.existsSync(configPath)).toBe(true);
    pool.release("sess-1");
    pool.release("sess-1");
    await pool.stop("sess-1");
    expect(pool.size()).toBe(0);
    expect(fs.existsSync(configPath)).toBe(false);
  });

  it("a turn replaces a server started for a different MCP set; a viewer takes whatever is running", async () => {
    const { pool } = harness();
    const a = await pool.acquire("sess-1", { cwd: JINN_HOME, bin: FAKE, resolvedMcp: MCP_A });
    pool.release("sess-1");
    const viewed = await pool.acquire("sess-1", { cwd: JINN_HOME, bin: FAKE, resolvedMcp: MCP_B }, { reuseAny: true });
    expect(viewed).toBe(a);
    pool.release("sess-1");
    const b = await pool.acquire("sess-1", { cwd: JINN_HOME, bin: FAKE, resolvedMcp: MCP_B });
    expect(b).not.toBe(a);
    expect(a.exited).toBe(true);
    pool.release("sess-1");
  });

  it("stops an idle server over its host's cap, but never a held one", async () => {
    const { pool } = harness({ maxIdleByHost: { local: 0 } });
    const server = await pool.acquire("sess-1", { cwd: JINN_HOME, bin: FAKE });
    pool.enforceIdleLimits();
    expect(pool.get("sess-1")).toBe(server); // held
    pool.release("sess-1");
    await waitFor(() => server.exited);
    expect(pool.size()).toBe(0);
  });

  it("stops a server idle past idleTtlMs", async () => {
    const { pool } = harness({ idleTtlMs: 60_000 });
    const server = await pool.acquire("sess-1", { cwd: JINN_HOME, bin: FAKE });
    pool.release("sess-1");
    pool.enforceIdleLimits(Date.now() + 1_000);
    expect(pool.get("sess-1")).toBe(server);
    pool.enforceIdleLimits(Date.now() + 61_000);
    await waitFor(() => server.exited);
  });

  it("reports a server that will not start, and leaves nothing behind", async () => {
    process.env.FAKE_OPENCODE_SERVE_FAIL = "1";
    const { pool } = harness({ startTimeoutMs: 3000 });
    await expect(pool.acquire("sess-1", { cwd: JINN_HOME, bin: FAKE })).rejects.toThrow(/did not start/);
    expect(pool.size()).toBe(0);
  });
});

describe("OpencodeEngine in server mode", { timeout: 20_000 }, () => {
  type LogEntry = { method: string; url: string; body: Record<string, unknown> };
  const logOf = async (h: Harness) => (await api<LogEntry[]>(h.pool, "sess-1", "/test/log")).body;

  it("creates the opencode session, sends the prompt with its model, and answers with the completed text", async () => {
    const h = harness();
    const deltas: Array<{ type: string; content: string }> = [];
    const first = await h.engine.run(runOpts({ resolvedMcp: MCP_A, systemPrompt: "You are Ada.", onStream: (d) => deltas.push(d) }));
    expect(first.error).toBeUndefined();
    // The streamed "partial" text part (no end time) is not the answer.
    expect(first.result).toBe("answer:You are Ada.\n\n---\n\nbuild it model=opencode-go/deepseek-v4.1-flash");
    expect(first.sessionId).toMatch(/^ses_fake/);
    expect(first.numTurns).toBe(1);
    expect(first.cost).toBeCloseTo(0.001);
    expect(first.contextTokens).toBe(15);
    expect(deltas.filter((d) => d.type === "text").map((d) => d.content)).toEqual([first.result]);

    const log = await logOf(h);
    expect(log.map((e) => `${e.method} ${e.url}`)).toEqual([
      "GET /global/health",
      "POST /session",
      `POST /session/${first.sessionId}/prompt_async`,
    ]);
    expect(log[2]!.body).toEqual({
      // Posted under the turn's own message id, which scopes everything after.
      messageID: expect.stringMatching(/^msg_[0-9a-f]{12}[0-9A-Za-z]{14}$/),
      // Marked as Jinn's, so a later turn can tell it from the operator's.
      parts: [{ type: "text", text: "You are Ada.\n\n---\n\nbuild it", metadata: { jinn: "prompt" } }],
      model: { providerID: "opencode-go", modelID: "deepseek-v4.1-flash" },
      // `opencode run` offers no question tool; neither does a server turn.
      tools: { question: false },
    });

    // The next turn resumes on the same server and session — no new session.
    const server = h.pool.get("sess-1")!;
    const second = await h.engine.run(runOpts({ resolvedMcp: MCP_A, resumeSessionId: first.sessionId, cliFlags: ["--agent", "build"] }));
    expect(second.result).toBe("answer:build it model=opencode-go/deepseek-v4.1-flash agent=build");
    expect(second.sessionId).toBe(first.sessionId);
    expect(h.pool.get("sess-1")).toBe(server);
    expect((await logOf(h)).filter((e) => e.url === "/session")).toHaveLength(1);
    expect(h.pool.holdCount("sess-1")).toBe(0);
    // A resumed turn reads the session's recent history and status (together)
    // before it posts, and with nothing cancelled its prompt is the prompt alone.
    const tail = (await logOf(h)).slice(-3).map((e) => `${e.method} ${e.url}`);
    expect(tail.slice(0, 2).sort()).toEqual([`GET /session/${first.sessionId}/message?limit=100`, "GET /session/status"]);
    expect(tail[2]).toBe(`POST /session/${first.sessionId}/prompt_async`);
    expect((await logOf(h)).at(-1)!.body.parts).toEqual([{ type: "text", text: "build it", metadata: { jinn: "prompt" } }]);
  });

  describe("an interrupt that lands before opencode has picked the prompt up", () => {
    // The fake picks SLOWBUSY prompts up 500 ms after the POST and, like the
    // real server, loses an abort that arrives before then.
    async function interruptAt(h: Harness, delayAfterPostMs: number) {
      const realFetch = globalThis.fetch;
      const spy = vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
        const res = await realFetch(input, init);
        if (String(input).endsWith("/prompt_async")) {
          if (delayAfterPostMs === 0) h.engine.kill("sess-1", "Interrupted: operator");
          else setTimeout(() => h.engine.kill("sess-1", "Interrupted: operator"), delayAfterPostMs);
        }
        return res;
      });
      try {
        return await h.engine.run(runOpts({ prompt: "SLOWBUSY count to forty" }));
      } finally {
        spy.mockRestore();
      }
    }

    async function replies(h: Harness) {
      const post = (await logOf(h)).find((e) => e.url.endsWith("/prompt_async"))!;
      const stored = (await api<Array<{ info: { role: string; parentID?: string; error?: { name: string }; finish?: string }; parts: Array<{ text?: string }> }>>(
        h.pool, "sess-1", post.url.replace("/prompt_async", "/message"))).body;
      return stored.filter((m) => m.info.role === "assistant" && m.info.parentID === post.body.messageID);
    }

    it("mid-post: the prompt is stopped when it starts, not left to run", async () => {
      const h = harness();
      const result = await interruptAt(h, 0);
      expect(result.error).toBe("Interrupted: operator");
      const reply = await replies(h);
      expect(reply).toHaveLength(1);
      expect(reply[0]!.info.error?.name).toBe("MessageAbortedError");
      expect(JSON.stringify(reply[0]!.parts)).not.toContain("answer:");
      expect(Object.keys((await api<Record<string, unknown>>(h.pool, "sess-1", "/session/status")).body)).toEqual([]);
    });

    it("20 ms after the post: the same", async () => {
      const h = harness();
      const result = await interruptAt(h, 20);
      expect(result.error).toBe("Interrupted: operator");
      const reply = await replies(h);
      expect(reply[0]!.info.error?.name).toBe("MessageAbortedError");
      expect(JSON.stringify(reply[0]!.parts)).not.toContain("answer:");
    });
  });

  it("an interrupt while the server is still starting is kept: nothing is posted, and the turn reports it", async () => {
    const h = harness();
    const turn = h.engine.run(runOpts({ prompt: "must never run" }));
    expect(h.engine.isAlive("sess-1")).toBe(true);
    h.engine.kill("sess-1", "Interrupted: operator");
    const result = await turn;
    expect(result.error).toBe("Interrupted: operator");
    await waitFor(() => Boolean(h.pool.get("sess-1")));
    expect((await logOf(h)).some((e) => e.url.endsWith("/prompt_async"))).toBe(false);
    expect(h.pool.holdCount("sess-1")).toBe(0);
  });

  it("a server-mode turn without a session id leaves every session's server alone", async () => {
    const h = harness();
    await h.engine.run(runOpts());
    const server = h.pool.get("sess-1")!;
    await h.engine.run(runOpts({ sessionId: undefined }));
    expect(server.exited).toBe(false);
    expect(h.pool.get("sess-1")).toBe(server);
  });

  it("an interrupt aborts the turn on the server and settles only once it is idle", async () => {
    const h = harness();
    const turn = h.engine.run(runOpts({ prompt: "HANG please" }));
    await waitFor(async () => Object.keys((await api<Record<string, unknown>>(h.pool, "sess-1", "/session/status")).body ?? {}).length === 1);
    expect(h.engine.isAlive("sess-1")).toBe(true);
    h.engine.kill("sess-1", "Interrupted: operator");
    const result = await turn;
    expect(result.error).toBe("Interrupted: operator");
    expect(h.engine.isAlive("sess-1")).toBe(false);
    expect((await logOf(h)).some((e) => /^\/session\/[^/]+\/abort$/.test(e.url))).toBe(true);
    expect((await api<Record<string, unknown>>(h.pool, "sess-1", "/session/status")).body).toEqual({});
    // The server outlives the interrupt; only the turn ended.
    expect(h.pool.get("sess-1")).toBeDefined();
  });

  it("grants a permission the server asks for, once, as --dangerously-skip-permissions would", async () => {
    const h = harness();
    const deltas: Array<{ type: string; content: string }> = [];
    const result = await h.engine.run(runOpts({ prompt: "PERMISSION then answer", onStream: (d) => deltas.push(d) }));
    expect(result.error).toBeUndefined();
    const reply = (await logOf(h)).find((e) => /^\/permission\/[^/]+\/reply$/.test(e.url))!;
    expect(reply.body).toEqual({ reply: "once" });
    expect(deltas).toContainEqual(expect.objectContaining({ type: "tool_result", content: "permission:once" }));
    expect(deltas.filter((d) => d.type === "tool_use")).toHaveLength(1);
  });

  it("switches the question tool off, as `opencode run` has none: the turn never waits on a question", async () => {
    const h = harness();
    const result = await h.engine.run(runOpts({ prompt: "QUESTION then answer" }));
    expect(result.error).toBeUndefined();
    expect((await logOf(h)).some((e) => e.url.startsWith("/question/"))).toBe(false);
  });

  it("rejects a question a sub-session of the turn still asks, rather than hang", async () => {
    const h = harness();
    const result = await h.engine.run(runOpts({ prompt: "CHILDQ then answer" }));
    expect(result.error).toBeUndefined();
    expect((await logOf(h)).some((e) => /^\/question\/[^/]+\/reject$/.test(e.url))).toBe(true);
  });

  it("an operator prompt queued into the turn's own session is not the turn's answer, and its permission is not granted", async () => {
    const h = harness();
    const turn = h.engine.run(runOpts({ prompt: "SLOW jinn work" }));
    await waitFor(async () => (await logOf(h)).some((e) => e.url.endsWith("/prompt_async")));
    const engineSession = (await logOf(h)).find((e) => e.url.endsWith("/prompt_async"))!.url.split("/")[2]!;
    // Straight to the server, as the operator's own TUI would — no composer hold.
    await h.pool.promptAsync("sess-1", engineSession, "OPERATOR_REPLY PERMISSION");
    const result = await turn;
    expect(result.error).toBeUndefined();
    expect(result.result).toBe("answer:SLOW jinn work model=opencode-go/deepseek-v4.1-flash");
    // The operator's prompt runs on after the turn returned; let it finish.
    await waitFor(async () => Object.keys((await api<Record<string, unknown>>(h.pool, "sess-1", "/session/status")).body).length === 0);
    // It asked for a permission; the Jinn turn left it alone.
    expect((await logOf(h)).some((e) => e.url.startsWith("/permission/"))).toBe(false);
    const stored = (await api<Array<{ info: { parentID?: string }; parts: Array<{ output?: string; state?: { output?: string } }> }>>(
      h.pool, "sess-1", `/session/${engineSession}/message`)).body;
    expect(JSON.stringify(stored)).toContain("permission:unanswered");
  });

  it("an operator prompt blocked on a permission behind the turn does not hold the turn open", async () => {
    const h = harness();
    const turn = h.engine.run(runOpts({ prompt: "SLOW jinn work" }));
    await waitFor(async () => (await logOf(h)).some((e) => e.url.endsWith("/prompt_async")));
    const engineSession = (await logOf(h)).find((e) => e.url.endsWith("/prompt_async"))!.url.split("/")[2]!;
    const started = Date.now();
    await h.pool.promptAsync("sess-1", engineSession, "OPERATOR PERMWAIT");
    const result = await turn;
    // Its own reply is done: the turn returns, though the session stays busy
    // on the operator's prompt, which waits a minute for its permission.
    expect(result.result).toBe("answer:SLOW jinn work model=opencode-go/deepseek-v4.1-flash");
    expect(Date.now() - started).toBeLessThan(5_000);
    expect(Object.keys((await api<Record<string, unknown>>(h.pool, "sess-1", "/session/status")).body)).toEqual([engineSession]);
    expect((await logOf(h)).some((e) => e.url.startsWith("/permission/"))).toBe(false);
  });

  it("a turn queued behind a running operator prompt sees that prompt's reply and permission, and takes neither", async () => {
    // The other order from the tests above: the operator's reply streams while
    // the Jinn turn is already listening, so only the parentID check keeps it
    // out (QA B1 on nothing failed with every reply classed as own).
    const h = harness();
    const first = await h.engine.run(runOpts({ prompt: "first" }));
    await h.pool.promptAsync("sess-1", first.sessionId, "OPERATOR SLOWSTART PERMISSION");
    await waitFor(async () => Object.keys((await api<Record<string, unknown>>(h.pool, "sess-1", "/session/status")).body).length > 0);
    const next = await h.engine.run(runOpts({ prompt: "jinn second", resumeSessionId: first.sessionId }));
    expect(next.error).toBeUndefined();
    expect(next.result).toBe("answer:jinn second model=opencode-go/deepseek-v4.1-flash");
    // The operator's permission was asked while the turn listened, and left alone.
    expect((await logOf(h)).some((e) => e.url.startsWith("/permission/"))).toBe(false);
    const stored = (await api<Array<{ info: { id: string; role: string; parentID?: string; time?: { created?: number } } }>>(
      h.pool, "sess-1", `/session/${first.sessionId}/message`)).body;
    expect(JSON.stringify(stored)).toContain("permission:unanswered");
    // Only meaningful if the turn was listening before the operator's reply
    // began: it subscribes before it posts, so its post must come first.
    const jinnPost = (await logOf(h)).filter((e) => e.url.endsWith("/prompt_async")).at(-1) as LogEntry & { at: number };
    const operatorPrompt = stored.filter((m) => m.info.role === "user")[1]!.info.id;
    const operatorReply = stored.find((m) => m.info.parentID === operatorPrompt)!;
    expect(jinnPost.at).toBeLessThan(operatorReply.info.time!.created!);
  });

  type Stored = Array<{ info: { id: string; role: string; parentID?: string; error?: { name: string }; time?: { created?: number; completed?: number } } }>;

  /** The live smoke's steps 3d-4 up to the abort, in the order real opencode
   *  1.18.31 ran them when the smoke failed: the operator's prompt starts as the
   *  Jinn turn's reply completes, blocks on a permission, and the operator
   *  Esc-aborts it. Returns the opencode session and the operator's prompt id. */
  async function operatorAbortsAfterTurn(h: Harness): Promise<{ engineSession: string; operatorPrompt: string }> {
    const turn = h.engine.run(runOpts({ prompt: "SLOW jinn work" }));
    await waitFor(async () => (await logOf(h)).some((e) => e.url.endsWith("/prompt_async")));
    const engineSession = (await logOf(h)).find((e) => e.url.endsWith("/prompt_async"))!.url.split("/")[2]!;
    await h.pool.promptAsync("sess-1", engineSession, "OPERATOR PERMWAIT");
    expect((await turn).result).toBe("answer:SLOW jinn work model=opencode-go/deepseek-v4.1-flash");
    const stored = async () => (await api<Stored>(h.pool, "sess-1", `/session/${engineSession}/message`)).body;
    const operatorPrompt = (await stored()).filter((m) => m.info.role === "user")[1]!.info.id;
    // Running, and blocked on its permission, before the operator aborts it.
    await waitFor(async () => (await stored()).some((m) => m.info.parentID === operatorPrompt));
    await abortSession(h, engineSession);
    return { engineSession, operatorPrompt };
  }

  /** What the operator's Esc does: abort the session on the server, then wait for idle. */
  async function abortSession(h: Harness, engineSession: string): Promise<void> {
    const server = h.pool.get("sess-1")!;
    await fetch(`${server.apiUrl}/session/${engineSession}/abort`, { method: "POST", headers: { authorization: basicAuthHeader(server.password) } });
    await waitFor(async () => Object.keys((await api<Record<string, unknown>>(h.pool, "sess-1", "/session/status")).body).length === 0);
  }

  const lastPost = async (h: Harness) => (await logOf(h)).filter((e) => e.url.endsWith("/prompt_async")).at(-1)!;
  const permissionReplies = async (h: Harness) => (await logOf(h)).filter((e) => /^\/permission\/[^/]+\/reply$/.test(e.url)).map((e) => e.body);

  it("a turn after an aborted operator prompt tells the model it was cancelled, and the model's reply leaves it alone", async () => {
    const h = harness();
    const { engineSession } = await operatorAbortsAfterTurn(h);

    const next = await h.engine.run(runOpts({ prompt: "EARLIER reply", resumeSessionId: engineSession }));
    // The notice goes first, synthetic (opencode's TUI does not show it as
    // typed), quoting the request; the prompt itself follows, marked as Jinn's.
    const parts = (await lastPost(h)).body.parts as Array<{ type: string; text: string; synthetic?: boolean; metadata?: unknown }>;
    expect(parts).toHaveLength(2);
    expect(parts[0]).toMatchObject({ type: "text", synthetic: true, metadata: { jinn: "cancelled-requests" } });
    expect(parts[0]!.text).toContain("the user cancelled");
    expect(parts[0]!.text).toContain("> OPERATOR PERMWAIT");
    expect(parts[1]).toEqual({ type: "text", text: "EARLIER reply", metadata: { jinn: "prompt" } });
    // A model that heeds it (as the real one did in every live probe) answers
    // its own prompt: nothing of the aborted request is carried out, and no
    // permission is asked for, so none is granted.
    expect(next.error).toBeUndefined();
    expect(next.result).toBe("answer:EARLIER reply model=opencode-go/deepseek-v4.1-flash");
    expect(await permissionReplies(h)).toEqual([]);

    // Told once: the turn after that answered one has nothing to report.
    const third = await h.engine.run(runOpts({ prompt: "third", resumeSessionId: engineSession }));
    expect(third.result).toBe("answer:third model=opencode-go/deepseek-v4.1-flash");
    expect((await lastPost(h)).body.parts).toEqual([{ type: "text", text: "third", metadata: { jinn: "prompt" } }]);
  });

  it("no notice for a request that was not the operator's cancel — Jinn's own interrupted turn, or an operator prompt that was answered", async () => {
    const h = harness();
    const first = await h.engine.run(runOpts({ prompt: "first" }));
    // The operator's prompt, answered.
    await h.pool.promptAsync("sess-1", first.sessionId, "OPERATOR question");
    await waitFor(async () => (await api<Stored>(h.pool, "sess-1", `/session/${first.sessionId}/message`)).body.length === 4);
    await waitFor(async () => Object.keys((await api<Record<string, unknown>>(h.pool, "sess-1", "/session/status")).body).length === 0);
    // Jinn's own turn, interrupted by Jinn (a restart, a timeout, the chat's stop).
    const hung = h.engine.run(runOpts({ prompt: "HANG jinn", resumeSessionId: first.sessionId }));
    await waitFor(async () => Object.keys((await api<Record<string, unknown>>(h.pool, "sess-1", "/session/status")).body).length === 1);
    h.engine.kill("sess-1", "Interrupted: gateway restart");
    expect((await hung).error).toBe("Interrupted: gateway restart");
    const stored = (await api<Stored>(h.pool, "sess-1", `/session/${first.sessionId}/message`)).body;
    expect(stored.at(-1)!.info.error?.name).toBe("MessageAbortedError");

    const next = await h.engine.run(runOpts({ prompt: "after", resumeSessionId: first.sessionId }));
    expect(next.result).toBe("answer:after model=opencode-go/deepseek-v4.1-flash");
    expect((await lastPost(h)).body.parts).toEqual([{ type: "text", text: "after", metadata: { jinn: "prompt" } }]);
  });

  it("a Jinn prompt queued behind the operator's is dropped by the operator's abort; the turn says so, and the next one names only the operator's request", async () => {
    // Real opencode 1.18.32 does this too (gen139-evidence, probe `queued`):
    // the queued prompt stays in the history with no reply at all.
    const h = harness();
    const first = await h.engine.run(runOpts({ prompt: "first" }));
    await h.pool.promptAsync("sess-1", first.sessionId, "OPERATOR PERMWAIT");
    const stored = async () => (await api<Stored>(h.pool, "sess-1", `/session/${first.sessionId}/message`)).body;
    await waitFor(async () => (await stored()).length === 4); // its reply is running, blocked on the permission
    const queued = h.engine.run(runOpts({ prompt: "queued jinn", resumeSessionId: first.sessionId }));
    await waitFor(async () => (await stored()).length === 5);
    await new Promise((r) => setTimeout(r, 100)); // stored, and past the fake's pickup delay: queued
    await abortSession(h, first.sessionId);
    const dropped = await queued;
    // Not the operator's abort error, which belongs to the reply it ended (that
    // reply was running before the turn subscribed), and not a silent success either.
    expect(dropped.error).toBe("PromptNotRun: opencode went idle without running this turn's prompt (an abort in the session drops the prompts queued behind it)");

    await h.engine.run(runOpts({ prompt: "next", resumeSessionId: first.sessionId }));
    const parts = (await lastPost(h)).body.parts as Array<{ text: string; synthetic?: boolean }>;
    expect(parts).toHaveLength(2);
    expect(parts[0]!.text).toContain("> OPERATOR PERMWAIT");
    expect(parts[0]!.text).not.toContain("queued jinn");
  });

  it("an operator follow-up queued behind the aborted request is dropped by the same Esc, and the notice names both", async () => {
    // QA, reproduced on real 1.18.32 (4/4): the follow-up keeps no
    // reply, and without the notice the next turn's model carried it out.
    const h = harness();
    const first = await h.engine.run(runOpts({ prompt: "first" }));
    const stored = async () => (await api<Stored>(h.pool, "sess-1", `/session/${first.sessionId}/message`)).body;
    await h.pool.promptAsync("sess-1", first.sessionId, "OPERATOR PERMWAIT");
    await waitFor(async () => (await stored()).length === 4); // its reply is running, blocked on the permission
    await h.pool.promptAsync("sess-1", first.sessionId, "OPERATOR FOLLOWUP read");
    await waitFor(async () => (await stored()).length === 5);
    await new Promise((r) => setTimeout(r, 100)); // stored, and past the fake's pickup delay: queued
    await abortSession(h, first.sessionId);
    const afterAbort = await stored();
    expect(afterAbort.filter((m) => m.info.parentID === afterAbort[4]!.info.id)).toEqual([]); // dropped: no reply at all

    const next = await h.engine.run(runOpts({ prompt: "EARLIER reply", resumeSessionId: first.sessionId }));
    const parts = (await lastPost(h)).body.parts as Array<{ text: string; synthetic?: boolean }>;
    expect(parts[0]!.synthetic).toBe(true);
    expect(parts[0]!.text).toContain("> OPERATOR PERMWAIT");
    expect(parts[0]!.text).toContain("> OPERATOR FOLLOWUP read");
    expect(next.result).toBe("answer:EARLIER reply model=opencode-go/deepseek-v4.1-flash");
    expect(await permissionReplies(h)).toEqual([]);
  });

  it("a reply a killed server left unfinished, in an idle session, is not taken as running", async () => {
    // QA, real 1.18.32: SIGKILL mid-reply leaves the reply with no
    // completion and no error. Taken as someone else's running reply, it would
    // make this turn's own early error look foreign.
    const h = harness();
    const first = await h.engine.run(runOpts({ prompt: "first" }));
    await h.pool.promptAsync("sess-1", first.sessionId, "OPERATOR ORPHAN");
    await waitFor(async () => (await api<Stored>(h.pool, "sess-1", `/session/${first.sessionId}/message`)).body.length === 4
      && Object.keys((await api<Record<string, unknown>>(h.pool, "sess-1", "/session/status")).body).length === 0);
    // This turn's prompt fails before any reply of its own exists.
    const result = await h.engine.run(runOpts({ prompt: "FAILSTART jinn", resumeSessionId: first.sessionId }));
    expect(result.error).toBe("APIError: upstream exploded");
  });

  it("an error ending someone else's reply that was running before the turn subscribed is not the turn's", async () => {
    const h = harness();
    const first = await h.engine.run(runOpts({ prompt: "first" }));
    // The operator's reply is running (and will fail) when the Jinn turn subscribes.
    await h.pool.promptAsync("sess-1", first.sessionId, "OPERATOR SLOW FAIL");
    const stored = async () => (await api<Stored>(h.pool, "sess-1", `/session/${first.sessionId}/message`)).body;
    await waitFor(async () => (await stored()).length === 4);
    // Jinn's own reply ends with no text, so the error would be all it reported.
    const result = await h.engine.run(runOpts({ prompt: "TOOLONLY jinn", resumeSessionId: first.sessionId }));
    expect(result.error).toBe("opencode exited successfully without a final assistant response");
    expect(result.numTurns).toBe(2);
    // Only meaningful if the operator's reply failed while the turn listened:
    // the turn subscribes before it posts, so its post must precede that failure.
    const after = await stored();
    const operatorReply = after.find((m) => m.info.parentID === after.filter((u) => u.info.role === "user")[1]!.info.id)!;
    expect(operatorReply.info.error?.name).toBe("APIError");
    expect(((await lastPost(h)) as LogEntry & { at: number }).at).toBeLessThan(operatorReply.info.time!.completed!);
  });

  it("a turn with no reply to its prompt does not claim the prompt was dropped while the session still reads busy", async () => {
    // It may yet run (QA round 2 ): PromptNotRun is only for an idle session.
    const h = harness();
    const result = await h.engine.run(runOpts({ prompt: "GHOSTIDLE jinn" }));
    expect(result.error).toBe("opencode exited successfully without a final assistant response");
  });

  it("an interrupt while a resumed turn reads the history posts nothing", async () => {
    process.env.FAKE_OPENCODE_HISTORY_DELAY_MS = "800";
    const h = harness();
    const first = await h.engine.run(runOpts({ prompt: "first" }));
    const turn = h.engine.run(runOpts({ prompt: "never sent", resumeSessionId: first.sessionId }));
    await waitFor(async () => (await logOf(h)).some((e) => e.url.endsWith("/message?limit=100")));
    h.engine.kill("sess-1", "Interrupted: operator");
    expect((await turn).error).toBe("Interrupted: operator");
    await new Promise((r) => setTimeout(r, 1000));
    expect((await logOf(h)).filter((e) => e.url.endsWith("/prompt_async"))).toHaveLength(1);
  });

  it("an idle ending someone else's busy period before the turn has posted does not end the turn", async () => {
    // The turn subscribes, then reads the history; while it does, an operator
    // prompt runs start to finish, so the turn sees busy and then idle before
    // its own prompt is even sent.
    process.env.FAKE_OPENCODE_HISTORY_DELAY_MS = "800";
    const h = harness();
    const first = await h.engine.run(runOpts({ prompt: "first" }));
    const turn = h.engine.run(runOpts({ prompt: "jinn second", resumeSessionId: first.sessionId }));
    await waitFor(async () => (await logOf(h)).some((e) => e.url.endsWith("/message?limit=100")));
    await h.pool.promptAsync("sess-1", first.sessionId, "OPERATOR quick");
    const stored = async () => (await api<Stored>(h.pool, "sess-1", `/session/${first.sessionId}/message`)).body;
    await waitFor(async () => (await stored()).length === 4 && Object.keys((await api<Record<string, unknown>>(h.pool, "sess-1", "/session/status")).body).length === 0);
    expect((await logOf(h)).filter((e) => e.url.endsWith("/prompt_async"))).toHaveLength(2); // the operator's is the second; Jinn's is not sent yet
    const result = await turn;
    expect(result.error).toBeUndefined();
    expect(result.result).toBe("answer:jinn second model=opencode-go/deepseek-v4.1-flash");
  });

  it("a turn after an aborted operator prompt answers with its own reply, even when that reply takes up the aborted request", async () => {
    // A model that ignores that notice and reads /etc/hostname (a
    // permission) for the operator's aborted request instead of its own. Told,
    // not refused (the operator's call ): the turn still grants its
    // own reply's permission, and still reports its own reply's text.
    const h = harness();
    const { engineSession, operatorPrompt } = await operatorAbortsAfterTurn(h);
    const stored = async () => (await api<Stored>(h.pool, "sess-1", `/session/${engineSession}/message`)).body;

    const next = await h.engine.run(runOpts({ prompt: "EARLIER IGNORENOTICE reply", resumeSessionId: engineSession }));
    expect(next.error).toBeUndefined();
    expect(((await lastPost(h)).body.parts as Array<{ text: string }>)[0]!.text).toContain("> OPERATOR PERMWAIT");
    // Its own reply's text, though it answers the operator's request.
    expect(next.result).toBe("earlier:OPERATOR PERMWAIT");
    expect(next.numTurns).toBe(2);
    // Its own reply's permission was granted, once.
    expect(await permissionReplies(h)).toEqual([{ reply: "once" }]);
    // And every reply it reported names its own prompt.
    const after = await stored();
    const posted = (await logOf(h)).filter((e) => e.url.endsWith("/prompt_async")).at(-1)!.body.messageID;
    expect(after.find((m) => m.info.parentID === operatorPrompt)!.info.error?.name).toBe("MessageAbortedError");
    expect(after.filter((m) => m.info.parentID === posted)).toHaveLength(2);
  });

  describe("a Jinn turn the user stopped", () => {
    type StoredParts = Array<{ info: { id: string; role: string; parentID?: string; error?: { name: string } }; parts: Array<{ type: string; text?: string; metadata?: Record<string, unknown> }> }>;
    const storedOf = async (h: Harness, engineSession: string) => (await api<StoredParts>(h.pool, "sess-1", `/session/${engineSession}/message`)).body;
    const busy = async (h: Harness) => Object.keys((await api<Record<string, unknown>>(h.pool, "sess-1", "/session/status")).body).length > 0;

    /** A resumed turn that runs until it is interrupted, stopped with `reason`. */
    async function stopTurn(h: Harness, engineSession: string, prompt: string, reason: string, over: Partial<EngineRunOpts> = {}) {
      const turn = h.engine.run(runOpts({ prompt, resumeSessionId: engineSession, ...over }));
      await waitFor(() => busy(h));
      h.engine.kill("sess-1", reason);
      return turn;
    }

    it("is marked stopped by the user in opencode's store, and the next turn tells the model, which leaves it alone", async () => {
      // A slow mark: the stopped turn must not settle (and let the next turn
      // read the history) before the mark is in place.
      process.env.FAKE_OPENCODE_PATCH_DELAY_MS = "600";
      const h = harness();
      const first = await h.engine.run(runOpts({ prompt: "first" }));
      const stoppedTurn = await stopTurn(h, first.sessionId, "HANG run sleep 45", USER_STOP_INTERRUPTION_REASON);
      expect(stoppedTurn.error).toBe(USER_STOP_INTERRUPTION_REASON);
      // Marked on the prompt's own text part, before the stopped turn settled.
      const prompt = (await storedOf(h, first.sessionId)).filter((m) => m.info.role === "user").at(-1)!;
      expect(prompt.parts).toEqual([expect.objectContaining({ text: "HANG run sleep 45", metadata: { jinn: "prompt", stopped: "user", request: "HANG run sleep 45" } })]);

      const next = await h.engine.run(runOpts({ prompt: "EARLIER reply", resumeSessionId: first.sessionId }));
      const parts = (await lastPost(h)).body.parts as Array<{ type: string; text: string; synthetic?: boolean; metadata?: unknown }>;
      expect(parts).toHaveLength(2);
      expect(parts[0]).toMatchObject({ type: "text", synthetic: true, metadata: { jinn: "stopped-requests" } });
      expect(parts[0]!.text).toContain("the user stopped");
      expect(parts[0]!.text).toContain("> HANG run sleep 45");
      expect(parts[1]).toEqual({ type: "text", text: "EARLIER reply", metadata: { jinn: "prompt" } });
      // A model that heeds it answers its own prompt, and asks for no permission.
      expect(next.result).toBe("answer:EARLIER reply model=opencode-go/deepseek-v4.1-flash");
      expect(await permissionReplies(h)).toEqual([]);

      // Told once.
      await h.engine.run(runOpts({ prompt: "third", resumeSessionId: first.sessionId }));
      expect((await lastPost(h)).body.parts).toEqual([{ type: "text", text: "third", metadata: { jinn: "prompt" } }]);
    });

    it("a stop that is not the user's (a restart, a new message cutting in) is not marked or named, and is left to the model as before", async () => {
      const h = harness();
      const first = await h.engine.run(runOpts({ prompt: "first" }));
      for (const reason of ["Interrupted: gateway shutting down", USER_MESSAGE_INTERRUPTION_REASON]) {
        expect((await stopTurn(h, first.sessionId, `HANG ${reason}`, reason)).error).toBe(reason);
        const prompt = (await storedOf(h, first.sessionId)).filter((m) => m.info.role === "user").at(-1)!;
        expect(prompt.parts[0]!.metadata).toEqual({ jinn: "prompt" });
      }
      expect((await logOf(h)).some((e) => e.method === "PATCH")).toBe(false);
      // What found, still so for these: with nothing said, the model
      // takes the stopped request up, with its turn's permission granted.
      const next = await h.engine.run(runOpts({ prompt: "EARLIER reply", resumeSessionId: first.sessionId }));
      expect((await lastPost(h)).body.parts).toEqual([{ type: "text", text: "EARLIER reply", metadata: { jinn: "prompt" } }]);
      expect(next.result).toBe(`earlier:HANG ${USER_MESSAGE_INTERRUPTION_REASON}`);
      expect(await permissionReplies(h)).toEqual([{ reply: "once" }]);
    });

    it("a stopped first turn is quoted by its request, not by the system prompt it carried", async () => {
      const h = harness();
      const turn = h.engine.run(runOpts({ prompt: "HANG deploy the site", systemPrompt: "You are Senior Developer." }));
      await waitFor(() => busy(h));
      h.engine.kill("sess-1", USER_STOP_INTERRUPTION_REASON);
      const stoppedTurn = await turn;
      expect((await storedOf(h, stoppedTurn.sessionId))[0]!.parts[0]!.text).toContain("You are Senior Developer.");

      await h.engine.run(runOpts({ prompt: "next", resumeSessionId: stoppedTurn.sessionId }));
      const notice = ((await lastPost(h)).body.parts as Array<{ text: string }>)[0]!.text;
      expect(notice).toContain("> HANG deploy the site");
      expect(notice).not.toContain("Senior Developer");
    });

    it("a stopped prompt still queued behind the operator's is dropped by the stop, and both are named", async () => {
      const h = harness();
      const first = await h.engine.run(runOpts({ prompt: "first" }));
      await h.pool.promptAsync("sess-1", first.sessionId, "OPERATOR PERMWAIT");
      await waitFor(async () => (await storedOf(h, first.sessionId)).length === 4); // running, blocked on its permission
      const queued = h.engine.run(runOpts({ prompt: "queued jinn", resumeSessionId: first.sessionId }));
      await waitFor(async () => (await storedOf(h, first.sessionId)).length === 5);
      await new Promise((r) => setTimeout(r, 100)); // past the fake's pickup delay: queued
      h.engine.kill("sess-1", USER_STOP_INTERRUPTION_REASON);
      expect((await queued).error).toBe(USER_STOP_INTERRUPTION_REASON);
      const after = await storedOf(h, first.sessionId);
      expect(after.filter((m) => m.info.parentID === after[4]!.info.id)).toEqual([]); // dropped: no reply at all

      await h.engine.run(runOpts({ prompt: "next", resumeSessionId: first.sessionId }));
      const parts = (await lastPost(h)).body.parts as Array<{ text: string; metadata?: unknown }>;
      expect(parts.map((p) => p.metadata)).toEqual([{ jinn: "cancelled-requests" }, { jinn: "stopped-requests" }, { jinn: "prompt" }]);
      expect(parts[0]!.text).toContain("> OPERATOR PERMWAIT");
      expect(parts[1]!.text).toContain("> queued jinn");
    });

    it("QA: a stopped request is named once, even when the turn that named it is then cut short by a restart", async () => {
      const h = harness();
      const first = await h.engine.run(runOpts({ prompt: "first" }));
      await stopTurn(h, first.sessionId, "HANG stopped A", USER_STOP_INTERRUPTION_REASON);
      // The user's "continue" starts on A, and a restart cuts it short.
      expect((await stopTurn(h, first.sessionId, "HANG continue A", "Interrupted: gateway shutting down")).error).toBe("Interrupted: gateway shutting down");
      expect(((await lastPost(h)).body.parts as Array<{ text: string }>)[0]!.text).toContain("> HANG stopped A");
      // The resume after it is not told A was stopped all over again.
      await h.engine.run(runOpts({ prompt: "resume", resumeSessionId: first.sessionId }));
      expect((await lastPost(h)).body.parts).toEqual([{ type: "text", text: "resume", metadata: { jinn: "prompt" } }]);
    });

    it("a mark the server refuses costs the notice, not the stop", async () => {
      process.env.FAKE_OPENCODE_PATCH_FAIL = "1";
      const h = harness();
      const first = await h.engine.run(runOpts({ prompt: "first" }));
      expect((await stopTurn(h, first.sessionId, "HANG stop me", USER_STOP_INTERRUPTION_REASON)).error).toBe(USER_STOP_INTERRUPTION_REASON);
      expect((await logOf(h)).filter((e) => e.method === "PATCH")).toHaveLength(1);
      const next = await h.engine.run(runOpts({ prompt: "next", resumeSessionId: first.sessionId }));
      expect(next.result).toBe("answer:next model=opencode-go/deepseek-v4.1-flash");
      expect((await lastPost(h)).body.parts).toEqual([{ type: "text", text: "next", metadata: { jinn: "prompt" } }]);
    });

    it("a stop before the prompt was posted marks nothing", async () => {
      process.env.FAKE_OPENCODE_HISTORY_DELAY_MS = "800";
      const h = harness();
      const first = await h.engine.run(runOpts({ prompt: "first" }));
      const turn = h.engine.run(runOpts({ prompt: "never sent", resumeSessionId: first.sessionId }));
      await waitFor(async () => (await logOf(h)).some((e) => e.url.endsWith("/message?limit=100")));
      h.engine.kill("sess-1", USER_STOP_INTERRUPTION_REASON);
      expect((await turn).error).toBe(USER_STOP_INTERRUPTION_REASON);
      const log = await logOf(h);
      expect(log.filter((e) => e.url.endsWith("/prompt_async"))).toHaveLength(1);
      // Nothing to mark, so nothing is looked up either.
      expect(log.some((e) => /\/message\/msg_/.test(e.url))).toBe(false);
    });
  });

  describe("where a turn ends (its own reply done, else the session going idle)", () => {
    it("runs through several tool round trips to the answer, and keeps every step's accounting", async () => {
      const h = harness();
      const deltas: Array<{ type: string; content: string }> = [];
      const result = await h.engine.run(runOpts({ prompt: "MULTISTEP work", onStream: (d) => deltas.push(d) }));
      expect(result.error).toBeUndefined();
      expect(result.result).toBe("answer:MULTISTEP work model=opencode-go/deepseek-v4.1-flash");
      expect(result.numTurns).toBe(3);
      expect(result.cost).toBeCloseTo(0.002);
      expect(deltas.filter((d) => d.type === "tool_result").map((d) => d.content)).toEqual(["out-1", "out-2"]);
    });

    it("ends a turn whose last step is a tool call with no text, as `opencode run` reports it", async () => {
      const h = harness();
      const result = await h.engine.run(runOpts({ prompt: "TOOLONLY work" }));
      expect(result.error).toBe("opencode exited successfully without a final assistant response");
      expect(result.numTurns).toBe(2);
      expect(h.pool.unsupportedReason("local")).toBeUndefined();
    });

    it("falls back to the session going idle when the reply's completion never arrives", async () => {
      const h = harness();
      const result = await h.engine.run(runOpts({ prompt: "NOCOMPLETE work" }));
      expect(result.result).toBe("answer:NOCOMPLETE work model=opencode-go/deepseek-v4.1-flash");
      expect(h.pool.unsupportedReason("local")).toBeUndefined();
    });
  });

  it("a turn ends on an idle session.status alone, as `opencode run` does", async () => {
    const h = harness();
    const started = Date.now();
    const result = await h.engine.run(runOpts({ prompt: "STATUSIDLE end" }));
    expect(result.result).toBe("answer:STATUSIDLE end model=opencode-go/deepseek-v4.1-flash");
    expect(Date.now() - started).toBeLessThan(5_000);
    expect(h.pool.unsupportedReason("local")).toBeUndefined();
  });

  it("reports the server's session.error as the turn's error", async () => {
    const h = harness();
    const result = await h.engine.run(runOpts({ prompt: "FAIL now" }));
    expect(result.error).toBe("APIError: upstream exploded");
  });

  it("a resume id the server does not know fails as a dead session, so the next turn starts fresh", async () => {
    const { isDeadSessionError } = await import("../../shared/rateLimit.js");
    const h = harness();
    const result = await h.engine.run(runOpts({ resumeSessionId: "ses_gone" }));
    expect(result.error).toMatch(/Session not found: ses_gone/);
    expect(result.sessionId).toBe("ses_gone");
    expect(isDeadSessionError(result)).toBe(true);
  });

  it("falls back to a plain opencode run when the server will not start", async () => {
    process.env.FAKE_OPENCODE_SERVE_FAIL = "1";
    const { engine, pool } = harness({ startTimeoutMs: 3000 });
    const result = await engine.run(runOpts());
    expect(result.result).toBe("plain:build it");
    expect(pool.size()).toBe(0);
  });

  // opencode sends `server.connected` only once it has bootstrapped
  // the instance, which on a plugin's first use includes an npm install
  // (5.6–24.5 s measured). That used to land inside the first turn's own
  // connect budget and fail the turn with "the event stream did not connect".
  it("hands out a server only once its instance has bootstrapped, so a slow first bootstrap does not fail the turn", async () => {
    process.env.FAKE_OPENCODE_BOOTSTRAP_MS = "1500";
    SERVER_TURN_TIMING.connectMs = 500; // far shorter than the bootstrap
    const { engine, pool } = harness();
    const started = Date.now();
    const result = await engine.run(runOpts());
    expect(result.error).toBeUndefined();
    expect(result.result).toBe("answer:build it model=opencode-go/deepseek-v4.1-flash");
    expect(Date.now() - started).toBeGreaterThanOrEqual(1500);
    // On the server, not a fallback `run`.
    expect(pool.get("sess-1")?.ready).toBe(true);
  });

  it("gives up on a bootstrap that does not finish, and runs the turn as a plain opencode run", async () => {
    process.env.FAKE_OPENCODE_BOOTSTRAP_MS = "60000";
    const { engine, pool } = harness({ bootstrapTimeoutMs: 1000 });
    await expect(pool.acquire("sess-1", { cwd: JINN_HOME, bin: FAKE })).rejects.toThrow(
      /did not start: the instance did not bootstrap within 1000ms/,
    );
    expect(pool.size()).toBe(0);

    const result = await engine.run(runOpts());
    expect(result.result).toBe("plain:build it");
    expect(pool.size()).toBe(0);
  });

  it("an interrupt during the bootstrap ends the turn at once, and leaves the server starting for the next turn", async () => {
    process.env.FAKE_OPENCODE_BOOTSTRAP_MS = "3000";
    const h = harness();
    const turn = h.engine.run(runOpts());
    await waitFor(() => h.pool.size() === 1);
    await new Promise((r) => setTimeout(r, 200));
    const stoppedAt = Date.now();
    h.engine.kill("sess-1", "Interrupted: operator");
    const result = await turn;
    expect(Date.now() - stoppedAt).toBeLessThan(1000);
    expect(result.error).toBe("Interrupted: operator");
    expect(result.result).toBe("");

    // The start finishes on its own; the interrupted turn's hold is dropped and nothing was posted.
    await waitFor(() => h.pool.get("sess-1")?.ready === true);
    await waitFor(() => h.pool.holdCount("sess-1") === 0);
    const log = await logOf(h);
    expect(log.map((e) => `${e.method} ${e.url}`)).toEqual(["GET /global/health"]);

    // The next turn gets the warm server at once.
    const server = h.pool.get("sess-1");
    const next = await h.engine.run(runOpts());
    expect(next.error).toBeUndefined();
    expect(h.pool.get("sess-1")).toBe(server);
  });

  it("flipping back to run mode stops the warm servers before a plain run", async () => {
    const h = harness();
    await h.engine.run(runOpts());
    const server = h.pool.get("sess-1")!;
    h.setMode("run");
    const result = await h.engine.run(runOpts());
    expect(result.result).toBe("plain:build it");
    await waitFor(() => server.exited);
  });
});

describe("OpencodeEngine in server mode — /compact", { timeout: 20_000 }, () => {
  type LogEntry = { method: string; url: string; body: Record<string, unknown> };
  type Stored = { info: { role: string; summary?: boolean }; parts: Array<{ type: string; text?: string; synthetic?: boolean; metadata?: Record<string, unknown> }> };
  const logOf = async (h: Harness) => (await api<LogEntry[]>(h.pool, "sess-1", "/test/log")).body;

  it("runs opencode's own compaction, then re-seeds the Jinn system prompt it summarized away", async () => {
    const h = harness();
    const first = await h.engine.run(runOpts({ systemPrompt: "You are Ada." }));
    expect(first.error).toBeUndefined();

    const compacted = await h.engine.run(runOpts({
      prompt: "/compact Self-compaction requested by this session mid-task.",
      resumeSessionId: first.sessionId,
      systemPrompt: "You are Ada.",
    }));
    expect(compacted.error).toBeUndefined();
    // Nothing for the chat: the summary is not a reply.
    expect(compacted.result).toBe("");
    expect(compacted.sessionId).toBe(first.sessionId);
    expect(compacted.cost).toBeCloseTo(0.002);
    // The size it replaced is the last reply's context, not the summarizer's input.
    expect(compacted.compaction).toEqual({ preTokens: 21_800 });

    const log = (await logOf(h)).filter((e) => e.method === "POST");
    const route = `/session/${first.sessionId}`;
    // Not a prompt: the compaction endpoint, with the turn's model, and no auto-continue.
    expect(log.map((e) => e.url)).toEqual(["/session", `${route}/prompt_async`, `${route}/summarize`, `${route}/message`]);
    expect(log[2]!.body).toEqual({ providerID: "opencode-go", modelID: "deepseek-v4.1-flash", auto: false });
    expect(log[3]!.body).toMatchObject({
      noReply: true,
      model: { providerID: "opencode-go", modelID: "deepseek-v4.1-flash" },
      parts: [{ type: "text", synthetic: true, metadata: { jinn: "context-reseed" } }],
    });

    const stored = (await api<Stored[]>(h.pool, "sess-1", `${route}/message`)).body;
    const reseed = stored.at(-1)!;
    expect(reseed.info.role).toBe("user");
    expect(reseed.parts[0]!.text).toMatch(/^\[Jinn\] Your context was just compacted\./);
    expect(reseed.parts[0]!.text).toMatch(/You are Ada\.$/);
    expect(stored.some((m) => m.info.summary === true)).toBe(true);
  });

  it("does not report the re-seed as a request someone cancelled on the next turn", async () => {
    const h = harness();
    const first = await h.engine.run(runOpts({ systemPrompt: "You are Ada." }));
    await h.engine.run(runOpts({ prompt: "/compact", resumeSessionId: first.sessionId, systemPrompt: "You are Ada." }));
    // An abort after the re-seed is what would make an unanswered, non-Jinn
    // message read as dropped by it (the cancellation walk): Jinn cuts a turn short.
    const hung = h.engine.run(runOpts({ prompt: "HANG", resumeSessionId: first.sessionId }));
    await waitFor(async () => (await logOf(h)).filter((e) => e.url.endsWith("/prompt_async")).length === 2);
    await new Promise((r) => setTimeout(r, 100)); // picked up: running, so the abort lands
    h.engine.kill("sess-1", USER_MESSAGE_INTERRUPTION_REASON);
    await hung;
    const next = await h.engine.run(runOpts({ prompt: "resume from the handoff", resumeSessionId: first.sessionId }));
    expect(next.error).toBeUndefined();
    const posted = (await logOf(h)).filter((e) => e.url.endsWith("/prompt_async")).at(-1)!;
    const parts = posted.body.parts as Array<{ synthetic?: boolean }>;
    // Only the prompt itself: no cancelled/stopped-request notice was composed.
    expect(parts.filter((p) => p.synthetic)).toEqual([]);
  });

  it("takes the session's own model when the turn names none", async () => {
    const h = harness();
    const first = await h.engine.run(runOpts());
    // The fake records a prompt's model on the user message only when it is posted
    // with noReply; seed one the way a real session has it.
    await fetch(`${h.pool.get("sess-1")!.apiUrl}/session/${first.sessionId}/message`, {
      method: "POST",
      headers: { authorization: basicAuthHeader(h.pool.get("sess-1")!.password), "content-type": "application/json" },
      body: JSON.stringify({ noReply: true, model: { providerID: "p", modelID: "m" }, parts: [{ type: "text", text: "x" }] }),
    });
    const compacted = await h.engine.run(runOpts({ prompt: "/compact", resumeSessionId: first.sessionId, model: undefined }));
    expect(compacted.error).toBeUndefined();
    const summarize = (await logOf(h)).find((e) => e.url.endsWith("/summarize"))!;
    expect(summarize.body).toEqual({ providerID: "p", modelID: "m", auto: false });
  });

  it("has nothing to do in a session that has not run yet", async () => {
    const h = harness();
    const compacted = await h.engine.run(runOpts({ prompt: "/compact" }));
    expect(compacted).toMatchObject({ result: "", sessionId: "" });
    expect(compacted.error).toBeUndefined();
  });

  it("an interrupt stops the compaction on the server, not only the request", async () => {
    process.env.FAKE_OPENCODE_SUMMARIZE_DELAY_MS = "10000";
    const h = harness();
    const first = await h.engine.run(runOpts());
    const turn = h.engine.run(runOpts({ prompt: "/compact", resumeSessionId: first.sessionId }));
    await waitFor(async () => (await logOf(h)).some((e) => e.url.endsWith("/summarize")));
    expect(h.engine.isAlive("sess-1")).toBe(true);
    h.engine.kill("sess-1", USER_STOP_INTERRUPTION_REASON);
    const result = await turn;
    expect(result.error).toBe(USER_STOP_INTERRUPTION_REASON);
    await waitFor(async () => (await logOf(h)).some((e) => e.url === `/session/${first.sessionId}/abort`));
    // No re-seed after a compaction that did not finish.
    expect((await logOf(h)).some((e) => e.method === "POST" && e.url.endsWith("/message"))).toBe(false);
  });

  it("leaves `run` mode alone: /compact there is ordinary text for the model", async () => {
    const h = harness();
    h.setMode("run");
    const plain = await h.engine.run(runOpts({ prompt: "/compact" }));
    expect(plain.result).toBe("plain:/compact");
  });
});

describe("coupling to the server API: a version pin, and drift degrades to run", { timeout: 20_000 }, () => {
  const serveLog = () => path.join(JINN_HOME, "serve-starts.log");
  const starts = () => (fs.existsSync(serveLog()) ? fs.readFileSync(serveLog(), "utf8").trim().split("\n").filter(Boolean).length : 0);

  it("compares versions numerically and pins the minimum", () => {
    expect(MIN_OPENCODE_SERVER_VERSION).toBe("1.18.31");
    expect(compareVersions("1.18.31", "1.18.31")).toBe(0);
    expect(compareVersions("1.18.4", "1.18.31")).toBeLessThan(0);
    expect(compareVersions("1.19.0", "1.18.31")).toBeGreaterThan(0);
    expect(compareVersions("v2.0.0-beta.1", "1.18.31")).toBeGreaterThan(0);
    expect(unsupportedVersionReason("1.18.31")).toBeUndefined();
    expect(unsupportedVersionReason("1.17.9")).toMatch(/older than 1\.18\.31/);
    expect(unsupportedVersionReason(undefined)).toMatch(/did not report its version/);
  });

  it("refuses a server older than the pin: the turn runs plain, and the host stays on run without restarting servers", async () => {
    process.env.FAKE_OPENCODE_VERSION = "1.17.0";
    process.env.FAKE_OPENCODE_SERVE_LOG = serveLog();
    const h = harness();
    expect((await h.engine.run(runOpts())).result).toBe("plain:build it");
    expect(h.pool.unsupportedReason("local")).toMatch(/1\.17\.0 is older than 1\.18\.31/);
    expect((await h.engine.run(runOpts())).result).toBe("plain:build it");
    expect(starts()).toBe(1);
    expect(h.pool.size()).toBe(0);
  });

  it("refuses a server that does not report its version", async () => {
    process.env.FAKE_OPENCODE_VERSION = "none";
    const h = harness();
    expect((await h.engine.run(runOpts())).result).toBe("plain:build it");
    expect(h.pool.unsupportedReason("local")).toMatch(/did not report its version/);
  });

  it("recovers an answer the stream never delivered from the server's store, and takes the host off server mode", async () => {
    const h = harness();
    const drifted = await h.engine.run(runOpts({ prompt: "DRIFT shape" }));
    // Not lost: the answer comes back from the stored message.
    expect(drifted.error).toBeUndefined();
    expect(drifted.result).toBe("answer:DRIFT shape model=opencode-go/deepseek-v4.1-flash");
    expect(drifted.numTurns).toBe(1);
    expect(h.pool.unsupportedReason("local")).toMatch(/never arrived on the event stream/);
    expect(h.pool.size()).toBe(0);
    // And the next turn resumes the same session as a plain run.
    const next = await h.engine.run(runOpts({ resumeSessionId: drifted.sessionId }));
    expect(next.result).toBe("plain:build it");
  });

  it("notices a turn whose end never reaches the stream, and degrades the host too", async () => {
    SERVER_TURN_TIMING.statusPollMs = 100;
    const h = harness();
    const result = await h.engine.run(runOpts({ prompt: "NOIDLE please" }));
    expect(result.result).toBe("answer:NOIDLE please model=opencode-go/deepseek-v4.1-flash");
    expect(h.pool.unsupportedReason("local")).toMatch(/ended without the stream saying so/);
  });

  it("a turn that legitimately answers nothing is not mistaken for drift", async () => {
    const h = harness();
    // FAIL ends with an error on the stream: answered, so no recovery and no drift.
    await h.engine.run(runOpts({ prompt: "FAIL now" }));
    expect(h.pool.unsupportedReason("local")).toBeUndefined();
  });
});

describe("OpencodeInteractiveEngine", { timeout: 20_000 }, () => {
  function view(h: Harness, mode: () => OpencodeMode = () => "server") {
    return new OpencodeInteractiveEngine(h.engine, h.pool, { mode, bin: () => FAKE, resolveMcp: () => MCP_A });
  }

  function watch(v: OpencodeInteractiveEngine, id = "sess-1") {
    const out: string[] = [];
    const controls: PtyControlEvent[] = [];
    const sub = v.subscribeWithSnapshot(id, (d) => out.push(d.toString()), (e) => controls.push(e));
    sub.start();
    return { out, controls, sub };
  }

  it("refuses in run mode instead of starting anything", async () => {
    const h = harness();
    const v = view(h, () => "run");
    const w = watch(v);
    v.ensureIdleSpawn("sess-1", { cwd: JINN_HOME, cols: 100, rows: 30 });
    expect(w.controls).toContainEqual({ type: "error", message: OPENCODE_VIEW_NEEDS_SERVER_MODE, recoverable: true });
    expect(h.pool.size()).toBe(0);
    expect(v.hasWarmPty("sess-1")).toBe(false);
    w.sub.unsubscribe();
  });

  it("attaches opencode's TUI to the session's server, on the session, with the password in its env", async () => {
    const h = harness();
    const first = await h.engine.run(runOpts({ resolvedMcp: MCP_A }));
    const server = h.pool.get("sess-1")!;
    const v = view(h);
    const w = watch(v);
    v.ensureIdleSpawn("sess-1", { cwd: JINN_HOME, engineSessionId: first.sessionId, cols: 100, rows: 30 });
    await waitFor(() => v.hasWarmPty("sess-1"));
    // The terminal's content reaches a subscriber as live bytes or, once the
    // stream has settled, inside a snapshot — either way it is on screen.
    const screen = () => w.out.join("") + JSON.stringify(w.controls);
    await waitFor(() => screen().includes("ATTACHED"));
    expect(screen()).toContain(`ATTACHED ${first.sessionId} pw=yes`);
    // Same server: the view reused it rather than starting its own.
    expect(h.pool.get("sess-1")).toBe(server);
    expect(h.pool.holdCount("sess-1")).toBe(1);

    // Composer text goes to the server's API, into the same opencode session.
    v.writeStdin("sess-1", "hello from the dashboard");
    await waitFor(async () => {
      const log = (await api<Array<{ url: string; body: { parts?: Array<{ text: string }> } }>>(h.pool, "sess-1", "/test/log")).body;
      return log.some((e) => e.url === `/session/${first.sessionId}/prompt_async` && e.body.parts?.[0]?.text === "hello from the dashboard");
    });

    v.killAll();
    expect(v.hasWarmPty("sess-1")).toBe(false);
    expect(h.pool.holdCount("sess-1")).toBe(0);
    w.sub.unsubscribe();
  });

  it("starts the session's server itself when none is running, with the turn's MCP set", async () => {
    const h = harness();
    const v = view(h);
    const w = watch(v);
    v.ensureIdleSpawn("sess-1", { cwd: JINN_HOME, cols: 100, rows: 30 });
    await waitFor(() => v.hasWarmPty("sess-1"));
    const server = h.pool.get("sess-1")!;
    // The next turn wants exactly this server, so it keeps it.
    await h.engine.run(runOpts({ resolvedMcp: MCP_A }));
    expect(h.pool.get("sess-1")).toBe(server);
    v.killAll();
    w.sub.unsubscribe();
  });

  it("holds composer text while a Jinn turn runs in the session, and sends it when the turn ends", async () => {
    const h = harness();
    const first = await h.engine.run(runOpts({ resolvedMcp: MCP_A }));
    const v = view(h);
    const w = watch(v);
    v.ensureIdleSpawn("sess-1", { cwd: JINN_HOME, engineSessionId: first.sessionId, cols: 100, rows: 30 });
    await waitFor(() => v.hasWarmPty("sess-1"));
    const typed = async () => (await api<Array<{ url: string; body: { parts?: Array<{ text: string }> } }>>(h.pool, "sess-1", "/test/log")).body
      .filter((e) => e.url.endsWith("/prompt_async") && e.body.parts?.[0]?.text === "typed mid-turn");
    const turn = h.engine.run(runOpts({ resolvedMcp: MCP_A, resumeSessionId: first.sessionId, prompt: "SLOW jinn" }));
    await waitFor(() => h.engine.isAlive("sess-1"));
    v.writeStdin("sess-1", "typed mid-turn");
    expect(w.controls).toContainEqual({ type: "error", message: HELD_FOR_TURN_NOTICE, recoverable: true });
    expect(await typed()).toHaveLength(0);
    const result = await turn;
    expect(result.result).toBe("answer:SLOW jinn model=opencode-go/deepseek-v4.1-flash");
    await waitFor(async () => (await typed()).length === 1);
    v.killAll();
    w.sub.unsubscribe();
  });

  // a new chat's terminal, opened while the first turn is starting,
  // must attach on the turn's opencode session. A bare client sits on
  // opencode's home screen, and POST /tui/select-session cannot rescue it: the
  // real TUI drops a select that arrives before it has connected (~3 s).
  it("a view opened while a new chat's first turn starts waits for the turn's opencode session and attaches on it", async () => {
    process.env.FAKE_OPENCODE_CREATE_DELAY_MS = "400";
    const h = harness();
    const v = view(h);
    const w = watch(v);
    const turn = h.engine.run(runOpts({ resolvedMcp: MCP_A, prompt: "SLOW first" }));
    // The dashboard opens the terminal as the chat starts: no opencode session yet.
    v.ensureIdleSpawn("sess-1", { cwd: JINN_HOME, cols: 100, rows: 30 });
    await waitFor(() => h.pool.get("sess-1") !== undefined);
    expect(v.hasWarmPty("sess-1")).toBe(false); // server up, session not yet created: waiting
    await waitFor(() => v.hasWarmPty("sess-1"));
    const result = await turn;
    const screen = () => w.out.join("") + JSON.stringify(w.controls);
    await waitFor(() => screen().includes("ATTACHED"));
    expect(screen()).toContain(`ATTACHED ${result.sessionId} pw=yes`);
    expect(screen()).not.toContain("ATTACHED none");
    expect(v.livePids()).toHaveLength(1);
    const log = (await api<Array<{ url: string }>>(h.pool, "sess-1", "/test/log")).body;
    expect(log.some((e) => e.url === "/tui/select-session")).toBe(false);
    v.killAll();
    expect(h.pool.holdCount("sess-1")).toBe(0);
    w.sub.unsubscribe();
  });

  it("a server stopped while the view waits is not attached to; the view follows the successor a turn starts, leaving its holds alone", async () => {
    process.env.FAKE_OPENCODE_CREATE_DELAY_MS = "800";
    const h = harness();
    const v = view(h);
    const w = watch(v);
    const first = h.engine.run(runOpts({ resolvedMcp: MCP_A, prompt: "SLOW first" }));
    v.ensureIdleSpawn("sess-1", { cwd: JINN_HOME, cols: 100, rows: 30 });
    await waitFor(() => h.pool.get("sess-1") !== undefined);
    const stopped = h.pool.get("sess-1")!;
    await h.pool.stop("sess-1"); // while the view waits for the first session
    await first;
    // The view starts no server of its own.
    await new Promise((r) => setTimeout(r, 500));
    expect(h.pool.size()).toBe(0);
    expect(v.hasWarmPty("sess-1")).toBe(false);
    // The next turn's server is the one it follows.
    const second = h.engine.run(runOpts({ resolvedMcp: MCP_A, prompt: "SLOW second" }));
    await waitFor(() => v.hasWarmPty("sess-1") && h.pool.holdCount("sess-1") === 2);
    expect(h.pool.get("sess-1")).not.toBe(stopped);
    // Closing the view mid-turn gives back the view's hold only: the turn keeps its own.
    v.killAll();
    expect(h.pool.holdCount("sess-1")).toBe(1);
    expect((await second).result).toBe("answer:SLOW second model=opencode-go/deepseek-v4.1-flash");
    expect(h.pool.holdCount("sess-1")).toBe(0);
    w.sub.unsubscribe();
  });

  it("a gateway shutdown while the view waits for the first session leaves no server behind", async () => {
    process.env.FAKE_OPENCODE_CREATE_DELAY_MS = "3000";
    const serveLog = path.join(JINN_HOME, `gen137-serve-${process.pid}.log`);
    fs.rmSync(serveLog, { force: true });
    process.env.FAKE_OPENCODE_SERVE_LOG = serveLog;
    const starts = () => (fs.existsSync(serveLog) ? fs.readFileSync(serveLog, "utf8").trim().split("\n").filter(Boolean).length : 0);
    try {
      const h = harness();
      const v = view(h);
      const w = watch(v);
      const turn = h.engine.run(runOpts({ resolvedMcp: MCP_A, prompt: "SLOW first" }));
      v.ensureIdleSpawn("sess-1", { cwd: JINN_HOME, cols: 100, rows: 30 });
      await waitFor(() => h.pool.get("sess-1") !== undefined);
      // The gateway's shutdown order: turns, views, then servers; sockets go last.
      h.engine.killAll();
      v.killAll();
      void h.pool.stopAll();
      await turn;
      await new Promise((r) => setTimeout(r, 2500));
      expect(starts()).toBe(1);
      expect(h.pool.size()).toBe(0);
      expect(v.hasWarmPty("sess-1")).toBe(false);
      w.sub.unsubscribe();
    } finally {
      fs.rmSync(serveLog, { force: true });
    }
  });

  it("a view already showing no session is re-attached on the session a turn then names", async () => {
    const h = harness();
    const v = view(h);
    const w = watch(v);
    v.ensureIdleSpawn("sess-1", { cwd: JINN_HOME, cols: 100, rows: 30 });
    await waitFor(() => v.hasWarmPty("sess-1"));
    const screen = () => w.out.join("") + JSON.stringify(w.controls);
    await waitFor(() => screen().includes("ATTACHED none"));
    const [bare] = v.livePids();
    const turn = await h.engine.run(runOpts({ resolvedMcp: MCP_A }));
    await waitFor(() => screen().includes(`ATTACHED ${turn.sessionId} pw=yes`));
    expect(w.controls).toContainEqual({ type: "restoring" });
    // One client, the new one; the view still holds the server exactly once.
    expect(v.livePids()).toHaveLength(1);
    expect(v.livePids()[0]).not.toBe(bare);
    expect(v.hasWarmPty("sess-1")).toBe(true);
    expect(h.pool.holdCount("sess-1")).toBe(1);
    // A later turn on the same session leaves the client alone.
    const pid = v.livePids()[0];
    await h.engine.run(runOpts({ resolvedMcp: MCP_A, resumeSessionId: turn.sessionId }));
    expect(v.livePids()).toEqual([pid]);
    v.killAll();
    expect(h.pool.holdCount("sess-1")).toBe(0);
    w.sub.unsubscribe();
  });
});
