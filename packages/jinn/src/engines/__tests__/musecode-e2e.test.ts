import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { EngineRunOpts, StreamDelta } from "../../shared/types.js";
import { MusecodeEngine } from "../musecode.js";
import { uuidv7 } from "../musecode-msp.js";
import { MspProcess } from "../musecode-process.js";
import { answerMuseServerRequest } from "../musecode-approvals.js";
import { MuseTurn } from "../musecode-turn.js";
import { buildMuseServeArgs } from "../musecode-protocol.js";
import { buildEngineChildEnv } from "../../shared/child-env.js";
import { detectRateLimit, isDeadSessionError } from "../../shared/rateLimit.js";

/**
 * The adapter against the REAL Muse Code binary. Off unless asked for:
 *
 *   MUSECODE_E2E=1 MUSECODE_BIN=/path/to/muse vitest run src/engines/__tests__/musecode-e2e.test.ts
 *
 * Nothing here needs an account. The happy path runs on `--provider echo`, a
 * deterministic built-in provider with no network and no key. The usage-limit
 * and retry cases run against a mock Meta provider (fixtures/musecode-mock-provider.mjs)
 * the binary is pointed at with `endpoint_transport.base_url`. Every process
 * gets a scratch HOME, so no real Muse state or login is read or written.
 */

const ENABLED = process.env.MUSECODE_E2E === "1" && !!process.env.MUSECODE_BIN;
const BIN = process.env.MUSECODE_BIN ?? "";
const FIXTURES = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures");

const ECHO = ["--provider", "echo", "-c", "run.reminder_roster=[]"];

let scratch: string;
let workspace: string;
let engine: MusecodeEngine;
let streamed: StreamDelta[];
let mock: ChildProcess | undefined;

function opts(over: Partial<EngineRunOpts> = {}): EngineRunOpts {
  return { prompt: "hello serve", cwd: workspace, bin: BIN, sessionId: "e2e-1", cliFlags: ECHO, onStream: (d) => streamed.push(d), ...over };
}

async function startMock(mode: string, env: Record<string, string> = {}): Promise<{ port: number; log: string }> {
  const log = path.join(scratch, `mock-${mode}.log`);
  mock = spawn(process.execPath, [path.join(FIXTURES, "musecode-mock-provider.mjs"), "0", log, path.join(FIXTURES, "musecode-catalog.json"), mode], {
    stdio: ["ignore", "pipe", "inherit"],
    env: { ...process.env, ...env },
  });
  const port = await new Promise<number>((resolve, reject) => {
    mock!.once("error", reject);
    mock!.stdout!.once("data", (d: Buffer) => resolve(Number(String(d).trim().split(" ")[1])));
  });
  return { port, log };
}

/** Flags that point the binary at the mock provider, with no reminder agents making extra calls. */
const mockFlags = (port: number) => [
  "--model", "muse-spark-1.2",
  "-c", `endpoint_transport.base_url="http://127.0.0.1:${port}"`,
  "-c", "run.reminder_roster=[]",
];

describe.skipIf(!ENABLED)("Muse Code (real binary)", () => {
  beforeAll(() => {
    scratch = fs.mkdtempSync(path.join(os.tmpdir(), "musecode-e2e-"));
    workspace = path.join(scratch, "ws");
    fs.mkdirSync(workspace, { recursive: true });
  });

  beforeEach(() => {
    streamed = [];
    engine = new MusecodeEngine();
    // The binary keeps its state under $HOME, and reads its credentials from there or the environment.
    vi.stubEnv("HOME", path.join(scratch, "home"));
    vi.stubEnv("META_API_KEY", "");
    fs.mkdirSync(path.join(scratch, "home"), { recursive: true });
  });

  afterEach(() => {
    engine.killAll();
    vi.unstubAllEnvs();
    mock?.kill();
    mock = undefined;
  });

  afterAll(() => {
    fs.rmSync(scratch, { recursive: true, force: true });
  });

  it("runs a fresh turn on the echo provider and streams the answer", async () => {
    const result = await engine.run(opts({ prompt: "hello serve" }));
    expect(result.error).toBeUndefined();
    expect(result.result).toBe("echo: hello serve");
    expect(result.numTurns).toBe(1);
    expect(result.sessionId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(streamed.filter((d) => d.type === "text").map((d) => d.content).join("")).toContain("echo: hello serve");
  }, 60_000);

  it("resumes that conversation in a new process and keeps its session id", async () => {
    const first = await engine.run(opts({ prompt: "first turn" }));
    const second = await engine.run(opts({ prompt: "second turn", resumeSessionId: first.sessionId }));
    expect(second.error).toBeUndefined();
    expect(second.result).toBe("echo: second turn");
    expect(second.sessionId).toBe(first.sessionId);
    // Muse holds the conversation in its own store: the session file records both turns.
    const sessionFile = findSessionFile(path.join(scratch, "home"), first.sessionId);
    expect(sessionFile).toBeDefined();
    const log = fs.readFileSync(sessionFile!, "utf8");
    expect(log).toContain("first turn");
    expect(log).toContain("second turn");
  }, 60_000);

  it("adds the system prompt on a fresh session only", async () => {
    const first = await engine.run(opts({ prompt: "do it", systemPrompt: "You are Marid." }));
    expect(first.result).toBe("echo: You are Marid.\n\n---\n\ndo it");
    const second = await engine.run(opts({ prompt: "again", systemPrompt: "You are Marid.", resumeSessionId: first.sessionId }));
    expect(second.result).toBe("echo: again");
  }, 60_000);

  it("reports a resume of a session Muse never had as a dead resume, with no turn sent", async () => {
    const unknown = "01a13f8f-0000-7000-8000-000000000000";
    const result = await engine.run(opts({ resumeSessionId: unknown }));
    expect(result).toEqual({ sessionId: unknown, result: "", error: `musecode has no conversation ${unknown} to resume` });
    expect(isDeadSessionError(result)).toBe(true);
  }, 60_000);

  it("reads a resume id Muse cannot parse as a lost conversation, since it can never resume", async () => {
    const result = await engine.run(opts({ resumeSessionId: "not-a-uuid" }));
    expect(result).toEqual({ sessionId: "not-a-uuid", result: "", error: "musecode has no conversation not-a-uuid to resume" });
    expect(isDeadSessionError(result)).toBe(true);
  }, 60_000);

  it("maps a usage limit from the provider to a rejected rate limit with the provider's reset", async () => {
    const resetsAt = Math.floor(Date.now() / 1000) + 7200;
    const { port } = await startMock("quota", { MOCK_QUOTA_RESET: String(resetsAt) });
    vi.stubEnv("META_API_KEY", "test");
    const result = await engine.run(opts({ prompt: "List the files here and summarise the README.", cliFlags: mockFlags(port) }));
    expect(result.error).toMatch(/Usage limit reached/);
    expect(result.rateLimit).toEqual({ status: "rejected", resetsAt, rateLimitType: "tierLimit" });
    expect(result.numTurns).toBe(1);
    expect(isDeadSessionError(result)).toBe(false);
    expect(detectRateLimit(result)).toEqual({ limited: true, resetsAt });
  }, 60_000);

  it("rides out transient 429s in place, saying so, and the turn completes", async () => {
    const { port } = await startMock("ratelimit");
    vi.stubEnv("META_API_KEY", "test");
    const seen: unknown[] = [];
    engine = new MusecodeEngine({ onUsage: (u) => seen.push(u) });
    const result = await engine.run(opts({ prompt: "Explain what this repository does in one sentence.", cliFlags: mockFlags(port) }));
    expect(result.error).toBeUndefined();
    expect(result.result).toBe("mock answer 2");
    const status = streamed.filter((d) => d.type === "status").map((d) => d.content);
    expect(status).toEqual([
      "Muse Code rate limited (HTTP 429); retry 2/10 in 1s",
      "Muse Code rate limited (HTTP 429); retry 3/10 in 1s",
    ]);
    // The provider's subscription_usage frame reaches the listener as a snapshot.
    expect(seen).toMatchObject([{ tier: "everyday", window: { usedPercent: 42, windowDurationMins: 300 }, weekly: { usedPercent: 17 } }]);
  }, 60_000);

  it("stops a turn that is in flight: turn/interrupt, then a cancelled turn reported as interrupted", async () => {
    const { port } = await startMock("hang");
    vi.stubEnv("META_API_KEY", "test");
    const run = engine.run(opts({ prompt: "Write a very long essay about nothing.", cliFlags: mockFlags(port) }));
    for (let i = 0; i < 200 && !streamed.some((d) => d.type === "text" && d.content.includes("thinking")); i++) await new Promise((r) => setTimeout(r, 50));
    expect(streamed.some((d) => d.type === "text" && d.content.includes("thinking"))).toBe(true);
    const t0 = Date.now();
    engine.kill("e2e-1");
    const result = await run;
    expect(result.error).toBe("Interrupted");
    expect(result.numTurns).toBe(1);
    expect(isDeadSessionError(result)).toBe(false);
    expect(Date.now() - t0).toBeLessThan(10_000);
    expect(engine.isAlive("e2e-1")).toBe(false);
  }, 60_000);

  it("streams a tool call and its result from the real shell tool", async () => {
    const { port } = await startMock("tool", { MOCK_TOOL_COMMAND: "echo hi-from-tool" });
    vi.stubEnv("META_API_KEY", "test");
    const result = await engine.run(opts({ prompt: "Run a command for me please.", cliFlags: mockFlags(port) }));
    expect(result.error).toBeUndefined();
    expect(result.result).toBe("mock answer 1");
    expect(streamed.filter((d) => d.type === "tool_use" || d.type === "tool_result")).toEqual([
      { type: "tool_use", content: "bash: echo hi-from-tool", toolName: "bash", toolId: "call_1", input: "{\"command\":\"echo hi-from-tool\"}" },
      { type: "tool_result", content: "hi-from-tool\n", toolName: "bash", toolId: "call_1" },
    ]);
  }, 60_000);

  it("decides an approval the host asks for: the reply is a receipt, the decision is approval/decide, and only then does the tool run", async () => {
    // A session that prompts for what it has no rule for (the engine itself runs allowAll, where nothing is asked).
    const { port } = await startMock("tool", { MOCK_TOOL_COMMAND: "touch approved-marker.txt" });
    const proc = new MspProcess({
      bin: BIN,
      args: buildMuseServeArgs({ model: "muse-spark-1.2", cliFlags: mockFlags(port).slice(2) }),
      cwd: workspace,
      env: { ...buildEngineChildEnv(process.env), META_API_KEY: "test" },
    });
    try {
      const requested: string[] = [];
      proc.client.onServerRequest((method, params) => {
        requested.push(method);
        return answerMuseServerRequest(proc.client, method, params);
      });
      let turn: MuseTurn | undefined;
      proc.client.onNotification((method, params) => turn?.read(method, params));
      await proc.client.initialize({ clientInfo: { name: "marid", version: "0" }, userInputDialogs: false });
      const started = await proc.client.request<{ session: { sessionId: string } }>("session/start", {
        commandId: uuidv7(), workspaceRoot: workspace, approvalMode: "promptUnmatched", modelId: "muse-spark-1.2",
      });
      const sessionId = started.session.sessionId;
      turn = new MuseTurn(sessionId, { onStream: (d) => streamed.push(d) });
      const ack = await proc.client.request<{ turnId: string }>("turn/start", { commandId: uuidv7(), sessionId, input: [{ type: "text", text: "Make a file for me please." }] });
      turn.setTurnId(ack.turnId);
      await Promise.race([turn.whenCompleted(), new Promise((_, reject) => setTimeout(() => reject(new Error("the turn hung on its approval")), 20_000))]);
      expect(requested).toEqual(["approval/request"]);
      expect(turn.result({ terminationReason: null }).error).toBeUndefined();
      expect(fs.existsSync(path.join(workspace, "approved-marker.txt"))).toBe(true);
    } finally {
      await proc.shutdown();
    }
  }, 60_000);

  it("takes MCP servers in session/start, and none that cannot start (stdio or http, jinn or not) stops the turn", async () => {
    const resolvedMcp = {
      mcpServers: {
        jinn: { command: "/nonexistent/jinn-mcp", args: ["--x"], env: { JINN_SESSION_ID: "e2e-1" } },
        other: { command: "/nonexistent/other-mcp" },
        docs: { url: "http://127.0.0.1:9/mcp" },
      },
    } as unknown as EngineRunOpts["resolvedMcp"];
    const result = await engine.run(opts({ prompt: "with tools", resolvedMcp }));
    expect(result.error).toBeUndefined();
    expect(result.result).toBe("echo: with tools");
  }, 60_000);

  it("reports a missing login as an instruction, and keeps the conversation", async () => {
    // No META_API_KEY and an empty HOME: nothing to sign in with.
    const result = await engine.run(opts({ prompt: "Explain what this repository does in one sentence.", cliFlags: ["--provider", "meta", "-c", "run.reminder_roster=[]"] }));
    expect(result.error).toBeDefined();
    expect(result.error).toMatch(/muse login|META_API_KEY/);
    expect(isDeadSessionError(result)).toBe(false);
  }, 60_000);
});

/** The durable session file Muse wrote for `sessionId` under its data dir (sessions/<yyyy>/<mm>/<dd>/<id>/session.jsonl). */
function findSessionFile(home: string, sessionId: string): string | undefined {
  // Muse keeps a view cache under the same root (`.msp-view-v1/<id>/`): only the dated directory holds the log.
  return walkDirs(path.join(home, ".local", "share", "muse", "sessions"))
    .filter((dir) => path.basename(dir) === sessionId)
    .map((dir) => path.join(dir, "session.jsonl"))
    .find((file) => fs.existsSync(file));
}

function walkDirs(root: string): string[] {
  if (!fs.existsSync(root)) return [];
  const dirs = fs.readdirSync(root, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => path.join(root, e.name));
  return dirs.flatMap((dir) => [dir, ...walkDirs(dir)]);
}
