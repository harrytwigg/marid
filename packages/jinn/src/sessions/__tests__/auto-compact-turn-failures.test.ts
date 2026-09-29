import { beforeEach, describe, expect, it, vi } from "vitest";
import type { EngineResult } from "../../shared/types.js";

/**
 * Auto-compaction through `runTurn` when the compaction does not succeed:
 * the message still runs, and a preemption ends the turn where it stands.
 */

vi.mock("../../shared/models.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../shared/models.js")>()),
  engineAvailable: () => true,
}));

const { reg, isAutoCompacting, supersedeRunningTurn, readUnseenInterruptedPrompts, recordingEngine, recordingSurface, configWith, coldSession, runOne, answered, ENABLED, MINUTE } =
  await import("./helpers/auto-compact-harness.js");

describe("auto-compaction through runTurn: when it does not succeed", () => {
  beforeEach(async () => {
    const db = (await import("../../shared/db.js")).initDb();
    db.exec("DELETE FROM messages; DELETE FROM queue_items; DELETE FROM sessions;");
  });
  it.each([
    ["an error", { sessionId: "", result: "", error: "PTY spawn failed" }, "PTY spawn failed"],
    ["no confirmation", { sessionId: "claude-thread-1", result: "" }, "the engine never confirmed a compaction"],
    ["a usage limit", { sessionId: "", result: "", error: "You've hit your usage limit · resets 3pm" }, "the engine is at its usage limit"],
  ])("still runs the message after a compaction that ends in %s", async (_label, compactionResult, reason) => {
    const sessionId = coldSession("claude", `web:ac-fail-${reason.length}`, 180_000, 30 * MINUTE);
    const { engine, calls } = recordingEngine("claude", async (_opts, call) => call === 1
      ? compactionResult as EngineResult
      : answered("claude-thread-1"));
    const { surface, seen } = recordingSurface();

    await runOne(engine, sessionId, "carry on", surface, configWith(ENABLED));

    expect(calls.map((c) => c.prompt)).toEqual([expect.stringMatching(/^\/compact /), "carry on"]);
    expect(seen.notices).toEqual([expect.stringContaining(reason)]);
    expect(seen.notices[0]).toContain("the next message runs on the full context");
    expect(seen.receipts[0]!.result).toBe("done");
  });

  it("still runs the message when the engine throws during the compaction", async () => {
    const sessionId = coldSession("claude", "web:ac-throw", 180_000, 30 * MINUTE);
    const { engine, calls } = recordingEngine("claude", async (_opts, call) => {
      if (call === 1) throw new Error("boom");
      return answered("claude-thread-1");
    });
    const { surface, seen } = recordingSurface();

    await runOne(engine, sessionId, "carry on", surface, configWith(ENABLED));

    expect(calls.map((c) => c.prompt)).toEqual([expect.stringMatching(/^\/compact /), "carry on"]);
    expect(seen.notices).toEqual([expect.stringContaining("(boom)")]);
    expect(isAutoCompacting(sessionId)).toBe(false);
  });

  it("marks the session as auto-compacting only while the compaction runs", async () => {
    const sessionId = coldSession("claude", "web:ac-flag", 180_000, 30 * MINUTE);
    const during: boolean[] = [];
    const { engine } = recordingEngine("claude", async (_opts, call) => {
      during.push(isAutoCompacting(sessionId));
      return call === 1
        ? { sessionId: "claude-thread-1", result: "", compaction: { preTokens: 180_000 } }
        : answered("claude-thread-1");
    });

    await runOne(engine, sessionId, "carry on", recordingSurface().surface, configWith(ENABLED));

    expect(during).toEqual([true, false]);
  });

  it("a newer message that takes the turn mid-compaction ends it there, holding the prompt for the next turn", async () => {
    const sessionId = coldSession("claude", "web:ac-preempt", 180_000, 30 * MINUTE);
    const { engine, calls } = recordingEngine("claude", async () => {
      supersedeRunningTurn(reg.getSession(sessionId)!);
      return { sessionId: "", result: "", error: "Interrupted by a new message" };
    });
    const { surface, seen } = recordingSurface();

    await runOne(engine, sessionId, "the original message", surface, configWith(ENABLED));

    expect(calls).toHaveLength(1);
    expect(seen.notices).toEqual([]);
    const settled = reg.getSession(sessionId)!;
    expect(settled.status).toBe("interrupted");
    expect(readUnseenInterruptedPrompts(settled)).toEqual(["the original message"]);
  });
});
