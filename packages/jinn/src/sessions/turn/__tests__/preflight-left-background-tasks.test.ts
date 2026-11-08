import { describe, expect, it, vi } from "vitest";
import type { JinnConfig, Session } from "../../../shared/types.js";
import type { TurnInput, TurnPlan } from "../types.js";

/**
 * Background tasks a session was stopped under are told to it on its next
 * explicit turn, ahead of the message, once. An engine-native command goes to
 * the engine as written and leaves them owed.
 */

vi.mock("../../../shared/logger.js", () => ({
  logger: { warn: vi.fn(), debug: vi.fn(), info: vi.fn(), error: vi.fn() },
}));
vi.mock("../../claude-auth-watch.js", () => ({ refuseClaudeLaunch: vi.fn(() => undefined) }));
vi.mock("../../../gateway/budgets.js", () => ({ isBudgetExhausted: vi.fn(() => false) }));
vi.mock("../../../shared/models.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../shared/models.js")>()),
  engineAvailable: vi.fn(() => true),
  effortLevelsForModel: vi.fn(() => []),
}));
vi.mock("../../registry.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../registry.js")>()),
  getMessages: vi.fn(() => []),
}));

import { preflightTurn } from "../preflight.js";
import { LEFT_BACKGROUND_TASKS_META_KEY } from "../../left-background-tasks.js";

const OWED = [
  { id: "bk2tests1", kind: "process", command: "npm test", description: "Run the tests", agentType: null, reason: "stopped", at: "2026-11-07T07:00:00.000Z" },
];

function input(prompt: string, meta?: Record<string, unknown>): TurnInput {
  const session = {
    id: "s1", engine: "claude", source: "web", status: "running", attemptToken: "t",
    engineSessions: { claude: { id: "claude-native-1" } },
    ...(meta ? { transportMeta: meta } : {}),
  } as unknown as Session;
  return {
    session, attemptToken: "t", prompt, attachments: [],
    config: { engines: { default: "claude", claude: {} } } as unknown as JinnConfig,
    engines: new Map([["claude", {} as never]]), gatewayBootId: "boot",
    connectorNames: [], channel: "web", user: "operator",
  } as TurnInput;
}

describe("preflightTurn — background tasks left behind", () => {
  it("leads an ordinary prompt with a note naming each task, and says which it carried", () => {
    const plan = preflightTurn(input("carry on", { [LEFT_BACKGROUND_TASKS_META_KEY]: OWED })) as TurnPlan;

    expect(plan.ok).toBe(true);
    expect(plan.carriedLeftBackgroundTaskIds).toEqual(["bk2tests1"]);
    expect(plan.promptToRun).toContain("[Gateway] A background task this session started was still running");
    expect(plan.promptToRun).toContain("- bk2tests1 (background Bash): Run the tests: `npm test`");
    expect(plan.promptToRun.endsWith("carry on")).toBe(true);
  });

  it("leaves a prompt alone when nothing is owed", () => {
    const plan = preflightTurn(input("carry on")) as TurnPlan;
    expect(plan.promptToRun).toBe("carry on");
    expect(plan.carriedLeftBackgroundTaskIds).toEqual([]);
  });

  it("sends an engine-native command as written and leaves the tasks owed", () => {
    const meta = { [LEFT_BACKGROUND_TASKS_META_KEY]: OWED };

    const compact = preflightTurn(input("/compact", meta)) as TurnPlan;
    expect(compact.promptToRun).toBe("/compact");
    expect(compact.carriedLeftBackgroundTaskIds).toEqual([]);

    const ordinary = preflightTurn(input("next", meta)) as TurnPlan;
    expect(ordinary.carriedLeftBackgroundTaskIds).toEqual(["bk2tests1"]);
  });
});
