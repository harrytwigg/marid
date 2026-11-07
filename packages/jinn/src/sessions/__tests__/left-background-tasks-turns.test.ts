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
 * Background tasks a session was stopped under are owed to its next explicit turn
 * until the engine has read the note naming them: not when the turn is re-run in a
 * fresh conversation (the note is composed again), and not when the turn fails
 * before the engine has said anything.
 */

createTestHome("jinn-left-background-turns-");
const dbModule = await import("../../shared/db.js");
const { processStartFailure } = await import("../../shared/process-start.js");

let registry: typeof import("../registry.js");
let left: typeof import("../left-background-tasks.js");
let ManagerClass: typeof import("../manager.js").SessionManager;

beforeAll(async () => {
  [registry, left, { SessionManager: ManagerClass }] = await Promise.all([
    import("../registry.js"), import("../left-background-tasks.js"), import("../manager.js"),
  ]);
  dbModule.initDb();
});

beforeEach(() => {
  dbModule.initDb().exec("DELETE FROM messages; DELETE FROM queue_items; DELETE FROM sessions;");
});

const employee = { name: EMPLOYEE, engine: "claude", persona: "Left background fixture" };
const TASK = { id: "bk2tests1", kind: "process" as const, command: "npm test", description: "Run the tests", agentType: null };

/** Turn one answers and files `native-1`; the session is then stopped under TASK; the next messages get `scripted`. */
async function afterStop(scripted: EngineResult[], messages: string[]) {
  const claude = scriptedEngine("claude", [engineResult({ sessionId: "native-1", result: "hello", cost: 0.01, numTurns: 1 }), ...scripted]);
  const prompts: string[] = [];
  const run = claude.run.bind(claude);
  claude.run = async (opts: { sessionId?: string; prompt?: string }) => {
    prompts.push(opts.prompt ?? "");
    return run(opts as never);
  };
  const manager = new ManagerClass(testConfig(), new Map([["claude", claude]]) as never, "left-background-boot");
  const key = `stub:left-background-${Math.random().toString(16).slice(2)}`;
  const first = await manager.route(connectorMessage(key, "one"), connectorStub(), { employee: employee as never });
  const id = first!.sessionId;
  left.recordLeftBackgroundTasks(id, [TASK], "stopped");
  for (const text of messages) await manager.route(connectorMessage(key, text), connectorStub(), { employee: employee as never });
  const owed = () => left.readLeftBackgroundTasks(registry.getSession(id)!).map((entry) => entry.id);
  return { id, prompts, owed };
}

describe("a turn re-run in a fresh conversation after the resumed one was lost", () => {
  it("still leads with the note, and the tasks are cleared by the run that carried it", async () => {
    const lost = processStartFailure("claude", { exitCode: 1, signal: 0 }, "No conversation found with session ID: native-1");
    const { prompts, owed } = await afterStop(
      [engineResult({ sessionId: "native-1", error: lost }), engineResult({ sessionId: "native-2", result: "answered afresh", cost: 0.01, numTurns: 1 })],
      ["two"],
    );

    expect(prompts).toHaveLength(3);
    expect(prompts[1]).toMatch(/^\[Gateway\] A background task this session started/);
    expect(prompts[2]).toContain("could not be resumed");
    expect(prompts[2]).toContain("- bk2tests1 (background Bash)");
    expect(owed()).toEqual([]);
  });
});

describe("a turn that fails before the engine has said anything", () => {
  it("keeps the tasks owed, so the next message is still told", async () => {
    const down = processStartFailure("claude", { exitCode: 255, signal: 0 }, "ssh: connect to host build-box port 22: Connection timed out");
    const { id, prompts, owed } = await afterStop(
      [engineResult({ error: down }), engineResult({ error: down }), engineResult({ sessionId: "native-1", result: "back", cost: 0.01, numTurns: 1 })],
      ["two"],
    );

    expect(registry.getSession(id)).toMatchObject({ status: "error" });
    expect(owed()).toEqual(["bk2tests1"]);

    const claudeTurns = prompts.length;
    expect(claudeTurns).toBe(3);
    expect(prompts[1]).toContain("- bk2tests1 (background Bash)");
  });

  it("tells the next message, then stops owing it", async () => {
    const down = processStartFailure("claude", { exitCode: 255, signal: 0 }, "ssh: connect to host build-box port 22: Connection timed out");
    const { prompts, owed } = await afterStop(
      [engineResult({ error: down }), engineResult({ error: down }), engineResult({ sessionId: "native-1", result: "back", cost: 0.01, numTurns: 1 }), engineResult({ sessionId: "native-1", result: "again", cost: 0.01, numTurns: 1 })],
      ["two", "three", "four"],
    );

    expect(prompts[3]).toContain("- bk2tests1 (background Bash)");
    expect(prompts[3]).toMatch(/three/);
    expect(owed()).toEqual([]);
    expect(prompts[4]).not.toContain("[Gateway] A background task");
  });
});
