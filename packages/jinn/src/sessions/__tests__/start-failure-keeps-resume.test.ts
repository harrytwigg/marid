import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import {
  EMPLOYEE,
  connectorMessage,
  connectorStub,
  createTestHome,
  engineResult,
  scriptedEngine,
  testConfig,
} from "./helpers/turn-parity-harness.js";
import type { EngineResult } from "../../shared/types.js";

/**
 * A resumed turn whose engine process dies before its session starts (an ssh
 * hop that drops, a crash on boot, an exec refusal) fails, and says why. It
 * must not also cost the session its conversation: the resume id is as good
 * as it was, so the next message picks the same conversation back up. Only
 * the CLI saying that conversation is gone (Claude Code, codex) clears it.
 */

createTestHome("jinn-start-failure-resume-");
const dbModule = await import("../../shared/db.js");
const { processStartFailure } = await import("../../shared/process-start.js");

let registry: typeof import("../registry.js");
let ManagerClass: typeof import("../manager.js").SessionManager;

beforeAll(async () => {
  [registry, { SessionManager: ManagerClass }] = await Promise.all([import("../registry.js"), import("../manager.js")]);
  dbModule.initDb();
});

beforeEach(() => {
  dbModule.initDb().exec("DELETE FROM messages; DELETE FROM queue_items; DELETE FROM sessions;");
});

const employee = { name: EMPLOYEE, engine: "claude", persona: "Start failure fixture" };

/** Two turns on one session: the first answers and files `native-1`, the second gets `second`. */
async function twoTurns(second: EngineResult) {
  const claude = scriptedEngine("claude", [engineResult({ sessionId: "native-1", result: "hello", cost: 0.01, numTurns: 1 }), second]);
  const resumedWith: Array<string | undefined> = [];
  const run = claude.run.bind(claude);
  claude.run = async (opts: { sessionId?: string; resumeSessionId?: string }) => { resumedWith.push(opts.resumeSessionId); return run(opts); };
  const manager = new ManagerClass(testConfig(), new Map([["claude", claude]]) as never, "start-failure-boot");
  const key = `stub:start-failure-${Math.random().toString(16).slice(2)}`;
  // route() resolves once the queued turn has settled.
  const first = await manager.route(connectorMessage(key, "one"), connectorStub(), { employee: employee as never });
  const id = first!.sessionId;
  await manager.route(connectorMessage(key, "two"), connectorStub(), { employee: employee as never });
  return { session: registry.getSession(id)!, resumedWith };
}

describe("a resumed turn whose process never started its session", () => {
  it("fails with the process's reason and keeps the conversation to resume", async () => {
    const error = processStartFailure("claude", { exitCode: 255, signal: 0 }, "ssh: connect to host build-box port 22: Connection timed out");
    const { session, resumedWith } = await twoTurns(engineResult({ error }));

    expect(resumedWith).toEqual([undefined, "native-1"]);
    expect(session).toMatchObject({ status: "error", attemptOutcome: "failed", lastError: error });
    expect(registry.getEngineSessionRef(session, "claude").id).toBe("native-1");
  });

  it("drops the conversation when Claude Code says it no longer has it", async () => {
    const error = processStartFailure("claude", { exitCode: 1, signal: 0 }, "No conversation found with session ID: native-1");
    const { session } = await twoTurns(engineResult({ sessionId: "native-1", error }));

    expect(registry.getEngineSessionRef(session, "claude").id).toBeUndefined();
  });

  it("drops the conversation when codex says it no longer has it", async () => {
    const output = "ERROR: No saved session found with ID native-1. Run `codex resume` without an ID to choose from existing sessions.";
    const error = processStartFailure("codex", { exitCode: 1, signal: 0 }, output);
    const { session } = await twoTurns(engineResult({ sessionId: "native-1", error }));

    expect(registry.getEngineSessionRef(session, "claude").id).toBeUndefined();
  });
});
