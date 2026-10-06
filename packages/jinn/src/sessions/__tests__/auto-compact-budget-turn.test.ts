import { beforeEach, describe, expect, it, vi } from "vitest";
import type { JinnConfig } from "../../shared/types.js";

/**
 * The context budget (`autoCompact.maxContextTokens`), end to end through
 * `runTurn` on an opencode server-mode session: a session that keeps taking
 * turns, so its cache never goes cold, is compacted once its context reaches
 * the budget, and carries on from the summary. The cold-cache trigger is in
 * auto-compact-turn.test.ts.
 */

vi.mock("../../shared/models.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../shared/models.js")>()),
  engineAvailable: () => true,
}));

const { reg, recordingEngine, recordingSurface, configWith, coldSession, runOne, ENABLED, MINUTE } =
  await import("./helpers/auto-compact-harness.js");
const { AUTO_COMPACT_BUDGET_HOLD_KEY } = await import("../../shared/auto-compact-config.js");
const { beginEngineSubstitution } = await import("../engine-override.js");

const BUDGET = { ...ENABLED, maxContextTokens: 300_000 };
const budgetConfig = () => configWith(BUDGET, "opencode");

/** A warm opencode session: last turn a minute ago, well inside the window. */
const warmSession = (sourceRef: string, contextTokens: number) => coldSession("opencode", sourceRef, contextTokens, MINUTE);

const summarized = (preTokens: number) => ({ sessionId: "opencode-thread-1", result: "", cost: 0.02, compaction: { preTokens } });
const answered = (contextTokens: number) => ({ sessionId: "opencode-thread-1", result: "done", contextTokens });

const hold = (sessionId: string) => reg.getSession(sessionId)!.transportMeta?.[AUTO_COMPACT_BUDGET_HOLD_KEY];
const held = (sessionId: string) => hold(sessionId) !== undefined;
const promptsOf = (calls: Array<{ prompt: string }>) => calls.map((c) => c.prompt.startsWith("/compact") ? "/compact" : c.prompt);

/** An engine that answers each message turn with the next scripted reading. */
function scriptedEngine(readings: number[], compaction = () => summarized(320_000)) {
  let reading = 0;
  return recordingEngine("opencode", async (opts) =>
    opts.prompt.startsWith("/compact") ? compaction() : answered(readings[reading++]!));
}

describe("the context budget through runTurn (opencode, server mode)", () => {
  beforeEach(async () => {
    const db = (await import("../../shared/db.js")).initDb();
    db.exec("DELETE FROM messages; DELETE FROM queue_items; DELETE FROM sessions;");
  });

  it("compacts a warm session that has crossed its budget, then runs the message on the summary", async () => {
    const sessionId = warmSession("web:budget-crossed", 320_000);
    const { engine, calls } = recordingEngine("opencode", async (_opts, call) => call === 1 ? summarized(320_000) : answered(41_000));
    const { surface, seen } = recordingSurface();

    await runOne(engine, sessionId, "next step please", surface, budgetConfig());

    expect(calls).toEqual([
      { prompt: expect.stringMatching(/^\/compact Automatic compaction: this session's context has passed its budget /), resumeSessionId: "opencode-thread-1" },
      { prompt: "next step please", resumeSessionId: "opencode-thread-1" },
    ]);
    expect(seen.events).toEqual(["started", "delta:status", "notice", "settled"]);
    expect(seen.deltas[0]!.content).toBe("🗜️ Session at 320k tokens of context (past its budget of 300k tokens) — compacting it before the next message…");
    expect(seen.notices).toEqual(["🗜️ Auto-compacted this session before the next message (it was 320k tokens; past its context budget of 300k tokens)."]);
    expect(seen.receipts.map((r) => r.result)).toEqual(["done"]);

    const settled = reg.getSession(sessionId)!;
    expect(settled.status).toBe("idle");
    expect(settled.lastContextTokens).toBe(41_000);
    expect(settled.totalCost).toBeCloseTo(0.02);
  });

  it("then runs straight through while the session stays under the budget", async () => {
    const sessionId = warmSession("web:budget-after", 320_000);
    const { engine, calls } = recordingEngine("opencode", async (_opts, call) => call === 1 ? summarized(320_000) : answered(41_000 + call));

    await runOne(engine, sessionId, "first", recordingSurface().surface, budgetConfig());
    // opencode reports no size after a compaction: the floor waits for a reading.
    expect(hold(sessionId)).toEqual({ floor: null, engine: "opencode" });
    await runOne(engine, sessionId, "second", recordingSurface().surface, budgetConfig());

    expect(calls.map((c) => c.prompt)).toEqual([expect.stringMatching(/^\/compact /), "first", "second"]);
    // The second turn read the context under the budget, so the hold is gone.
    expect(held(sessionId)).toBe(false);
  });

  it("holds a session that lands over its budget until it grows a quarter of the budget past that, then compacts again", async () => {
    const sessionId = warmSession("web:budget-floor", 320_000);
    const { engine, calls } = scriptedEngine([310_000, 330_000, 400_000, 60_000, 70_000]);
    const config = budgetConfig();

    // Compacts; the message turn lands at 310k, over the budget.
    await runOne(engine, sessionId, "one", recordingSurface().surface, config);
    // 310k is the floor: no compaction in front of this turn, which reads 330k...
    await runOne(engine, sessionId, "two", recordingSurface().surface, config);
    expect(hold(sessionId)).toEqual({ floor: 310_000, engine: "opencode" });
    // ...nor in front of this one (330k < 385k), which reads 400k.
    await runOne(engine, sessionId, "three", recordingSurface().surface, config);
    // 400k is past 310k + 75k: compact again, and this time it lands under.
    await runOne(engine, sessionId, "four", recordingSurface().surface, config);
    await runOne(engine, sessionId, "five", recordingSurface().surface, config);

    expect(promptsOf(calls)).toEqual(["/compact", "one", "two", "three", "/compact", "four", "five"]);
    expect(held(sessionId)).toBe(false);
  });

  it("re-arms on growth, so a session that keeps growing past its budget keeps being compacted", async () => {
    const sessionId = warmSession("web:budget-growth", 320_000);
    const { engine, calls } = scriptedEngine([310_000, 400_000, 600_000, 900_000]);
    const config = budgetConfig();

    for (const prompt of ["one", "two", "three", "four"]) await runOne(engine, sessionId, prompt, recordingSurface().surface, config);
    await runOne(engine, sessionId, "five", recordingSurface().surface, config);

    // 320k compacts; 310k holds (floor 310k); 400k compacts; 600k holds (floor 600k); 900k compacts.
    expect(promptsOf(calls)).toEqual(["/compact", "one", "two", "/compact", "three", "four", "/compact", "five"]);
  });

  it("on opencode, takes a heavy turn's reading as the floor, and lowers it when the session comes back down", async () => {
    const sessionId = warmSession("web:budget-floor-down", 320_000);
    const { engine, calls } = scriptedEngine([600_000, 320_000, 400_000, 50_000]);
    const config = budgetConfig();

    // Compacts; opencode reports no size, and the heavy message turn reads 600k: floor 600k.
    await runOne(engine, sessionId, "one", recordingSurface().surface, config);
    // Held at 600k; this turn comes back down to 320k (the engine's own compaction, say).
    await runOne(engine, sessionId, "two", recordingSurface().surface, config);
    expect(hold(sessionId)).toEqual({ floor: 600_000, engine: "opencode" });
    // 320k lowers the floor; no compaction yet (320k < 395k). This turn reads 400k.
    await runOne(engine, sessionId, "three", recordingSurface().surface, config);
    expect(hold(sessionId)).toEqual({ floor: 320_000, engine: "opencode" });
    // 400k is past 320k + 75k: compact.
    await runOne(engine, sessionId, "four", recordingSurface().surface, config);

    expect(promptsOf(calls)).toEqual(["/compact", "one", "two", "three", "/compact", "four"]);
  });

  it("sets no hold when the engine reports landing under the budget, so a heavy turn after it is compacted next time", async () => {
    const sessionId = coldSession("claude", "web:budget-claude", 320_000, MINUTE);
    let reading = 0;
    const readings = [310_000, 20_000];
    const { engine, calls } = recordingEngine("claude", async (opts) => opts.prompt.startsWith("/compact")
      ? { sessionId: "claude-thread-1", result: "", compaction: { preTokens: 320_000, postTokens: 9_000 }, contextTokens: 9_000 }
      : { sessionId: "claude-thread-1", result: "done", contextTokens: readings[reading++]! });
    const config = configWith(BUDGET, "claude");

    await runOne(engine, sessionId, "heavy", recordingSurface().surface, config);
    expect(held(sessionId)).toBe(false);
    await runOne(engine, sessionId, "next", recordingSurface().surface, config);

    expect(promptsOf(calls)).toEqual(["/compact", "heavy", "/compact", "next"]);
  });

  it("leaves a warm session alone when no budget is set, however long", async () => {
    const sessionId = warmSession("web:budget-unset", 900_000);
    const { engine, calls } = recordingEngine("opencode", async () => answered(901_000));

    await runOne(engine, sessionId, "carry on", recordingSurface().surface, configWith(ENABLED, "opencode"));

    expect(calls.map((c) => c.prompt)).toEqual(["carry on"]);
  });

  it("does nothing in run mode, where opencode has no compaction to call", async () => {
    const sessionId = warmSession("web:budget-run-mode", 320_000);
    const { engine, calls } = recordingEngine("opencode", async () => answered(321_000));
    const config = budgetConfig();
    (config.engines.opencode as NonNullable<JinnConfig["engines"]["opencode"]>).mode = "run";

    await runOne(engine, sessionId, "carry on", recordingSurface().surface, config);

    expect(calls.map((c) => c.prompt)).toEqual(["carry on"]);
  });

  it("runs the message on the full context when the compaction fails, and tries again next turn", async () => {
    const sessionId = warmSession("web:budget-failed", 320_000);
    const { engine, calls } = recordingEngine("opencode", async (opts, call) => {
      if (call === 1) return { sessionId: "opencode-thread-1", result: "", error: "opencode compaction failed: summarize answered false" };
      return opts.prompt.startsWith("/compact") ? summarized(330_000) : answered(330_000);
    });
    const { surface, seen } = recordingSurface();

    await runOne(engine, sessionId, "first", surface, budgetConfig());
    expect(seen.notices).toEqual(["⚠️ Auto-compaction of this session didn't complete (opencode compaction failed: summarize answered false), so the next message runs on the full context."]);
    // A failed compaction sets no hold.
    expect(held(sessionId)).toBe(false);

    await runOne(engine, sessionId, "second", recordingSurface().surface, budgetConfig());
    expect(calls.map((c) => c.prompt.startsWith("/compact") ? "/compact" : c.prompt)).toEqual(["/compact", "first", "/compact", "second"]);
  });

  it("keeps a hold written earlier in the turn when a rate limit hands the turn to another engine", () => {
    const sessionId = warmSession("web:budget-fallback", 320_000);
    const started = reg.beginSessionAttempt(sessionId)!;
    // The turn's snapshot predates the hold its auto-compaction then wrote.
    const snapshot = reg.getSession(sessionId)!;
    reg.updateSession(sessionId, { transportMeta: { [AUTO_COMPACT_BUDGET_HOLD_KEY]: { floor: 310_000, engine: "opencode" } } });

    const substituted = beginEngineSubstitution({
      session: snapshot, attemptToken: started.attemptToken!, config: budgetConfig(), employee: undefined,
      substitute: "claude", until: new Date(Date.now() + 60 * MINUTE), syncSince: new Date().toISOString(), lastError: "usage limit",
    });

    expect(substituted).toBeDefined();
    const meta = reg.getSession(sessionId)!.transportMeta!;
    expect(meta[AUTO_COMPACT_BUDGET_HOLD_KEY]).toEqual({ floor: 310_000, engine: "opencode" });
    expect(meta.engineOverride).toMatchObject({ originalEngine: "opencode" });
  });
});
