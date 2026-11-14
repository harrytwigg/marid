import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import type { Engine, EngineResult, EngineRunOpts, HundredfoldConfig } from "../../shared/types.js";
import type { TurnSurface } from "../turn/types.js";

// Isolate the DB: HUNDREDFOLD_HOME must be set before importing the registry
// (SESSIONS_DB is resolved at module load).
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "hundredfold-interrupted-carry-"));
process.env.HUNDREDFOLD_HOME = tmp;
const reg = await import("../registry.js");
const { runTurn } = await import("../turn/runner.js");
const { supersedeRunningTurn } = await import("../turn/superseded.js");

const ENGINE = "claude";
const THREAD = "engine-thread-1";
/** The thread a fresh session's first turn mints on the engine. */
const MINTED_THREAD = "engine-thread-minted";

const silentSurface: TurnSurface = {
  started: async () => {},
  delta: () => {},
  notice: async () => {},
  reply: async () => {},
  waiting: async () => {},
  settled: async () => {},
};

/** What each engine invocation saw, and what it did before answering. */
interface EngineCall {
  prompt: string;
  resumeSessionId?: string;
}

type Behaviour = (opts: EngineRunOpts, call: number) => Promise<EngineResult>;

function recordingEngine(behaviour: Behaviour): { engine: Engine; calls: EngineCall[] } {
  const calls: EngineCall[] = [];
  const engine: Engine = {
    name: ENGINE,
    async run(opts) {
      calls.push({ prompt: opts.prompt, resumeSessionId: opts.resumeSessionId });
      return behaviour(opts, calls.length);
    },
  };
  return { engine, calls };
}

const answered = (text: string): EngineResult => ({ sessionId: THREAD, result: text });
/** A turn the gateway killed: no answer, no session id echoed back. */
const killed = (): EngineResult => ({ sessionId: "", result: "", error: "Interrupted by a new message" });

function config(): HundredfoldConfig {
  return { gateway: {}, engines: { default: ENGINE }, sessions: {} } as unknown as HundredfoldConfig;
}

async function runOne(engine: Engine, sessionId: string, prompt: string): Promise<void> {
  const started = reg.beginSessionAttempt(sessionId)!;
  await runTurn({
    session: reg.getSession(sessionId)!,
    attemptToken: started.attemptToken!,
    prompt,
    attachments: [],
    config: config(),
    engines: new Map([[ENGINE, engine]]),
    gatewayBootId: "test-boot",
    connectorNames: [],
    channel: "web",
    user: "operator",
  }, silentSurface);
}

/** A session mid-conversation: it already has an engine thread to resume. */
function establishedSession(sourceRef: string): string {
  const created = reg.createSession({ engine: ENGINE, source: "web", sourceRef, model: "opus" });
  reg.recordEngineSessionId(created.id, ENGINE, THREAD, { model: "opus" });
  return created.id;
}

/** A brand-new session: its first turn is what mints the engine thread. */
function freshSession(sourceRef: string): string {
  return reg.createSession({ engine: ENGINE, source: "web", sourceRef, model: "opus" }).id;
}

describe("a message interrupted before the engine read it still reaches the engine", () => {
  beforeEach(async () => {
    const db = (await import("../../shared/db.js")).initDb();
    db.exec("DELETE FROM messages; DELETE FROM queue_items; DELETE FROM sessions;");
  });

  it("carries the interrupted prompt into the next turn, on the same engine thread", async () => {
    const sessionId = establishedSession("web:back-to-back");
    // Turn 1 is killed by a newer user message before it emits anything — the
    // 200ms "Hey" then "Ho" the operator reported.
    const { engine, calls } = recordingEngine(async (_opts, call) => {
      if (call === 1) {
        supersedeRunningTurn(reg.getSession(sessionId)!);
        return killed();
      }
      return answered("both received");
    });

    await runOne(engine, sessionId, "Hey");
    await runOne(engine, sessionId, "Ho");

    expect(calls).toHaveLength(2);
    const second = calls[1]!;
    expect(second.prompt).toContain("Hey");
    expect(second.prompt).toContain("Ho");
    expect(second.prompt.indexOf("Hey")).toBeLessThan(second.prompt.indexOf("Ho"));
    // The interrupt must not orphan the thread the conversation lives in.
    expect(second.resumeSessionId).toBe(THREAD);
  });

  it("stops carrying it once a turn has put it in front of the engine", async () => {
    const sessionId = establishedSession("web:carried-once");
    const { engine, calls } = recordingEngine(async (_opts, call) => {
      if (call === 1) {
        supersedeRunningTurn(reg.getSession(sessionId)!);
        return killed();
      }
      return answered("ok");
    });

    await runOne(engine, sessionId, "Hey");
    await runOne(engine, sessionId, "Ho");
    await runOne(engine, sessionId, "And now something else");

    expect(calls[2]!.prompt).toBe("And now something else");
  });

  it("carries every message a burst interrupted, oldest first", async () => {
    const sessionId = establishedSession("web:burst");
    const { engine, calls } = recordingEngine(async (_opts, call) => {
      if (call <= 2) {
        supersedeRunningTurn(reg.getSession(sessionId)!);
        return killed();
      }
      return answered("ok");
    });

    await runOne(engine, sessionId, "one");
    await runOne(engine, sessionId, "two");
    await runOne(engine, sessionId, "three");

    const last = calls[2]!.prompt;
    expect(last.indexOf("one")).toBeGreaterThanOrEqual(0);
    expect(last.indexOf("one")).toBeLessThan(last.indexOf("two"));
    expect(last.indexOf("two")).toBeLessThan(last.indexOf("three"));
  });

  it("leaves the prompt alone when the engine had already read it", async () => {
    const sessionId = establishedSession("web:already-read");
    const { engine, calls } = recordingEngine(async (opts, call) => {
      if (call === 1) {
        // The engine answered its way into the transcript before the kill, so
        // resuming the thread already shows this message.
        opts.onStream?.({ type: "text", content: "counting: 1" });
        supersedeRunningTurn(reg.getSession(sessionId)!);
        return killed();
      }
      return answered("ok");
    });

    await runOne(engine, sessionId, "Hey");
    await runOne(engine, sessionId, "Ho");

    expect(calls[1]!.prompt).toBe("Ho");
  });

  it("keeps the thread a newer message orphaned, so the next turn resumes it", async () => {
    const sessionId = freshSession("web:fresh-minted-thread");
    // The engine minted a thread and answered into it before the kill, so the
    // interrupted message is recorded there and nowhere else.
    const { engine, calls } = recordingEngine(async (opts, call) => {
      if (call === 1) {
        opts.onStream?.({ type: "text", content: "working on it" });
        supersedeRunningTurn(reg.getSession(sessionId)!);
        return { sessionId: MINTED_THREAD, result: "", error: "Interrupted by a new message" };
      }
      return answered("ok");
    });

    await runOne(engine, sessionId, "Hey");
    await runOne(engine, sessionId, "Ho");

    expect(calls[1]!.resumeSessionId).toBe(MINTED_THREAD);
    // That thread already holds "Hey" — carrying it too would say it twice.
    expect(calls[1]!.prompt).toBe("Ho");
  });

  it("does not replay a turn the operator stopped", async () => {
    const sessionId = establishedSession("web:stopped");
    const { engine, calls } = recordingEngine(async (_opts, call) => {
      // A stop, not a newer message: nothing supersedes the turn, and the
      // operator does not want it asked again.
      if (call === 1) return killed();
      return answered("ok");
    });

    await runOne(engine, sessionId, "Hey");
    await runOne(engine, sessionId, "Ho");

    expect(calls[1]!.prompt).toBe("Ho");
  });
});
