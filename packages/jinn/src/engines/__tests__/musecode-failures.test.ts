import { describe, expect, it, vi } from "vitest";
import type { EngineRunOpts } from "../../shared/types.js";

vi.mock("../../shared/logger.js", () => ({ logger: { warn: vi.fn(), debug: vi.fn(), info: vi.fn(), error: vi.fn() } }));
vi.mock("../../sessions/employee-env.js", () => ({
  employeeSessionEnv: (sessionId: string | undefined) => (sessionId === "s-employee" ? { JINN_EMPLOYEE: "worker" } : {}),
}));

import { isDeadSessionError, detectRateLimit } from "../../shared/rateLimit.js";
import { isLostConversationError } from "../../shared/process-start.js";
import { ctx, methods, opts, sent, starts, useFakeMuse } from "./helpers/fake-muse-harness.js";

useFakeMuse();

describe("failures", () => {
  it("maps a usage limit to a rejected rate limit with its reset, and keeps the resume id", async () => {
    const resetsAtMs = Date.now() + 3 * 3600_000 + 456;
    vi.stubEnv("FAKE_MUSE_RESET_MS", String(resetsAtMs));
    const first = await ctx.engine.run(opts());
    const result = await ctx.engine.run(opts({ prompt: "x\n---\nQUOTA", resumeSessionId: first.sessionId }));
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
    const first = await ctx.engine.run(opts());
    const result = await ctx.engine.run(opts({ prompt: "x\n---\nAUTH", resumeSessionId: first.sessionId }));
    expect(result.error).toMatch(/muse login/);
    expect(result.error).toMatch(/META_API_KEY/);
    expect(result.sessionId).toBe(first.sessionId);
    expect(isDeadSessionError(result)).toBe(false);
  });

  it("reports a plain model failure", async () => {
    const result = await ctx.engine.run(opts({ prompt: "x\n---\nFAIL" }));
    expect(result.error).toBe("The model stopped: simulated failure");
    expect(result.numTurns).toBe(1);
  });

  it("fails the turn, with what the host said, when the host dies in the middle of it", async () => {
    const result = await ctx.engine.run(opts({ prompt: "x\n---\nEXIT" }));
    expect(result.result).toBe("");
    expect(result.error).toMatch(/exited before the turn finished \(code 3\)/);
    expect(result.numTurns).toBe(1);
    expect(isDeadSessionError(result)).toBe(false);
  });

  it("says the process did not start, and keeps the resume id, when the host cannot come up", async () => {
    vi.stubEnv("FAKE_MUSE_BOOT_EXIT", "9");
    const result = await ctx.engine.run(opts({ resumeSessionId: "01a13f8f-0000-7000-8000-000000000001" }));
    expect(result.error).toMatch(/^musecode did not start: its process exited \(code 9, signal 0\) before its session began\. Its last output: fake muse: cannot start/);
    expect(isDeadSessionError(result)).toBe(false);
    expect(isLostConversationError(result.error!, "01a13f8f-0000-7000-8000-000000000001")).toBe(false);
  });

  it("rejects, like the other CLI engines, when the binary cannot be spawned", async () => {
    await expect(ctx.engine.run(opts({ bin: "/nonexistent/muse" }))).rejects.toThrow(/Failed to spawn Muse Code CLI/);
  });
});

describe("approvals and questions", () => {
  it("decides an approval it is asked for, with an allowing choice, and the turn goes on", async () => {
    const result = await ctx.engine.run(opts({ prompt: "x\n---\nAPPROVAL" }));
    expect(result.result).toBe("approval decided: allow-once");
    const [decision] = sent("approval/decide");
    expect(decision).toMatchObject({ choiceId: "allow-once", sessionId: result.sessionId });
    expect(decision!.requirementId).toEqual({ approvalId: decision!.approvalId, sourceIndex: 0 });
  });

  it("declines a question for the user instead of hanging on it", async () => {
    const result = await ctx.engine.run(opts({ prompt: "x\n---\nUSERINPUT" }));
    expect(result.result).toBe("question declined");
    expect(sent("userInput/cancel")).toEqual([expect.objectContaining({ sessionId: result.sessionId })]);
  });
});

describe("interrupts", () => {
  /** Starts a turn that does not end on its own and waits until its host is working. */
  async function startHanging(directive: string) {
    const run = ctx.engine.run(opts({ prompt: `x\n---\n${directive}` }));
    for (let i = 0; i < 100 && !ctx.streamed.some((d) => d.content === "working on it"); i++) await new Promise((r) => setTimeout(r, 25));
    expect(ctx.streamed.some((d) => d.content === "working on it")).toBe(true);
    return run;
  }

  it("asks the turn to stop and reports it as interrupted, with the session still resumable", async () => {
    const run = startHanging("HANG");
    await new Promise((r) => setTimeout(r, 200));
    expect(ctx.engine.isAlive("s1")).toBe(true);
    ctx.engine.kill("s1");
    const result = await run;
    expect(result.error).toBe("Interrupted");
    expect(result.error!.startsWith("Interrupted")).toBe(true);
    expect(result.numTurns).toBe(1);
    expect(isDeadSessionError(result)).toBe(false);
    expect(methods()).toContain("turn/interrupt");
    expect(ctx.engine.isAlive("s1")).toBe(false);
  });

  it("carries the reason it was given", async () => {
    const run = startHanging("HANG");
    await new Promise((r) => setTimeout(r, 200));
    ctx.engine.kill("s1", "Interrupted: engine switched");
    expect((await run).error).toBe("Interrupted: engine switched");
  });

  it("signals a host that will not stop within three seconds", async () => {
    const run = startHanging("STUCK");
    await new Promise((r) => setTimeout(r, 200));
    const t0 = Date.now();
    ctx.engine.kill("s1");
    const result = await run;
    expect(result.error).toBe("Interrupted");
    expect(Date.now() - t0).toBeGreaterThanOrEqual(2900);
    expect(methods()).toContain("turn/interrupt");
  }, 15_000);

  it("killAll stops every turn in flight", async () => {
    const run = startHanging("HANG");
    await new Promise((r) => setTimeout(r, 200));
    ctx.engine.killAll();
    expect((await run).error).toBe("Interrupted: gateway shutting down");
  });

  it("is a no-op for a session with no turn, and killIdle does nothing", () => {
    expect(() => ctx.engine.kill("nobody")).not.toThrow();
    expect(() => ctx.engine.killIdle()).not.toThrow();
    expect(ctx.engine.isAlive("nobody")).toBe(false);
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
    await ctx.engine.run(opts({ resolvedMcp }));
    expect(sent("session/start")[0]!.config).toEqual({
      mcpServers: {
        jinn: { transport: "stdio", command: "node", args: ["/x/mcp.js"], env: { JINN_SESSION_ID: "s1", JINN_MCP_CAPABILITY: "secret-capability" }, mode: "optional" },
        docs: { transport: "streamableHttp", url: "https://docs.example.test/mcp", headers: { Authorization: "Bearer docs-token" } },
      },
    });
    expect(JSON.stringify(starts()[0]!.argv)).not.toMatch(/secret-capability|docs-token/);
  });

  it("projects them again into session/resume", async () => {
    const first = await ctx.engine.run(opts());
    await ctx.engine.run(opts({ resolvedMcp, resumeSessionId: first.sessionId }));
    expect(Object.keys(sent("session/resume")[0]!.config.mcpServers)).toEqual(["jinn", "docs"]);
  });

  it("sends no config when the session has no servers", async () => {
    await ctx.engine.run(opts());
    expect(sent("session/start")[0]).not.toHaveProperty("config");
  });

  it("asks the host for the sessionMcp capability, which it needs to take them, and only when there are some", async () => {
    await ctx.engine.run(opts());
    await ctx.engine.run(opts({ resolvedMcp }));
    const [without, withServers] = sent("initialize");
    expect(without!.capabilities).toEqual({ userInputDialogs: false });
    expect(withServers!.capabilities).toEqual({ userInputDialogs: false, requestedCapabilities: ["sessionMcp"] });
  });

  it("runs the turn without the servers, and says so, when the host will not grant session MCP", async () => {
    vi.stubEnv("FAKE_MUSE_NO_GRANT", "1");
    const result = await ctx.engine.run(opts({ resolvedMcp }));
    expect(result.error).toBeUndefined();
    expect(sent("session/start")[0]).not.toHaveProperty("config");
    expect(ctx.streamed.filter((d) => d.type === "status").map((d) => d.content)).toEqual(["Muse Code did not grant session MCP; running without the company tools"]);
  });
});

describe("notfound after a turn", () => {
  it("the next resume of a session the host dropped is a dead resume", async () => {
    const first = await ctx.engine.run(opts({ prompt: "x\n---\nNOTFOUND" }));
    expect(first.error).toBeUndefined();
    const second = await ctx.engine.run(opts({ resumeSessionId: first.sessionId }));
    expect(second.error).toBe(`musecode has no conversation ${first.sessionId} to resume`);
  });
});
