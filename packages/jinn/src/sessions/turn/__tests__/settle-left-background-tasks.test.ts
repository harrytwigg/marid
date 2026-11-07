import { describe, expect, it, vi } from "vitest";

/**
 * The background tasks a turn's prompt told the session about stop being owed
 * when the turn settles with the engine having read that prompt, and not before.
 */

const settled = vi.hoisted(() => [] as Array<{ fields: { transportMeta?: Record<string, unknown> } }>);
vi.mock("../completion.js", () => ({
  settleTurn: vi.fn(async (input: { fields: { transportMeta?: Record<string, unknown> } }) => { settled.push(input); return true; }),
}));
vi.mock("../../../gateway/external-turns.js", () => ({ markTranscriptSyncedThrough: vi.fn() }));
vi.mock("../../registry.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../registry.js")>()),
  insertMessageAfter: vi.fn(),
  getSession: vi.fn(() => liveSession),
  updateSession: vi.fn(),
}));

const OWED = (id: string) => ({ id, kind: "process", command: "npm test", description: null, agentType: null, reason: "stopped", at: "2026-11-07T07:00:00.000Z" });
let liveSession: { id: string; transportMeta: Record<string, unknown> };

const { settleAnsweredTurn } = await import("../settle.js");
const { LEFT_BACKGROUND_TASKS_META_KEY } = await import("../../left-background-tasks.js");

function run(carriedLeftBackgroundTaskIds: string[]) {
  return {
    input: {
      session: { id: "s1", transportMeta: {} }, employee: { name: "op", engine: "claude" }, attemptToken: "t",
      prompt: "go", config: { engines: {} },
    },
    plan: {
      engineName: "claude", compaction: false, syncRequested: false, carriedInterruptedPrompts: false,
      carriedLeftBackgroundTaskIds,
    },
    surface: { reply: vi.fn(async () => undefined), notice: vi.fn(async () => undefined) },
    terminalFields: () => ({}),
    turnStartedAt: 0,
  };
}

const ATTEMPT = { result: { result: "ok", numTurns: 1, sessionId: "native-1" } };

async function settleWith(carried: string[], enginePromptRead: boolean): Promise<Record<string, unknown> | undefined> {
  settled.length = 0;
  await settleAnsweredTurn(run(carried) as never, ATTEMPT as never, undefined, {
    quietPreempted: !enginePromptRead, streamedThrough: 0, superseded: false, enginePromptRead,
  });
  return settled[0]?.fields.transportMeta;
}

describe("settling a turn that carried left-behind background tasks", () => {
  it("drops the tasks it carried and keeps any recorded while it ran", async () => {
    liveSession = { id: "s1", transportMeta: { [LEFT_BACKGROUND_TASKS_META_KEY]: [OWED("carried-1"), OWED("late-2")], other: "kept" } };

    const meta = await settleWith(["carried-1"], true);

    expect((meta?.[LEFT_BACKGROUND_TASKS_META_KEY] as Array<{ id: string }>).map((entry) => entry.id)).toEqual(["late-2"]);
    expect(meta?.other).toBe("kept");
  });

  it("removes the key once nothing is owed", async () => {
    liveSession = { id: "s1", transportMeta: { [LEFT_BACKGROUND_TASKS_META_KEY]: [OWED("carried-1")] } };

    const meta = await settleWith(["carried-1"], true);

    expect(meta).toEqual({});
  });

  it("keeps them owed when the engine never read the prompt", async () => {
    liveSession = { id: "s1", transportMeta: { [LEFT_BACKGROUND_TASKS_META_KEY]: [OWED("carried-1")] } };

    expect(await settleWith(["carried-1"], false)).toBeUndefined();
  });

  it("leaves the session's meta alone when the turn carried none", async () => {
    liveSession = { id: "s1", transportMeta: { [LEFT_BACKGROUND_TASKS_META_KEY]: [OWED("late-2")] } };

    expect(await settleWith([], true)).toBeUndefined();
  });
});
