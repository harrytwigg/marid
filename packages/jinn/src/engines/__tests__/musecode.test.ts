import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { EngineRunOpts, StreamDelta } from "../../shared/types.js";

vi.mock("../../shared/logger.js", () => ({ logger: { warn: vi.fn(), debug: vi.fn(), info: vi.fn(), error: vi.fn() } }));
vi.mock("../../sessions/employee-env.js", () => ({
  employeeSessionEnv: (sessionId: string | undefined) => (sessionId === "s-employee" ? { JINN_EMPLOYEE: "worker" } : {}),
}));

import { MusecodeEngine } from "../musecode.js";
import { isDeadSessionError, detectRateLimit } from "../../shared/rateLimit.js";
import { isLostConversationError } from "../../shared/process-start.js";

const FAKE = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures", "fake-muse.mjs");

let tmp: string;
let logFile: string;
let engine: MusecodeEngine;
const streamed: StreamDelta[] = [];

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "musecode-engine-"));
  logFile = path.join(tmp, "requests.jsonl");
  vi.stubEnv("FAKE_MUSE_STATE_DIR", path.join(tmp, "state"));
  vi.stubEnv("FAKE_MUSE_LOG", logFile);
  vi.stubEnv("FAKE_MUSE_RESET_MS", "");
  vi.stubEnv("FAKE_MUSE_RESUME_FAIL", "");
  vi.stubEnv("FAKE_MUSE_BOOT_EXIT", "");
  vi.stubEnv("FAKE_MUSE_NO_GRANT", "");
  vi.stubEnv("CLAUDECODE", "1");
  vi.stubEnv("CODEX_HOME", "/somewhere");
  streamed.length = 0;
  engine = new MusecodeEngine();
});

afterEach(() => {
  engine.killAll();
  vi.unstubAllEnvs();
  fs.rmSync(tmp, { recursive: true, force: true });
});

function opts(over: Partial<EngineRunOpts> = {}): EngineRunOpts {
  return { prompt: "hello", cwd: tmp, bin: FAKE, sessionId: "s1", onStream: (d) => streamed.push(d), ...over };
}

/** What the fake host was sent: one entry per request, and the process start. */
function requests(): Array<Record<string, any>> {
  return fs.existsSync(logFile) ? fs.readFileSync(logFile, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)) : [];
}
const methods = () => requests().filter((r) => r.method).map((r) => r.method as string);
const sent = (method: string) => requests().filter((r) => r.method === method).map((r) => r.params as Record<string, any>);
const starts = () => requests().filter((r) => r.start);

describe("a fresh turn", () => {
  it("starts a session, runs one turn, and returns the answer with Muse's session id", async () => {
    const result = await engine.run(opts({ prompt: "hello there" }));
    expect(result).toMatchObject({ result: "fake muse: hello there", numTurns: 1 });
    expect(result.error).toBeUndefined();
    expect(result.sessionId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7/);
    expect(methods()).toEqual(["initialize", "initialized", "session/start", "turn/start"]);
  });

  it("speaks the protocol the design says: client info, no user-input dialogs, allowAll, the cwd as workspace", async () => {
    await engine.run(opts());
    const [init] = sent("initialize");
    expect(init).toMatchObject({ clientInfo: { name: "marid" }, capabilities: { userInputDialogs: false } });
    expect(typeof init!.clientInfo.version).toBe("string");
    expect(sent("session/start")[0]).toMatchObject({ workspaceRoot: tmp, approvalMode: "allowAll" });
    expect(sent("session/start")[0]!.commandId).toMatch(/^[0-9a-f-]{36}$/);
    const turn = sent("turn/start")[0]!;
    expect(turn.input).toEqual([{ type: "text", text: "hello" }]);
    expect(turn.sessionId).toBe(result_sessionId());
  });

  it("spawns `muse serve` with the sandbox off, foreign rules and skills off, and the operator's flags last", async () => {
    await engine.run(opts({ model: "muse-spark-1.2", cliFlags: ["--provider", "echo"] }));
    expect(starts()[0]!.argv).toEqual([
      "serve", "--disable-sandbox",
      "-c", "context.foreign_personal_rules=false",
      "-c", "context.foreign_personal_skills=false",
      "--model", "muse-spark-1.2",
      "--provider", "echo",
    ]);
    expect(starts()[0]!.cwd).toBe(fs.realpathSync(tmp));
  });

  it("gives the host the session's identity and none of another CLI's session plumbing", async () => {
    await engine.run(opts({ sessionId: "s-employee" }));
    const env = starts()[0]!.env;
    expect(env.JINN_SESSION_ID).toBe("s-employee");
    expect(env.JINN_EMPLOYEE).toBe("worker");
    expect(env.CLAUDECODE).toBeUndefined();
    expect(env.CODEX_HOME).toBeUndefined();
  });

  it("prefixes the system prompt on a fresh session only, as opencode does", async () => {
    const fresh = await engine.run(opts({ prompt: "do it", systemPrompt: "You are Marid." }));
    expect(fresh.result).toBe("fake muse: You are Marid.\n\n---\n\ndo it");
    const resumed = await engine.run(opts({ prompt: "again", systemPrompt: "You are Marid.", resumeSessionId: fresh.sessionId }));
    expect(resumed.result).toBe("fake muse: again");
  });

  it("names non-image attachments in the prompt, as opencode does", async () => {
    const result = await engine.run(opts({ prompt: "read this", attachments: ["/tmp/notes.txt"] }));
    expect(result.result).toBe("fake muse: read this\n\nAttached files:\n- /tmp/notes.txt");
  });

  it("sends image attachments as image parts and names only the rest", async () => {
    const png = path.join(tmp, "shot.png");
    fs.writeFileSync(png, Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    await engine.run(opts({ prompt: "look", attachments: [png, "/tmp/notes.txt"] }));
    const input = sent("turn/start")[0]!.input;
    expect(input[0]).toEqual({ type: "text", text: "look\n\nAttached files:\n- /tmp/notes.txt" });
    expect(input[1]).toEqual({ type: "image", base64Data: Buffer.from([0x89, 0x50, 0x4e, 0x47]).toString("base64"), mediaType: "image/png" });
  });

  it("streams the answer as text, never the reasoning, and reports usage", async () => {
    const result = await engine.run(opts({ prompt: "stream me" }));
    expect(streamed.filter((d) => d.type === "text").map((d) => d.content).join("")).toBe("fake muse: stream me");
    expect(JSON.stringify(streamed)).not.toContain("private reasoning");
    expect(result.contextTokens).toBe(105);
    expect(result.durationMs).toBe(150);
  });

  it("settles on turn/completed, not on turn/foregroundCompleted", async () => {
    const t0 = Date.now();
    const result = await engine.run(opts());
    expect(result.error).toBeUndefined();
    // The fake holds the turn open 150 ms after the foreground completes.
    expect(Date.now() - t0).toBeGreaterThanOrEqual(150);
  });

  it("leaves no host behind", async () => {
    await engine.run(opts());
    expect(engine.isAlive("s1")).toBe(false);
  });
});

function result_sessionId(): string {
  return sent("turn/start")[0]!.sessionId as string;
}

describe("effort and model", () => {
  it("passes a level in the MSP vocabulary as reasoningEffort, and not otherwise", async () => {
    await engine.run(opts({ effortLevel: "high" }));
    await engine.run(opts({ effortLevel: "ultra" }));
    await engine.run(opts({ effortLevel: "none" }));
    await engine.run(opts({ effortLevel: "turbo" }));
    await engine.run(opts());
    expect(sent("turn/start").map((p) => p.reasoningEffort)).toEqual(["high", "ultra", undefined, undefined, undefined]);
  });

  it("names the model when it starts a session", async () => {
    await engine.run(opts({ model: "muse-spark-1.3" }));
    expect(sent("session/start")[0]!.modelId).toBe("muse-spark-1.3");
  });

  it("does not name one when none is configured", async () => {
    await engine.run(opts());
    expect(sent("session/start")[0]).not.toHaveProperty("modelId");
  });
});

describe("a resumed turn", () => {
  it("resumes Muse's session with the history left on the host", async () => {
    const first = await engine.run(opts({ prompt: "one" }));
    const second = await engine.run(opts({ prompt: "two", resumeSessionId: first.sessionId }));
    expect(second).toMatchObject({ result: "fake muse: two", sessionId: first.sessionId, numTurns: 1 });
    expect(sent("session/resume")).toEqual([
      expect.objectContaining({ sessionId: first.sessionId, history: "auto", excludeItems: true }),
    ]);
    expect(methods().filter((m) => m === "session/start")).toHaveLength(1);
    expect(sent("turn/start")[1]!.sessionId).toBe(first.sessionId);
  });

  it("switches the model when the resumed conversation is on another", async () => {
    const first = await engine.run(opts({ model: "muse-spark-1.2" }));
    await engine.run(opts({ model: "muse-spark-1.3", resumeSessionId: first.sessionId }));
    expect(sent("session/setModel")).toEqual([expect.objectContaining({ sessionId: first.sessionId, model: { modelId: "muse-spark-1.3" } })]);
    // setModel comes before the turn.
    const order = methods();
    expect(order.indexOf("session/setModel")).toBeLessThan(order.lastIndexOf("turn/start"));
  });

  it("leaves the model alone when it already matches, or none is configured", async () => {
    const first = await engine.run(opts({ model: "muse-spark-1.2" }));
    await engine.run(opts({ model: "muse-spark-1.2", resumeSessionId: first.sessionId }));
    await engine.run(opts({ resumeSessionId: first.sessionId }));
    expect(sent("session/setModel")).toEqual([]);
  });

  it("reports a conversation the host no longer has as a dead resume: no cost, no turns, no turn sent", async () => {
    const gone = "01a13f8f-0000-7000-8000-000000000000";
    const result = await engine.run(opts({ resumeSessionId: gone }));
    expect(result).toEqual({ sessionId: gone, result: "", error: `musecode has no conversation ${gone} to resume` });
    expect(methods()).not.toContain("turn/start");
    expect(isDeadSessionError(result)).toBe(true);
    expect(isLostConversationError(result.error!, gone)).toBe(true);
  });

  it("does not mistake any other resume failure for a lost conversation", async () => {
    const first = await engine.run(opts());
    vi.stubEnv("FAKE_MUSE_RESUME_FAIL", "the session store is locked");
    const result = await engine.run(opts({ resumeSessionId: first.sessionId }));
    expect(result.error).toBe("the session store is locked");
    expect(result.numTurns).toBe(1);
    expect(isDeadSessionError(result)).toBe(false);
    expect(isLostConversationError(result.error!, first.sessionId)).toBe(false);
  });
});

describe("tools, retries and usage", () => {
  it("streams a tool call and its result", async () => {
    const result = await engine.run(opts({ prompt: "list\n---\nTOOL" }));
    expect(result.error).toBeUndefined();
    expect(streamed.filter((d) => d.type === "tool_use" || d.type === "tool_result")).toEqual([
      { type: "tool_use", content: "bash: ls", toolName: "bash", toolId: "call_1", input: "{\"command\":\"ls\"}" },
      { type: "tool_result", content: "file1\nfile2", toolName: "bash", toolId: "call_1" },
    ]);
  });

  it("shows provider retries as status lines and still answers", async () => {
    const result = await engine.run(opts({ prompt: "go\n---\nRETRY" }));
    expect(result.error).toBeUndefined();
    expect(streamed.filter((d) => d.type === "status").map((d) => d.content)).toEqual([
      "Muse Code rate limited (HTTP 429); retry 2/10 in 1s",
      "Muse Code rate limited (HTTP 429); retry 3/10 in 1s",
    ]);
  });

  it("hands the subscription usage a host reports to the listener", async () => {
    const seen: unknown[] = [];
    const listening = new MusecodeEngine({ onUsage: (u) => seen.push(u) });
    await listening.run(opts({ prompt: "go\n---\nUSAGE" }));
    expect(seen).toMatchObject([{ tier: "everyday", window: { usedPercent: 42, windowDurationMins: 300 }, weekly: { usedPercent: 17 } }]);
  });

  it("prices the turn when the model's rates are known, and only then", async () => {
    const priced = new MusecodeEngine({ modelCost: (model) => (model === "muse-spark-1.2" ? { input: 1, cached: 0.1, output: 5 } : undefined) });
    const known = await priced.run(opts({ model: "muse-spark-1.2" }));
    expect(known.cost).toBeCloseTo((80 * 1 + 20 * 0.1 + 5 * 5) / 1e6);
    const unknown = await priced.run(opts({ model: "other" }));
    expect(unknown.cost).toBeUndefined();
  });
});

describe("failures", () => {
  it("maps a usage limit to a rejected rate limit with its reset, and keeps the resume id", async () => {
    const resetsAtMs = Date.now() + 3 * 3600_000 + 456;
    vi.stubEnv("FAKE_MUSE_RESET_MS", String(resetsAtMs));
    const first = await engine.run(opts());
    const result = await engine.run(opts({ prompt: "x\n---\nQUOTA", resumeSessionId: first.sessionId }));
    expect(result).toMatchObject({
      sessionId: first.sessionId,
      result: "",
      error: "API error 429: Usage limit reached (tier_limit_error)",
      numTurns: 1,
      rateLimit: { status: "rejected", resetsAt: Math.floor(resetsAtMs / 1000), rateLimitType: "tierLimit" },
    });
    expect(isDeadSessionError(result)).toBe(false);
    expect(detectRateLimit(result)).toEqual({ limited: true, resetsAt: Math.floor(resetsAtMs / 1000) });
  });

  it("tells the operator to sign in when Muse is not signed in, without losing the conversation", async () => {
    const first = await engine.run(opts());
    const result = await engine.run(opts({ prompt: "x\n---\nAUTH", resumeSessionId: first.sessionId }));
    expect(result.error).toMatch(/muse login/);
    expect(result.error).toMatch(/META_API_KEY/);
    expect(result.sessionId).toBe(first.sessionId);
    expect(isDeadSessionError(result)).toBe(false);
  });

  it("reports a plain model failure", async () => {
    const result = await engine.run(opts({ prompt: "x\n---\nFAIL" }));
    expect(result.error).toBe("The model stopped: simulated failure");
    expect(result.numTurns).toBe(1);
  });

  it("fails the turn, with what the host said, when the host dies in the middle of it", async () => {
    const result = await engine.run(opts({ prompt: "x\n---\nEXIT" }));
    expect(result.result).toBe("");
    expect(result.error).toMatch(/exited before the turn finished \(code 3\)/);
    expect(result.numTurns).toBe(1);
    expect(isDeadSessionError(result)).toBe(false);
  });

  it("says the process did not start, and keeps the resume id, when the host cannot come up", async () => {
    vi.stubEnv("FAKE_MUSE_BOOT_EXIT", "9");
    const result = await engine.run(opts({ resumeSessionId: "01a13f8f-0000-7000-8000-000000000001" }));
    expect(result.error).toMatch(/^musecode did not start: its process exited \(code 9, signal 0\) before its session began\. Its last output: fake muse: cannot start/);
    expect(isDeadSessionError(result)).toBe(false);
    expect(isLostConversationError(result.error!, "01a13f8f-0000-7000-8000-000000000001")).toBe(false);
  });

  it("rejects, like the other CLI engines, when the binary cannot be spawned", async () => {
    await expect(engine.run(opts({ bin: "/nonexistent/muse" }))).rejects.toThrow(/Failed to spawn Muse Code CLI/);
  });
});

describe("approvals and questions", () => {
  it("decides an approval it is asked for, with an allowing choice, and the turn goes on", async () => {
    const result = await engine.run(opts({ prompt: "x\n---\nAPPROVAL" }));
    expect(result.result).toBe("approval decided: allow-once");
    const [decision] = sent("approval/decide");
    expect(decision).toMatchObject({ choiceId: "allow-once", sessionId: result.sessionId });
    expect(decision!.requirementId).toEqual({ approvalId: decision!.approvalId, sourceIndex: 0 });
  });

  it("declines a question for the user instead of hanging on it", async () => {
    const result = await engine.run(opts({ prompt: "x\n---\nUSERINPUT" }));
    expect(result.result).toBe("question declined");
    expect(sent("userInput/cancel")).toEqual([expect.objectContaining({ sessionId: result.sessionId })]);
  });
});

describe("interrupts", () => {
  /** Starts a turn that does not end on its own and waits until its host is working. */
  async function startHanging(directive: string) {
    const run = engine.run(opts({ prompt: `x\n---\n${directive}` }));
    for (let i = 0; i < 100 && !streamed.some((d) => d.content === "working on it"); i++) await new Promise((r) => setTimeout(r, 25));
    expect(streamed.some((d) => d.content === "working on it")).toBe(true);
    return run;
  }

  it("asks the turn to stop and reports it as interrupted, with the session still resumable", async () => {
    const run = startHanging("HANG");
    await new Promise((r) => setTimeout(r, 200));
    expect(engine.isAlive("s1")).toBe(true);
    engine.kill("s1");
    const result = await run;
    expect(result.error).toBe("Interrupted");
    expect(result.error!.startsWith("Interrupted")).toBe(true);
    expect(result.numTurns).toBe(1);
    expect(isDeadSessionError(result)).toBe(false);
    expect(methods()).toContain("turn/interrupt");
    expect(engine.isAlive("s1")).toBe(false);
  });

  it("carries the reason it was given", async () => {
    const run = startHanging("HANG");
    await new Promise((r) => setTimeout(r, 200));
    engine.kill("s1", "Interrupted: engine switched");
    expect((await run).error).toBe("Interrupted: engine switched");
  });

  it("signals a host that will not stop within three seconds", async () => {
    const run = startHanging("STUCK");
    await new Promise((r) => setTimeout(r, 200));
    const t0 = Date.now();
    engine.kill("s1");
    const result = await run;
    expect(result.error).toBe("Interrupted");
    expect(Date.now() - t0).toBeGreaterThanOrEqual(2900);
    expect(methods()).toContain("turn/interrupt");
  }, 15_000);

  it("killAll stops every turn in flight", async () => {
    const run = startHanging("HANG");
    await new Promise((r) => setTimeout(r, 200));
    engine.killAll();
    expect((await run).error).toBe("Interrupted: gateway shutting down");
  });

  it("is a no-op for a session with no turn, and killIdle does nothing", () => {
    expect(() => engine.kill("nobody")).not.toThrow();
    expect(() => engine.killIdle()).not.toThrow();
    expect(engine.isAlive("nobody")).toBe(false);
  });
});

describe("MCP", () => {
  const resolvedMcp = {
    mcpServers: {
      jinn: { command: "node", args: ["/x/mcp.js"], env: { JINN_SESSION_ID: "s1", JINN_MCP_CAPABILITY: "secret-capability" } },
      docs: { url: "https://docs.example.test/mcp", headers: { Authorization: "Bearer docs-token" } },
    },
  } as unknown as EngineRunOpts["resolvedMcp"];

  it("projects the session's servers into session/start, and none of it into argv", async () => {
    await engine.run(opts({ resolvedMcp }));
    expect(sent("session/start")[0]!.config).toEqual({
      mcpServers: {
        jinn: { transport: "stdio", command: "node", args: ["/x/mcp.js"], env: { JINN_SESSION_ID: "s1", JINN_MCP_CAPABILITY: "secret-capability" }, mode: "optional" },
        docs: { transport: "streamableHttp", url: "https://docs.example.test/mcp", headers: { Authorization: "Bearer docs-token" } },
      },
    });
    expect(JSON.stringify(starts()[0]!.argv)).not.toMatch(/secret-capability|docs-token/);
  });

  it("projects them again into session/resume", async () => {
    const first = await engine.run(opts());
    await engine.run(opts({ resolvedMcp, resumeSessionId: first.sessionId }));
    expect(Object.keys(sent("session/resume")[0]!.config.mcpServers)).toEqual(["jinn", "docs"]);
  });

  it("sends no config when the session has no servers", async () => {
    await engine.run(opts());
    expect(sent("session/start")[0]).not.toHaveProperty("config");
  });

  it("asks the host for the sessionMcp capability, which it needs to take them, and only when there are some", async () => {
    await engine.run(opts());
    await engine.run(opts({ resolvedMcp }));
    const [without, withServers] = sent("initialize");
    expect(without!.capabilities).toEqual({ userInputDialogs: false });
    expect(withServers!.capabilities).toEqual({ userInputDialogs: false, requestedCapabilities: ["sessionMcp"] });
  });

  it("runs the turn without the servers, and says so, when the host will not grant session MCP", async () => {
    vi.stubEnv("FAKE_MUSE_NO_GRANT", "1");
    const result = await engine.run(opts({ resolvedMcp }));
    expect(result.error).toBeUndefined();
    expect(sent("session/start")[0]).not.toHaveProperty("config");
    expect(streamed.filter((d) => d.type === "status").map((d) => d.content)).toEqual(["Muse Code did not grant session MCP; running without the company tools"]);
  });
});

describe("notfound after a turn", () => {
  it("the next resume of a session the host dropped is a dead resume", async () => {
    const first = await engine.run(opts({ prompt: "x\n---\nNOTFOUND" }));
    expect(first.error).toBeUndefined();
    const second = await engine.run(opts({ resumeSessionId: first.sessionId }));
    expect(second.error).toBe(`musecode has no conversation ${first.sessionId} to resume`);
  });
});
