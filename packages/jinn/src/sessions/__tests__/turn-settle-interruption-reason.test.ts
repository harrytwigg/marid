import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { TurnRun, TurnSurface } from "../turn/types.js";
import type { EngineAttempt } from "../turn/engine-run.js";

/**
 * A turn settled as a quiet preemption reports nothing upward, but the session
 * row is the only place anyone can later read why it stopped. It used to say a
 * bare "Interrupted" whatever the engine had said ("claude process exited (code
 * 1…)", "session reset", …), so an automation reading it back could not tell a
 * crash from a stop.
 */

vi.mock("../../shared/logger.js", () => ({
  logger: { warn: vi.fn(), debug: vi.fn(), info: vi.fn(), error: vi.fn() },
}));

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "jinn-settle-interruption-"));
process.env.JINN_HOME = tmp;
const reg = await import("../registry.js");
const { settleAnsweredTurn } = await import("../turn/settle.js");
const { logger } = await import("../../shared/logger.js");

const settledReports: Array<{ error: string | null }> = [];
const surface: TurnSurface = {
  started: async () => {},
  delta: () => {},
  notice: async () => {},
  reply: async () => {},
  waiting: async () => {},
  settled: async (report) => { settledReports.push({ error: report.error ?? null }); },
};

function runFor(error: string | undefined): { run: TurnRun; attempt: EngineAttempt } {
  const created = reg.createSession({ engine: "claude", source: "cron", sourceRef: `cron:test:${Math.random()}`, model: "sonnet" });
  const session = reg.beginSessionAttempt(created.id)!;
  const run = {
    input: { session, attemptToken: session.attemptToken!, prompt: "do the thing", attachments: [], config: { engines: {} } },
    plan: { ok: true, engineName: "claude" },
    surface,
    heartbeat: { stop: () => {} },
    partialStream: { write: () => {} },
    turnStartedAt: Date.now(),
    terminalFields: () => ({}),
  } as unknown as TurnRun;
  const attempt = {
    result: { sessionId: "native-1", result: "", durationMs: 412, ...(error ? { error } : {}) },
    fingerprint: "fp",
    contextRefresh: undefined,
    systemPrompt: "",
  } as EngineAttempt;
  return { run, attempt };
}

const preempted = { quietPreempted: true, streamedThrough: 0, superseded: false, enginePromptRead: false };

describe("an interrupted turn keeps the engine's reason", () => {
  beforeEach(async () => {
    const db = (await import("../../shared/db.js")).initDb();
    db.exec("DELETE FROM messages; DELETE FROM queue_items; DELETE FROM sessions;");
    settledReports.length = 0;
    vi.mocked(logger.info).mockClear();
  });

  it("records it as the session's last error and logs it, but reports no error upward", async () => {
    const reason = "Interrupted: claude process exited (code 1, signal 0)";
    const { run, attempt } = runFor(reason);
    await settleAnsweredTurn(run, attempt, "sonnet", preempted);

    expect(reg.getSession(run.input.session.id)).toMatchObject({ status: "interrupted", attemptOutcome: "interrupted", lastError: reason });
    expect(settledReports).toEqual([{ error: null }]);
    expect(logger.info).toHaveBeenCalledWith(`Session ${run.input.session.id} interrupted in 412ms: ${reason}`);
  });

  it("keeps the bare placeholder when the engine gave no reason", async () => {
    const { run, attempt } = runFor(undefined);
    await settleAnsweredTurn(run, attempt, "sonnet", preempted);

    expect(reg.getSession(run.input.session.id)?.lastError).toBe("Interrupted");
  });
});
