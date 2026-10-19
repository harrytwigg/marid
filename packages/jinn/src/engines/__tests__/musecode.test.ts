import fs from "node:fs";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";

vi.mock("../../shared/logger.js", () => ({ logger: { warn: vi.fn(), debug: vi.fn(), info: vi.fn(), error: vi.fn() } }));
vi.mock("../../sessions/employee-env.js", () => ({
  employeeSessionEnv: (sessionId: string | undefined) => (sessionId === "s-employee" ? { JINN_EMPLOYEE: "worker" } : {}),
}));

import { NAMES } from "../../shared/codename.js";
import { MusecodeEngine } from "../musecode.js";
import { isDeadSessionError } from "../../shared/rateLimit.js";
import { isLostConversationError } from "../../shared/process-start.js";
import { ctx, methods, opts, sent, starts, useFakeMuse } from "./helpers/fake-muse-harness.js";

useFakeMuse();

describe("a fresh turn", () => {
  it("starts a session, runs one turn, and returns the answer with Muse's session id", async () => {
    const result = await ctx.engine.run(opts({ prompt: "hello there" }));
    expect(result).toMatchObject({ result: "fake muse: hello there", numTurns: 1 });
    expect(result.error).toBeUndefined();
    expect(result.sessionId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7/);
    expect(methods()).toEqual(["initialize", "initialized", "session/start", "turn/start"]);
  });

  it("speaks the protocol the design says: client info, no user-input dialogs, allowAll, the cwd as workspace", async () => {
    await ctx.engine.run(opts());
    const [init] = sent("initialize");
    expect(init).toMatchObject({ clientInfo: { name: NAMES.codename }, capabilities: { userInputDialogs: false } });
    expect(typeof init!.clientInfo.version).toBe("string");
    expect(sent("session/start")[0]).toMatchObject({ workspaceRoot: ctx.tmp, approvalMode: "allowAll" });
    expect(sent("session/start")[0]!.commandId).toMatch(/^[0-9a-f-]{36}$/);
    const turn = sent("turn/start")[0]!;
    expect(turn.input).toEqual([{ type: "text", text: "hello" }]);
    expect(turn.sessionId).toBe(result_sessionId());
  });

  it("spawns `muse serve` with the sandbox off, foreign rules and skills off, and the operator's flags last", async () => {
    await ctx.engine.run(opts({ model: "muse-spark-1.2", cliFlags: ["--provider", "echo"] }));
    expect(starts()[0]!.argv).toEqual([
      "serve", "--disable-sandbox", "--trust-workspace",
      "-c", "context.foreign_personal_rules=false",
      "-c", "context.foreign_personal_skills=false",
      "--model", "muse-spark-1.2",
      "--provider", "echo",
    ]);
    expect(starts()[0]!.cwd).toBe(fs.realpathSync(ctx.tmp));
  });

  it("gives the host the session's identity and none of another CLI's session plumbing", async () => {
    await ctx.engine.run(opts({ sessionId: "s-employee" }));
    const env = starts()[0]!.env;
    expect(env.JINN_SESSION_ID).toBe("s-employee");
    expect(env.JINN_EMPLOYEE).toBe("worker");
    expect(env.CLAUDECODE).toBeUndefined();
    expect(env.CODEX_HOME).toBeUndefined();
  });

  it("prefixes the system prompt on a fresh session only, as opencode does", async () => {
    const fresh = await ctx.engine.run(opts({ prompt: "do it", systemPrompt: "You are Marid." }));
    expect(fresh.result).toBe("fake muse: You are Marid.\n\n---\n\ndo it");
    const resumed = await ctx.engine.run(opts({ prompt: "again", systemPrompt: "You are Marid.", resumeSessionId: fresh.sessionId }));
    expect(resumed.result).toBe("fake muse: again");
  });

  it("names non-image attachments in the prompt, as opencode does", async () => {
    const result = await ctx.engine.run(opts({ prompt: "read this", attachments: ["/tmp/notes.txt"] }));
    expect(result.result).toBe("fake muse: read this\n\nAttached files:\n- /tmp/notes.txt");
  });

  it("sends image attachments as image parts and names only the rest", async () => {
    const png = path.join(ctx.tmp, "shot.png");
    fs.writeFileSync(png, Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    await ctx.engine.run(opts({ prompt: "look", attachments: [png, "/tmp/notes.txt"] }));
    const input = sent("turn/start")[0]!.input;
    expect(input[0]).toEqual({ type: "text", text: "look\n\nAttached files:\n- /tmp/notes.txt" });
    expect(input[1]).toEqual({ type: "image", base64Data: Buffer.from([0x89, 0x50, 0x4e, 0x47]).toString("base64"), mediaType: "image/png" });
  });

  it("streams the answer as text, never the reasoning, and reports usage", async () => {
    const result = await ctx.engine.run(opts({ prompt: "stream me" }));
    expect(ctx.streamed.filter((d) => d.type === "text").map((d) => d.content).join("")).toBe("fake muse: stream me");
    expect(JSON.stringify(ctx.streamed)).not.toContain("private reasoning");
    expect(result.contextTokens).toBe(105);
    expect(result.durationMs).toBe(150);
  });

  it("settles on turn/completed, not on turn/foregroundCompleted", async () => {
    const t0 = Date.now();
    const result = await ctx.engine.run(opts());
    expect(result.error).toBeUndefined();
    // The fake holds the turn open 150 ms after the foreground completes.
    expect(Date.now() - t0).toBeGreaterThanOrEqual(150);
  });

  it("leaves no host behind", async () => {
    await ctx.engine.run(opts());
    expect(ctx.engine.isAlive("s1")).toBe(false);
  });
});

function result_sessionId(): string {
  return sent("turn/start")[0]!.sessionId as string;
}

describe("effort and model", () => {
  it("passes a level in the MSP vocabulary as reasoningEffort, and not otherwise", async () => {
    await ctx.engine.run(opts({ effortLevel: "high" }));
    await ctx.engine.run(opts({ effortLevel: "ultra" }));
    await ctx.engine.run(opts({ effortLevel: "none" }));
    await ctx.engine.run(opts({ effortLevel: "turbo" }));
    await ctx.engine.run(opts());
    expect(sent("turn/start").map((p) => p.reasoningEffort)).toEqual(["high", "ultra", undefined, undefined, undefined]);
  });

  it("names the model when it starts a session", async () => {
    await ctx.engine.run(opts({ model: "muse-spark-1.3" }));
    expect(sent("session/start")[0]!.modelId).toBe("muse-spark-1.3");
  });

  it("does not name one when none is configured", async () => {
    await ctx.engine.run(opts());
    expect(sent("session/start")[0]).not.toHaveProperty("modelId");
  });
});

describe("effort against the turn's own model", () => {
  const catalog: Record<string, string[]> = { "m-wide": ["low", "high", "max"], "m-narrow": ["low", "high"], "m-default": ["high", "max"] };
  /** An engine that reads the levels from a registry holding `catalog`; an unset model is judged as `m-default`. */
  const withRegistry = () => {
    ctx.engine = new MusecodeEngine({ effortLevels: () => (model) => catalog[model ?? "m-default"] ?? [] });
  };

  it("sends no effort for a model the registry does not list", async () => {
    withRegistry();
    await ctx.engine.run(opts({ model: "pinned-elsewhere", effortLevel: "max" }));
    expect(sent("turn/start")[0]).not.toHaveProperty("reasoningEffort");
  });

  it("sends an effort the turn's model lists", async () => {
    withRegistry();
    await ctx.engine.run(opts({ model: "m-wide", effortLevel: "max" }));
    expect(sent("turn/start")[0]!.reasoningEffort).toBe("max");
  });

  it("sends no effort the turn's model leaves out, and still runs the turn", async () => {
    withRegistry();
    const result = await ctx.engine.run(opts({ model: "m-narrow", effortLevel: "max" }));
    expect(result.error).toBeUndefined();
    expect(sent("turn/start")[0]).not.toHaveProperty("reasoningEffort");
  });

  it("judges a turn with no model against the default's levels", async () => {
    withRegistry();
    await ctx.engine.run(opts({ effortLevel: "max" }));
    expect(sent("turn/start")[0]!.reasoningEffort).toBe("max");
  });

  it("still sends nothing outside Muse's vocabulary or for none", async () => {
    withRegistry();
    catalog["m-wide"]!.push("turbo", "none");
    await ctx.engine.run(opts({ model: "m-wide", effortLevel: "turbo" }));
    await ctx.engine.run(opts({ model: "m-wide", effortLevel: "none" }));
    expect(sent("turn/start").map((p) => p.reasoningEffort)).toEqual([undefined, undefined]);
  });
});

describe("a resumed turn", () => {
  it("resumes Muse's session with the history left on the host", async () => {
    const first = await ctx.engine.run(opts({ prompt: "one" }));
    const second = await ctx.engine.run(opts({ prompt: "two", resumeSessionId: first.sessionId }));
    expect(second).toMatchObject({ result: "fake muse: two", sessionId: first.sessionId, numTurns: 1 });
    expect(sent("session/resume")).toEqual([
      expect.objectContaining({ sessionId: first.sessionId, history: "auto", excludeItems: true }),
    ]);
    expect(methods().filter((m) => m === "session/start")).toHaveLength(1);
    expect(sent("turn/start")[1]!.sessionId).toBe(first.sessionId);
  });

  it("switches the model when the resumed conversation is on another", async () => {
    const first = await ctx.engine.run(opts({ model: "muse-spark-1.2" }));
    await ctx.engine.run(opts({ model: "muse-spark-1.3", resumeSessionId: first.sessionId }));
    expect(sent("session/setModel")).toEqual([expect.objectContaining({ sessionId: first.sessionId, model: { modelId: "muse-spark-1.3" } })]);
    // setModel comes before the turn.
    const order = methods();
    expect(order.indexOf("session/setModel")).toBeLessThan(order.lastIndexOf("turn/start"));
  });

  it("leaves the model alone when it already matches, or none is configured", async () => {
    const first = await ctx.engine.run(opts({ model: "muse-spark-1.2" }));
    await ctx.engine.run(opts({ model: "muse-spark-1.2", resumeSessionId: first.sessionId }));
    await ctx.engine.run(opts({ resumeSessionId: first.sessionId }));
    expect(sent("session/setModel")).toEqual([]);
  });

  it("reports a conversation the host no longer has as a dead resume: no cost, no turns, no turn sent", async () => {
    const gone = "01a13f8f-0000-7000-8000-000000000000";
    const result = await ctx.engine.run(opts({ resumeSessionId: gone }));
    expect(result).toEqual({ sessionId: gone, result: "", error: `musecode has no conversation ${gone} to resume` });
    expect(methods()).not.toContain("turn/start");
    expect(isDeadSessionError(result)).toBe(true);
    expect(isLostConversationError(result.error!, gone)).toBe(true);
  });

  it("reads a resume id the host cannot parse as a lost conversation: it can never resume", async () => {
    vi.stubEnv("FAKE_MUSE_RESUME_FAIL", "invalid sessionId: invalid character: found `n` at 0");
    const result = await ctx.engine.run(opts({ resumeSessionId: "not-a-uuid" }));
    expect(result).toEqual({ sessionId: "not-a-uuid", result: "", error: "musecode has no conversation not-a-uuid to resume" });
    expect(isLostConversationError(result.error!, "not-a-uuid")).toBe(true);
    expect(isDeadSessionError(result)).toBe(true);
  });

  it("does not mistake any other resume failure for a lost conversation", async () => {
    const first = await ctx.engine.run(opts());
    vi.stubEnv("FAKE_MUSE_RESUME_FAIL", "the session store is locked");
    const result = await ctx.engine.run(opts({ resumeSessionId: first.sessionId }));
    expect(result.error).toBe("the session store is locked");
    expect(result).toMatchObject({ numTurns: 1, conversationIntact: true });
    expect(isDeadSessionError(result)).toBe(false);
    expect(isLostConversationError(result.error!, first.sessionId)).toBe(false);
  });
});

describe("tools, retries and usage", () => {
  it("streams a tool call and its result", async () => {
    const result = await ctx.engine.run(opts({ prompt: "list\n---\nTOOL" }));
    expect(result.error).toBeUndefined();
    expect(ctx.streamed.filter((d) => d.type === "tool_use" || d.type === "tool_result")).toEqual([
      { type: "tool_use", content: "bash: ls", toolName: "bash", toolId: "call_1", input: "{\"command\":\"ls\"}" },
      { type: "tool_result", content: "file1\nfile2", toolName: "bash", toolId: "call_1" },
    ]);
  });

  it("shows provider retries as status lines and still answers", async () => {
    const result = await ctx.engine.run(opts({ prompt: "go\n---\nRETRY" }));
    expect(result.error).toBeUndefined();
    expect(ctx.streamed.filter((d) => d.type === "status").map((d) => d.content)).toEqual([
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

