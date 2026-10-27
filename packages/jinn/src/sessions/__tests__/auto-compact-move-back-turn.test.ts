import { beforeEach, describe, expect, it, vi } from "vitest";
import { logger } from "../../shared/logger.js";

/**
 * Auto-compaction through `runTurn` for a Claude session that was moved onto a
 * stand-in account after a usage limit and is moved back by the message that
 * wakes it. That message carries a sync transcript, and the session's own
 * conversation is as long and as cold as it was before the swap, so it is
 * compacted first like any other cold session; the transcript still reaches
 * the engine, on the compacted conversation.
 */

vi.mock("../../shared/models.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../shared/models.js")>()),
  engineAvailable: () => true,
}));
vi.mock("../../shared/claude-profile-signin.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../shared/claude-profile-signin.js")>()),
  verifyLocalClaudeProfile: () => undefined,
}));
vi.mock("../claude-auth-watch.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../claude-auth-watch.js")>()),
  refuseClaudeLaunch: () => undefined,
  observeClaudeTurnOutcome: () => {},
}));

const { reg, recordingEngine, recordingSurface, configWith, coldSession, runOne, ENABLED, MINUTE } =
  await import("./helpers/auto-compact-harness.js");
const { beginEngineSubstitution, maybeRevertEngineOverride } = await import("../engine-override.js");
const { claudeProfileFromDir } = await import("../../shared/claude-profile.js");

const standIn = claudeProfileFromDir("/home/operator/.claude-standin");
const STAND_IN_ACCOUNT = `claude:${standIn.key}`;
const SIZE_BEFORE_SWAP = 540_000;

/** A long, cold session that swapped onto a stand-in account, ran a short turn
 *  there, and whose stand-in window has since ended. */
function sessionAwaitingMoveBack(sourceRef: string): string {
  const sessionId = coldSession("claude", sourceRef, SIZE_BEFORE_SWAP, 90 * MINUTE);
  const session = reg.getSession(sessionId)!;
  const attempt = reg.beginSessionAttempt(sessionId)!;
  beginEngineSubstitution({
    session: reg.getSession(sessionId)!,
    attemptToken: attempt.attemptToken!,
    config: configWith(ENABLED),
    employee: undefined,
    substitute: "claude",
    accounts: { original: "claude", substitute: STAND_IN_ACCOUNT, substituteConfigDir: standIn.dir },
    until: new Date(Date.now() + 60 * MINUTE),
    syncSince: new Date(Date.now() - 80 * MINUTE).toISOString(),
    lastError: "limit",
  });
  // The stand-in's own short conversation overwrote the meter.
  reg.recordEngineSessionId(sessionId, "claude", "standin-thread-1");
  reg.updateSession(sessionId, { lastContextTokens: 9_000, status: "idle" });
  reg.insertMessage(sessionId, "user", "a message the stand-in answered");
  const meta = reg.getSession(sessionId)!.transportMeta as Record<string, Record<string, unknown>>;
  reg.updateSession(sessionId, {
    transportMeta: { ...meta, engineOverride: { ...meta.engineOverride, until: "2020-01-01T00:00:00.000Z" } } as never,
  });
  // The dispatcher hands the session back before it starts the turn.
  expect(maybeRevertEngineOverride(reg.getSession(sessionId)!).engineSessionId).toBe(session.engineSessionId);
  return sessionId;
}

describe("auto-compaction through runTurn: the turn that moves a session back from a stand-in account", () => {
  beforeEach(async () => {
    const db = (await import("../../shared/db.js")).initDb();
    db.exec("DELETE FROM messages; DELETE FROM queue_items; DELETE FROM sessions;");
  });

  it("compacts the session's own long, cold conversation first, then runs the sync turn on it", async () => {
    const sessionId = sessionAwaitingMoveBack("web:move-back-compact");
    const { engine, calls } = recordingEngine("claude", async (_opts, call) => call === 1
      ? { sessionId: "claude-thread-1", result: "", cost: 0.4, compaction: { preTokens: SIZE_BEFORE_SWAP, postTokens: 17_000 } }
      : { sessionId: "claude-thread-1", result: "done", contextTokens: 21_000 });
    const { surface, seen } = recordingSurface();

    await runOne(engine, sessionId, "carry on", surface, configWith(ENABLED));

    expect(calls).toEqual([
      { prompt: expect.stringMatching(/^\/compact Automatic compaction: this session sat idle /), resumeSessionId: "claude-thread-1" },
      { prompt: expect.stringContaining("another Claude account"), resumeSessionId: "claude-thread-1" },
    ]);
    expect(calls[1]!.prompt).toContain("carry on");
    expect(seen.notices).toEqual([expect.stringContaining("Auto-compacted this cold session")]);
    expect(seen.receipts.map((r) => r.result)).toEqual(["done"]);

    const settled = reg.getSession(sessionId)!;
    expect(settled.lastContextTokens).toBe(21_000);
    // The sync turn settled cleanly, so its markers are spent.
    expect(settled.transportMeta?.claudeSyncSince).toBeUndefined();
  });

  it("says at info level why a long session was left alone, and keeps a routine skip quiet", async () => {
    const info = vi.spyOn(logger, "info");
    const { engine } = recordingEngine("claude", async () => ({ sessionId: "claude-thread-1", result: "done", contextTokens: 21_000 }));

    // A real engine switch to Claude: its conversation is behind the chat, so it is skipped.
    const switched = coldSession("claude", "web:skip-logged", SIZE_BEFORE_SWAP, 90 * MINUTE);
    reg.updateSession(switched, { transportMeta: { engineSyncTarget: "claude", engineSyncSince: new Date(Date.now() - MINUTE).toISOString() } as never });
    await runOne(engine, switched, "carry on", recordingSurface().surface, configWith(ENABLED));
    expect(info).toHaveBeenCalledWith(`[auto-compact] session=${switched} engine=claude outcome=skipped skip=engine-switch context=${SIZE_BEFORE_SWAP}`);

    // A warm one is the ordinary case and stays at debug.
    info.mockClear();
    const warm = coldSession("claude", "web:skip-quiet", SIZE_BEFORE_SWAP, MINUTE);
    await runOne(engine, warm, "carry on", recordingSurface().surface, configWith(ENABLED));
    expect(info.mock.calls.filter(([line]) => String(line).startsWith("[auto-compact]"))).toEqual([]);
    info.mockRestore();
  });
});
