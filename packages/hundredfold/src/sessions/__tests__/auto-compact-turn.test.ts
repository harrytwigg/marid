import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Auto-compaction of a long, cache-cold session, end to end through
 * `runTurn` — the one path every transport's turn takes. What the engine is
 * handed and in what order, what the chat sees, and what the session records.
 * The failure paths are in auto-compact-turn-failures.test.ts.
 */

vi.mock("../../shared/models.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../shared/models.js")>()),
  engineAvailable: () => true,
}));

const { reg, isAutoCompacting, recordingEngine, recordingSurface, configWith, coldSession, runOne, answered, ENABLED, MINUTE } =
  await import("./helpers/auto-compact-harness.js");

describe("auto-compaction through runTurn", () => {
  beforeEach(async () => {
    const db = (await import("../../shared/db.js")).initDb();
    db.exec("DELETE FROM messages; DELETE FROM queue_items; DELETE FROM sessions;");
  });

  it("is off by default: a long, cold session runs its message exactly as before", async () => {
    const sessionId = coldSession("claude", "web:ac-default", 180_000, 30 * MINUTE);
    const { engine, calls } = recordingEngine("claude", async () => answered("claude-thread-1"));
    const { surface, seen } = recordingSurface();

    await runOne(engine, sessionId, "carry on", surface, configWith(undefined));

    expect(calls.map((c) => c.prompt)).toEqual(["carry on"]);
    expect(seen.notices).toEqual([]);
    expect(seen.deltas.filter((d) => d.type === "status")).toEqual([]);
  });

  it("stays off when the block is present but not enabled", async () => {
    const sessionId = coldSession("claude", "web:ac-disabled", 180_000, 30 * MINUTE);
    const { engine, calls } = recordingEngine("claude", async () => answered("claude-thread-1"));
    const { surface } = recordingSurface();

    await runOne(engine, sessionId, "carry on", surface, configWith({ ...ENABLED, enabled: false }));

    expect(calls.map((c) => c.prompt)).toEqual(["carry on"]);
  });

  it("on Claude, compacts a long cold session first, then runs the message on the same thread", async () => {
    const sessionId = coldSession("claude", "web:ac-claude", 180_000, 30 * MINUTE);
    const { engine, calls } = recordingEngine("claude", async (_opts, call) => call === 1
      ? { sessionId: "claude-thread-1", result: "", cost: 0.42, compaction: { preTokens: 180_000, postTokens: 9_000 }, contextTokens: 9_000 }
      : answered("claude-thread-1"));
    const { surface, seen } = recordingSurface();

    await runOne(engine, sessionId, "carry on", surface, configWith(ENABLED));

    expect(calls).toHaveLength(2);
    expect(calls[0]!.prompt).toMatch(/^\/compact Automatic compaction: /);
    expect(calls[0]!.prompt).not.toContain("\n");
    expect(calls[0]!.resumeSessionId).toBe("claude-thread-1");
    expect(calls[1]).toEqual({ prompt: "carry on", resumeSessionId: "claude-thread-1" });

    // Status while compacting, a notice with the sizes, then the turn settles once.
    expect(seen.events).toEqual(["started", "delta:status", "notice", "settled"]);
    expect(seen.deltas[0]!.content).toMatch(/idle 30m with 180k tokens of context \(past its 5m cache window\)/);
    expect(seen.notices).toEqual(["🗜️ Auto-compacted this cold session before the next message (180k tokens → 9.0k tokens; idle 30m, past the 5m cache window)."]);
    expect(seen.receipts).toHaveLength(1);
    expect(seen.receipts[0]!.result).toBe("done");

    const settled = reg.getSession(sessionId)!;
    expect(settled.status).toBe("idle");
    expect(settled.lastContextTokens).toBe(3_000);
    // The compaction is paid for in the ledger, alongside the turn.
    expect(settled.totalCost).toBeCloseTo(0.42);
    expect(isAutoCompacting(sessionId)).toBe(false);
  });

  // A wake reaches the engine as a notification: a Todo mention, a child's
  // callback, another session's message. Each is a turn like any other.
  it.each([
    ["a Todo mention", "🏷️ You were tagged in this comment on Todo JIN-1, \"cold wake\" (/todos/JIN-1).\n\noperator wrote:\n@sleeper any news?"],
    ["a child's callback", "📩 Employee \"worker\" replied in child session child-1.\n\nReply:\nshipped\n\nTo read the reply in context: read_session { sessionId: \"child-1\", last: N }"],
    ["another session's message", "📨 Message from session peer-1 (web) [hop 1/12]:\n\nare you free?\n\nTo reply: send_to_session { sessionId: \"peer-1\" }."],
  ])("compacts a long cold session first when it is woken by %s", async (_wake, prompt) => {
    const sessionId = coldSession("claude", `web:ac-wake-${prompt.length}`, 180_000, 30 * MINUTE);
    const { engine, calls } = recordingEngine("claude", async (_opts, call) => call === 1
      ? { sessionId: "claude-thread-1", result: "", compaction: { preTokens: 180_000, postTokens: 9_000 }, contextTokens: 9_000 }
      : answered("claude-thread-1"));
    const { surface, seen } = recordingSurface();

    await runOne(engine, sessionId, prompt, surface, configWith(ENABLED));

    expect(calls.map((c) => c.prompt)).toEqual([expect.stringMatching(/^\/compact /), prompt]);
    expect(seen.notices).toEqual([expect.stringContaining("Auto-compacted this cold session")]);
  });

  it("on opencode, compacts the same way (summarize via /compact)", async () => {
    const sessionId = coldSession("opencode", "web:ac-opencode", 120_000, 10 * MINUTE);
    const { engine, calls } = recordingEngine("opencode", async (_opts, call) => call === 1
      ? { sessionId: "opencode-thread-1", result: "", compaction: { preTokens: 120_000 } }
      : answered("opencode-thread-1"));
    const { surface, seen } = recordingSurface();

    await runOne(engine, sessionId, "next step please", surface, configWith(ENABLED, "opencode"));

    expect(calls.map((c) => c.prompt)).toEqual([expect.stringMatching(/^\/compact /), "next step please"]);
    expect(seen.notices).toEqual([expect.stringContaining("(it was 120k tokens; idle 10m")]);
  });

  it("does nothing extra below the size threshold", async () => {
    const sessionId = coldSession("claude", "web:ac-small", 20_000, 30 * MINUTE);
    const { engine, calls } = recordingEngine("claude", async () => answered("claude-thread-1"));
    const { surface, seen } = recordingSurface();

    await runOne(engine, sessionId, "carry on", surface, configWith(ENABLED));

    expect(calls.map((c) => c.prompt)).toEqual(["carry on"]);
    expect(seen.notices).toEqual([]);
  });

  it("does nothing extra inside the cache window", async () => {
    const sessionId = coldSession("claude", "web:ac-warm", 180_000, 2 * MINUTE);
    const { engine, calls } = recordingEngine("claude", async () => answered("claude-thread-1"));
    const { surface } = recordingSurface();

    await runOne(engine, sessionId, "carry on", surface, configWith(ENABLED));

    expect(calls.map((c) => c.prompt)).toEqual(["carry on"]);
  });

  it("never compacts twice: the turn after a compaction runs straight through", async () => {
    const sessionId = coldSession("claude", "web:ac-once", 180_000, 30 * MINUTE);
    const { engine, calls } = recordingEngine("claude", async (_opts, call) => call === 1
      ? { sessionId: "claude-thread-1", result: "", compaction: { preTokens: 180_000, postTokens: 9_000 }, contextTokens: 9_000 }
      : answered("claude-thread-1"));

    await runOne(engine, sessionId, "first", recordingSurface().surface, configWith(ENABLED));
    await runOne(engine, sessionId, "second", recordingSurface().surface, configWith(ENABLED));

    expect(calls.map((c) => c.prompt)).toEqual([expect.stringMatching(/^\/compact /), "first", "second"]);
  });

  it("records the compaction itself, so a message turn that then fails does not leave it looking cold", async () => {
    const sessionId = coldSession("claude", "web:ac-then-fail", 180_000, 30 * MINUTE);
    const { engine, calls } = recordingEngine("claude", async (_opts, call) => {
      if (call === 1) return { sessionId: "claude-thread-1", result: "", compaction: { preTokens: 180_000, postTokens: 9_000 }, contextTokens: 9_000 };
      if (call === 2) return { sessionId: "claude-thread-1", result: "", error: "the tool loop gave up", cost: 0.01, numTurns: 1 };
      return answered("claude-thread-1");
    });

    await runOne(engine, sessionId, "first", recordingSurface().surface, configWith(ENABLED));
    const afterFailure = reg.getSession(sessionId)!;
    expect(afterFailure.status).toBe("error");
    expect(afterFailure.lastContextTokens).toBe(9_000);
    expect(Date.parse(afterFailure.engineSessions!.claude!.lastSyncedAt!)).toBeGreaterThan(Date.now() - MINUTE);

    await runOne(engine, sessionId, "retry", recordingSurface().surface, configWith(ENABLED));
    expect(calls.map((c) => c.prompt)).toEqual([expect.stringMatching(/^\/compact /), "first", "retry"]);
  });

  it("does not compact in front of an operator's own /compact", async () => {
    const sessionId = coldSession("claude", "web:ac-explicit", 180_000, 30 * MINUTE);
    const { engine, calls } = recordingEngine("claude", async () => ({
      sessionId: "claude-thread-1", result: "", compaction: { preTokens: 180_000, postTokens: 9_000 },
    }));

    await runOne(engine, sessionId, "/compact keep ids", recordingSurface().surface, configWith(ENABLED));

    expect(calls.map((c) => c.prompt)).toEqual(["/compact keep ids"]);
  });

  it("names child sessions still in flight in the compaction's focus", async () => {
    const sessionId = coldSession("claude", "web:ac-children", 180_000, 30 * MINUTE);
    const child = reg.createSession({ engine: "claude", source: "web", sourceRef: "web:ac-child", parentSessionId: sessionId, employee: "junior-developer" });
    reg.beginSessionAttempt(child.id);
    const { engine, calls } = recordingEngine("claude", async (_opts, call) => call === 1
      ? { sessionId: "claude-thread-1", result: "", compaction: { preTokens: 180_000, postTokens: 9_000 } }
      : answered("claude-thread-1"));

    await runOne(engine, sessionId, "child reported", recordingSurface().surface, configWith(ENABLED));

    expect(calls[0]!.prompt).toContain(`Child sessions still in flight, whose results will arrive after this: ${child.id} (junior-developer).`);
  });
});
