import { describe, expect, it, vi } from "vitest";

vi.mock("../../shared/logger.js", () => ({ logger: { warn: vi.fn(), debug: vi.fn(), info: vi.fn(), error: vi.fn() } }));
vi.mock("../../sessions/employee-env.js", () => ({ employeeSessionEnv: () => ({}) }));

import { isDeadSessionError } from "../../shared/rateLimit.js";
import { isLostConversationError } from "../../shared/process-start.js";
import { MusecodeEngine } from "../musecode.js";
import { MUSECODE_NEVER_STARTED } from "../musecode-watchdog.js";
import { ctx, opts, useFakeMuse } from "./helpers/fake-muse-harness.js";

useFakeMuse();

describe("a resume the host refuses because it cannot read the session's log", () => {
  it("is a lost conversation, with no turn sent, so the runner starts afresh", async () => {
    const first = await ctx.engine.run(opts());
    vi.stubEnv("FAKE_MUSE_REFUSED", "1");
    const result = await ctx.engine.run(opts({ resumeSessionId: first.sessionId }));
    expect(result).toEqual({ sessionId: first.sessionId, result: "", error: `musecode has no conversation ${first.sessionId} to resume` });
    expect(isDeadSessionError(result)).toBe(true);
    expect(isLostConversationError(result.error!, first.sessionId)).toBe(true);
  });
});

describe("a turn the host accepts and never speaks of", () => {
  const SILENT = "x\n---\nSILENT";

  it("is given up on after the bound, and is a lost conversation when the history could not be read at resume", async () => {
    ctx.engine = new MusecodeEngine({ firstEventTimeoutMs: 400 });
    const first = await ctx.engine.run(opts());
    vi.stubEnv("FAKE_MUSE_PROJECTION_UNAVAILABLE", "1");
    const started = Date.now();
    const result = await ctx.engine.run(opts({ prompt: SILENT, resumeSessionId: first.sessionId }));
    expect(Date.now() - started).toBeLessThan(15_000);
    expect(result).toEqual({ sessionId: first.sessionId, result: "", error: `musecode has no conversation ${first.sessionId} to resume` });
    expect(isDeadSessionError(result)).toBe(true);
    expect(ctx.streamed.some((d) => d.type === "status" && /projectionUnavailable/.test(d.content ?? ""))).toBe(true);
  }, 30_000);

  it("is a failure on an intact conversation when the history was readable", async () => {
    ctx.engine = new MusecodeEngine({ firstEventTimeoutMs: 400 });
    const first = await ctx.engine.run(opts());
    const result = await ctx.engine.run(opts({ prompt: SILENT, resumeSessionId: first.sessionId }));
    expect(result).toMatchObject({ sessionId: first.sessionId, result: "", error: MUSECODE_NEVER_STARTED, numTurns: 1, conversationIntact: true });
    expect(isDeadSessionError(result)).toBe(false);
  }, 30_000);

  it("does not touch a turn whose host has spoken, even one that then hangs, however short the bound", async () => {
    ctx.engine = new MusecodeEngine({ firstEventTimeoutMs: 100 });
    let settled = false;
    const run = ctx.engine.run(opts({ prompt: "x\n---\nHANG" })).finally(() => { settled = true; });
    await new Promise((resolve) => setTimeout(resolve, 1500));
    expect(settled).toBe(false);
    ctx.engine.kill("s1", "Interrupted: test");
    expect((await run).error).toMatch(/^Interrupted/);
  }, 30_000);

  it("does not touch an ordinary turn", async () => {
    ctx.engine = new MusecodeEngine({ firstEventTimeoutMs: 100 });
    const result = await ctx.engine.run(opts({ prompt: "hello there" }));
    expect(result.error).toBeUndefined();
  }, 30_000);
});
