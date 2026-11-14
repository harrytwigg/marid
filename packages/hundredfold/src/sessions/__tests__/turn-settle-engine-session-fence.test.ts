import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import type { TurnSurface } from "../turn/types.js";

// Isolate the DB: HUNDREDFOLD_HOME must be set before importing the registry
// (SESSIONS_DB is resolved at module load).
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "hundredfold-settle-fence-"));
process.env.HUNDREDFOLD_HOME = tmp;
const reg = await import("../registry.js");
const { settleTurn } = await import("../turn/completion.js");

const ENGINE = "claude";

/** Nothing outward is under test here — only what the receipt persists. */
const silentSurface: TurnSurface = {
  started: async () => {},
  delta: () => {},
  notice: async () => {},
  reply: async () => {},
  waiting: async () => {},
  settled: async () => {},
};

function startedSession(sourceRef: string) {
  const created = reg.createSession({ engine: ENGINE, source: "web", sourceRef, model: "opus", effortLevel: "high" });
  const running = reg.beginSessionAttempt(created.id)!;
  return { id: running.id, attemptToken: running.attemptToken! };
}

describe("settleTurn fences the engine session behind the receipt", () => {
  beforeEach(async () => {
    const db = (await import("../../shared/db.js")).initDb();
    db.exec("DELETE FROM messages; DELETE FROM queue_items; DELETE FROM sessions;");
  });

  it("leaves a newer turn's engine session alone when a late recovery loses the row", async () => {
    const stale = startedSession("web:late-recovery");
    // The turn failed; its CLI answered afterwards and settles out of `error`.
    reg.updateSessionForAttempt(stale.id, stale.attemptToken, { status: "error", attemptOutcome: "failed" });
    // A newer turn takes the row first and files its own engine session.
    const fresh = reg.beginSessionAttempt(stale.id)!;
    reg.recordEngineSessionId(fresh.id, ENGINE, "fresh-native", { model: "opus" });

    const settled = await settleTurn({
      sessionId: stale.id,
      attemptToken: stale.attemptToken,
      outcome: "succeeded",
      result: "the late answer",
      engineSession: { engine: ENGINE, nativeId: "stale-native", meta: { model: "sonnet" } },
      expectedStatuses: ["error"],
      surface: silentSurface,
    });

    expect(settled).toBeUndefined();
    const after = reg.getSession(stale.id)!;
    expect(after.engineSessionId).toBe("fresh-native");
    expect(after.engineSessions?.[ENGINE]?.id).toBe("fresh-native");
    expect(after.engineSessions?.[ENGINE]?.model).toBe("opus");
  });

  it("leaves the engine session alone when the row is interrupted out from under a running turn", async () => {
    const turn = startedSession("web:interrupted-mid-turn");
    reg.recordEngineSessionId(turn.id, ENGINE, "before-interrupt", { model: "opus" });
    reg.updateSessionForAttempt(turn.id, turn.attemptToken, { status: "interrupted", attemptOutcome: "interrupted" });

    const settled = await settleTurn({
      sessionId: turn.id,
      attemptToken: turn.attemptToken,
      outcome: "succeeded",
      result: "an answer nobody is waiting for",
      engineSession: { engine: ENGINE, nativeId: "after-interrupt", meta: { model: "sonnet" } },
      surface: silentSurface,
    });

    expect(settled).toBeUndefined();
    const after = reg.getSession(turn.id)!;
    expect(after.engineSessionId).toBe("before-interrupt");
    expect(after.engineSessions?.[ENGINE]?.id).toBe("before-interrupt");
    expect(after.engineSessions?.[ENGINE]?.model).toBe("opus");
  });

  it("persists the engine session and its meta when the settle is uncontested", async () => {
    const turn = startedSession("web:uncontested");

    const settled = await settleTurn({
      sessionId: turn.id,
      attemptToken: turn.attemptToken,
      outcome: "succeeded",
      result: "the answer",
      engineSession: {
        engine: ENGINE,
        nativeId: " native-1 ",
        meta: { model: "opus", effortLevel: "high", platformContextFingerprint: "fingerprint-1" },
      },
      surface: silentSurface,
    });

    expect(settled?.engineSessionId).toBe("native-1");
    expect(reg.getEngineSessionRef(reg.getSession(turn.id)!, ENGINE)).toEqual({
      id: "native-1",
      model: "opus",
      effortLevel: "high",
      platformContextFingerprint: "fingerprint-1",
      lastSyncedAt: settled!.lastActivity,
    });
  });
});
