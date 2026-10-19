import { describe, expect, it, vi } from "vitest";
import type { EngineResult } from "../../shared/types.js";
import { runEngineAttempt } from "../turn/engine-run.js";
import { makeSession } from "./helpers/session-fixture.js";

/** A notice an engine asks for (`EngineResult.notices`) is posted once, by the turn, before it settles. */

function attempt(result: Partial<EngineResult>, failing = false) {
  const notice = vi.fn(async (_text: string) => {
    if (failing) throw new Error("surface down");
  });
  return runEngineAttempt({
    input: { session: makeSession({}), attachments: [], employee: undefined, attemptToken: "t1", config: {} } as any,
    plan: {
      engine: { run: async () => ({ result: "ok", sessionId: "s1", ...result }) as EngineResult },
      engineConfig: {}, promptToRun: "hi", runtimeSource: "web",
      prepareContext: () => ({ systemPrompt: "sys", fingerprint: "f", refresh: undefined }),
    } as any,
    surface: { notice } as any,
    heartbeat: { beat() {} } as any,
    partialStream: { finish() {}, persist() {} } as any,
    turnStartedAt: Date.now(),
    model: undefined,
  }).then((outcome) => ({ outcome, notice }));
}

describe("engine notices", () => {
  it("posts each notice the engine returned, once, and keeps the result", async () => {
    const { outcome, notice } = await attempt({ notices: ["first", "second"] });
    expect(notice.mock.calls.map((c) => c[0])).toEqual(["first", "second"]);
    expect(outcome.result.result).toBe("ok");
  });

  it("keeps the engine's result when the surface cannot take a notice", async () => {
    const { outcome, notice } = await attempt({ notices: ["first", "second"] }, true);
    expect(notice).toHaveBeenCalledTimes(2);
    expect(outcome.result.result).toBe("ok");
  });

  it("posts nothing when there are none", async () => {
    const { notice } = await attempt({});
    expect(notice).not.toHaveBeenCalled();
  });
});
