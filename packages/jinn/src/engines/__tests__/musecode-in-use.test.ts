import { describe, expect, it, vi } from "vitest";

vi.mock("../../shared/logger.js", () => ({ logger: { warn: vi.fn(), debug: vi.fn(), info: vi.fn(), error: vi.fn() } }));
vi.mock("../../sessions/employee-env.js", () => ({ employeeSessionEnv: () => ({}) }));

import { isDeadSessionError } from "../../shared/rateLimit.js";
import { isLostConversationError } from "../../shared/process-start.js";
import { MusecodeEngine } from "../musecode.js";
import { MUSECODE_SESSION_IN_USE } from "../musecode-run.js";
import { ctx, methods, opts, useFakeMuse } from "./helpers/fake-muse-harness.js";

useFakeMuse();

describe("a session the terminal view holds", () => {
  it("is said to be open in the terminal, not lost, and keeps its resume id", async () => {
    const first = await ctx.engine.run(opts());
    vi.stubEnv("FAKE_MUSE_IN_USE", "1");
    const result = await ctx.engine.run(opts({ resumeSessionId: first.sessionId }));
    expect(result).toMatchObject({
      sessionId: first.sessionId,
      result: "",
      error: "The session is open in the terminal view; close it to continue.",
      numTurns: 1,
    });
    expect(result.error).toBe(MUSECODE_SESSION_IN_USE);
    expect(isDeadSessionError(result)).toBe(false);
    expect(isLostConversationError(result.error!, first.sessionId)).toBe(false);
    expect(methods().filter((m) => m === "turn/start")).toHaveLength(1); // the first run's, none for the refused one
  });

  it("asks for the view to be released before it resumes, and only for a conversation that exists", async () => {
    const releaseView = vi.fn(async () => {});
    ctx.engine = new MusecodeEngine({ releaseView });
    const first = await ctx.engine.run(opts());
    expect(releaseView).not.toHaveBeenCalled();
    await ctx.engine.run(opts({ resumeSessionId: first.sessionId }));
    expect(releaseView).toHaveBeenCalledExactlyOnceWith("s1");
  });

  it("still runs the turn when releasing the view fails", async () => {
    ctx.engine = new MusecodeEngine({ releaseView: async () => { throw new Error("boom"); } });
    const first = await ctx.engine.run(opts());
    const result = await ctx.engine.run(opts({ resumeSessionId: first.sessionId }));
    expect(result.error).toBeUndefined();
    expect(result.result).toContain("hello");
  });
});
