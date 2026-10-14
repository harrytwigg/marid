import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { EngineResult, EngineRunOpts, StreamDelta } from "../../shared/types.js";
import { USER_STOP_INTERRUPTION_REASON } from "../../sessions/interruption-reasons.js";
import { OpencodeEngine } from "../opencode.js";
import { OpencodeServerPool } from "../opencode-server.js";
import { PtyLifecycleManager } from "../pty-lifecycle.js";

/**
 * e2e: Jinn's server mode against a real OpenCode 2 server (`/api/*`), with a
 * mock OpenAI-compatible provider. One Jinn session, several turns: an
 * answer, a resume, a tool call, an MCP tool call, a model switch, a stop and
 * what the next turn is told about it, and a compaction with its re-seed. Then
 * the host plugins: a rate limit falls back to a second provider, and a
 * pre-stream 400 is retried in place.
 *
 * Skipped unless OPENCODE2_E2E=1:
 *
 *   OPENCODE2_E2E=1 OPENCODE2_BIN=/path/to/opencode-2.x \
 *   pnpm exec vitest run src/engines/__tests__/opencode-v2-e2e.test.ts
 */

const RUN = process.env.OPENCODE2_E2E === "1";
const BIN = process.env.OPENCODE2_BIN ?? "opencode";
const MOCK = path.join(path.dirname(new URL(import.meta.url).pathname), "opencode-v2-mock-upstream.mjs");
const MCP_STUB = path.join(path.dirname(new URL(import.meta.url).pathname), "opencode-v2-mcp-stub.mjs");
/** The host plugins the OpenCode 2 upgrade guide installs. */
const PLUGINS = path.resolve(path.dirname(new URL(import.meta.url).pathname), "../../../../../examples/opencode-plugins");

function canConnect(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const s = net.connect({ port, host: "127.0.0.1" }, () => { s.destroy(); resolve(true); });
    s.on("error", () => resolve(false));
  });
}

function writeJson(file: string, value: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(value, null, 2));
}

interface MockRequest { url: string; model: string; hasTools: boolean; tools: string[]; lastUser: string; all: string }

describe.skipIf(!RUN)("opencode server mode on OpenCode 2", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "opencode-v2-e2e-"));
  const port = 9400 + Math.floor(Math.random() * 400);
  const mockLog = path.join(home, "mock.jsonl");
  const sessionId = `opencode-v2-e2e-${Date.now()}`;
  const saved = { HOME: process.env.HOME, XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME, XDG_DATA_HOME: process.env.XDG_DATA_HOME };
  let mock: ChildProcess;
  let pool: OpencodeServerPool;
  let engine: OpencodeEngine;
  let resume = "";

  const requests = (): MockRequest[] =>
    fs.readFileSync(mockLog, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l) as MockRequest);
  const mainRequests = () => requests().filter((r) => r.hasTools);
  const turn = async (prompt: string, extra: Partial<EngineRunOpts> = {}): Promise<{ result: EngineResult; deltas: StreamDelta[] }> => {
    const deltas: StreamDelta[] = [];
    const result = await engine.run({
      prompt,
      cwd: path.join(home, "work"),
      sessionId,
      bin: BIN,
      model: "mock/m1",
      systemPrompt: "SYSTEM_PROMPT_MARKER",
      ...(resume ? { resumeSessionId: resume } : {}),
      onStream: (d) => deltas.push(d),
      ...extra,
    });
    if (result.sessionId) resume = result.sessionId;
    return { result, deltas };
  };

  beforeAll(async () => {
    const models = { m1: { name: "M1", limit: { context: 100000, output: 8000 } }, m2: { name: "M2", limit: { context: 100000, output: 8000 } } };
    const provider = (prefix: string) => ({ npm: "@ai-sdk/openai-compatible", options: { baseURL: `http://127.0.0.1:${port}/${prefix}`, apiKey: "dummy" }, models });
    writeJson(path.join(home, ".config", "opencode", "opencode.json"), {
      model: "mock/m1",
      // The provider id the error-retry plugin watches, and a second provider
      // for the fallback plugin; the mock rate-limits `/primary/`.
      provider: { mock: provider("v1"), "opencode-go": provider("primary/v1"), backup: provider("backup/v1") },
    });
    for (const plugin of ["error-retry.js", "model-fallback.js"]) {
      fs.mkdirSync(path.join(home, ".config", "opencode", "plugin"), { recursive: true });
      fs.copyFileSync(path.join(PLUGINS, plugin), path.join(home, ".config", "opencode", "plugin", plugin));
    }
    writeJson(path.join(home, ".opencode", "rate-limit-fallback.json"), {
      fallbackMode: "stop",
      cooldownMs: 300_000,
      fallbackModels: [{ providerID: "backup", modelID: "m1" }],
      retryPolicy: { maxRetries: 2, strategy: "exponential", baseDelayMs: 200 },
      circuitBreaker: { enabled: true, failureThreshold: 3, recoveryTimeoutMs: 300_000 },
    });
    fs.mkdirSync(path.join(home, "work"), { recursive: true });
    fs.writeFileSync(mockLog, "");
    mock = spawn(process.execPath, [MOCK], { env: { ...process.env, MOCK_PORT: String(port), MOCK_LOG: mockLog, MOCK_LIMITED: "primary" }, stdio: "ignore" });
    process.env.HOME = home;
    process.env.XDG_CONFIG_HOME = path.join(home, ".config");
    process.env.XDG_DATA_HOME = path.join(home, ".local", "share");
    const lifecycle = new PtyLifecycleManager({ maxLivePtys: 8, enforceLocalCap: false });
    pool = new OpencodeServerPool(lifecycle, { bin: () => BIN, limits: () => ({ startTimeoutMs: 120_000 }) });
    engine = new OpencodeEngine({ mode: () => "server", servers: pool });
    for (let i = 0; i < 50 && !(await canConnect(port)); i++) await new Promise((r) => setTimeout(r, 100));
  }, 30_000);

  afterAll(async () => {
    engine?.killAll();
    await pool?.stopAll();
    mock?.kill("SIGKILL");
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  it("answers a first turn on a v2 server, with the system prompt in front", async () => {
    const { result } = await turn("say hello");
    expect(result.error).toBeUndefined();
    expect(result.result).toBe("hello from mock");
    expect(result.sessionId).toMatch(/^ses_/);
    expect(result.numTurns).toBe(1);
    expect(pool.get(sessionId)?.api).toBe(2);
    expect(mainRequests().at(-1)!.all).toContain("SYSTEM_PROMPT_MARKER");
  }, 180_000);

  it("resumes the session and reports a tool call", async () => {
    const first = resume;
    const { result, deltas } = await turn("run it TOOLCALL");
    expect(result.error).toBeUndefined();
    expect(result.sessionId).toBe(first);
    expect(result.result).toBe("tool done");
    expect(result.numTurns).toBe(2);
    expect(deltas.some((d) => d.type === "tool_use" && d.toolName === "shell")).toBe(true);
    expect(deltas.some((d) => d.type === "tool_result" && d.content.includes("hi-from-tool"))).toBe(true);
  }, 60_000);

  it("offers the session's MCP tools as tools, not behind code mode, and runs one", async () => {
    const resolvedMcp = { mcpServers: { jinn: { command: process.execPath, args: [MCP_STUB], env: { STUB_MARK: "staged-env" } } } };
    const { result, deltas } = await turn("call it MCPCALL", { resolvedMcp });
    expect(mainRequests().at(-1)!.tools).toContain("jinn_echo");
    expect(result.error).toBeUndefined();
    expect(result.result).toBe("tool done");
    expect(deltas.some((d) => d.type === "tool_result" && d.toolName === "jinn_echo" && d.content.includes("ECHO:staged-env"))).toBe(true);
  }, 120_000);

  it("keeps its answer when the operator steers a message in while its tool runs", async () => {
    const args = Buffer.from(JSON.stringify({ command: "sleep 3", description: "wait" })).toString("base64");
    const running = turn(`wait CALLTOOL=shell ARGS64=${args}`);
    await new Promise((r) => setTimeout(r, 1500));
    // As the terminal sends it: no delivery, which 2.x takes as a steer.
    const server = pool.get(sessionId)!;
    const res = await fetch(`${server.apiUrl}/api/session/${resume}/prompt`, {
      method: "POST",
      headers: { authorization: `Basic ${Buffer.from(`opencode:${server.password}`).toString("base64")}`, "content-type": "application/json" },
      body: JSON.stringify({ text: "operator aside" }),
    });
    expect(res.ok).toBe(true);
    const { result } = await running;
    expect(result.error).toBeUndefined();
    expect(result.result).not.toBe("");
  }, 60_000);

  it("switches the session's model when a turn names another", async () => {
    const { result } = await turn("which model", { model: "mock/m2" });
    expect(result.error).toBeUndefined();
    expect(mainRequests().at(-1)!.model).toBe("m2");
  }, 60_000);

  it("stops a turn, and tells the next turn the user stopped it", async () => {
    const running = turn("go SLOW");
    await new Promise((r) => setTimeout(r, 2500));
    engine.kill(sessionId, USER_STOP_INTERRUPTION_REASON);
    const { result } = await running;
    expect(result.error).toBe(USER_STOP_INTERRUPTION_REASON);
    expect(engine.isAlive(sessionId)).toBe(false);
    const next = await turn("after the stop");
    expect(next.result.error).toBeUndefined();
    expect(mainRequests().at(-1)!.all).toContain("the user stopped the request(s) below");
    expect(mainRequests().at(-1)!.all).toContain("go SLOW");
  }, 60_000);

  it("compacts the session and re-seeds the system prompt for the next turn", async () => {
    const { result } = await turn("/compact");
    expect(result.error).toBeUndefined();
    expect(result.compaction?.preTokens).toBeGreaterThan(0);
    const next = await turn("after compaction");
    expect(next.result.error).toBeUndefined();
    const all = mainRequests().at(-1)!.all;
    expect(all).toContain("Mock objective");
    expect(all).toContain("Your context was just compacted");
    expect(all).toContain("SYSTEM_PROMPT_MARKER");
  }, 120_000);

  it("falls back to the second provider on a rate limit (fallback plugin), within the turn", async () => {
    const { result } = await turn("limited E429", { model: "opencode-go/m1" });
    expect(result.error).toBeUndefined();
    expect(result.result).toBe("hello from mock");
    const urls = mainRequests().slice(-2).map((r) => r.url);
    expect(urls[0]).toMatch(/^\/primary\//);
    expect(urls[1]).toMatch(/^\/backup\//);
  }, 120_000);

  it("retries a pre-stream 400 in place (error-retry plugin), so the turn answers", async () => {
    const { result } = await turn("once E400ONCE", { model: "opencode-go/m2" });
    expect(result.error).toBeUndefined();
    expect(result.result).toBe("hello from mock");
    const last = mainRequests().slice(-2);
    expect(last.map((r) => r.url.split("/")[1])).toEqual(["primary", "primary"]);
  }, 120_000);
});
