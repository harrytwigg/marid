import { describe, expect, it, vi } from "vitest";
import type { JinnConfig, Session } from "../../../shared/types.js";
import type { TurnInput, TurnPlan } from "../types.js";

/**
 * an operator's `/compact` is routed by the session's engine in turn
 * preflight — the one gate every transport (web chat, CLI view, connectors)
 * goes through. An engine that can compact gets the command verbatim; one that
 * cannot is answered there, and the command never reaches its model as text.
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
  getMessages: vi.fn(() => [
    { role: "user", content: "earlier, on the other engine", timestamp: Date.parse("2026-09-29T08:00:01Z") },
  ]),
}));

import { preflightTurn } from "../preflight.js";
import { UNSEEN_INTERRUPTED_PROMPTS_META_KEY } from "../superseded.js";

const ENGINES = ["claude", "opencode", "codex", "grok", "pi", "hermes", "antigravity"];

function configWith(opencodeMode?: "server" | "run"): JinnConfig {
  return {
    engines: { default: "claude", claude: {}, codex: {}, opencode: opencodeMode ? { mode: opencodeMode } : {} },
  } as unknown as JinnConfig;
}

function input(engine: string, prompt: string, over: { config?: JinnConfig; session?: Partial<Session> } = {}): TurnInput {
  const session = {
    id: "s1", engine, source: "web", status: "running", attemptToken: "t",
    engineSessions: { [engine]: { id: `${engine}-native-1` } },
    ...over.session,
  } as unknown as Session;
  return {
    session, attemptToken: "t", prompt, attachments: [], config: over.config ?? configWith("server"),
    engines: new Map(ENGINES.map((e) => [e, {} as never])), gatewayBootId: "boot",
    connectorNames: [], channel: "web", user: "operator",
  } as TurnInput;
}

describe("preflightTurn — /compact routing", () => {
  it("sends Claude its native /compact verbatim, focus instructions and all", () => {
    const plan = preflightTurn(input("claude", "/compact keep the Todo ids")) as TurnPlan;
    expect(plan.ok).toBe(true);
    expect(plan.compaction).toBe(true);
    expect(plan.promptToRun).toBe("/compact keep the Todo ids");
  });

  it("sends an opencode server-mode session /compact, which its engine runs as summarize", () => {
    const plan = preflightTurn(input("opencode", "/compact")) as TurnPlan;
    expect(plan.ok).toBe(true);
    expect(plan.compaction).toBe(true);
    expect(plan.promptToRun).toBe("/compact");
  });

  it("declines opencode in run mode, which has no compaction to call", () => {
    for (const config of [configWith("run"), configWith(undefined)]) {
      const plan = preflightTurn(input("opencode", "/compact", { config }));
      expect(plan).toEqual({ ok: false, declined: true, error: expect.stringContaining("engines.opencode.mode: server") });
    }
  });

  it.each(["codex", "grok", "pi", "hermes", "antigravity"])("declines %s, which has no native compaction", (engine) => {
    const plan = preflightTurn(input(engine, "/compact keep it short"));
    expect(plan).toEqual({ ok: false, declined: true, error: expect.stringContaining(`isn't supported on the ${engine} engine`) });
    expect((plan as { error: string }).error).toContain("Nothing was sent to the model");
  });

  it("declines a session with no conversation on its engine yet", () => {
    const plan = preflightTurn(input("claude", "/compact", { session: { engineSessions: {} } }));
    expect(plan).toEqual({ ok: false, declined: true, error: expect.stringContaining("Nothing to compact yet") });
  });

  it("leaves ordinary prompts, and words that merely start with /compact, alone", () => {
    for (const prompt of ["please /compact", "/compaction notes", "hello"]) {
      const plan = preflightTurn(input("codex", prompt)) as TurnPlan;
      expect(plan.ok).toBe(true);
      expect(plan.compaction).toBe(false);
    }
  });

  it("never folds an engine-switch transcript or held prompts in front of the command", () => {
    const session: Partial<Session> = {
      transportMeta: {
        engineSyncTarget: "claude",
        engineSyncSince: "2026-09-29T08:00:00Z",
        [UNSEEN_INTERRUPTED_PROMPTS_META_KEY]: ["a message an interrupt kept from the engine"],
      } as never,
    };
    const plan = preflightTurn(input("claude", "/compact", { session })) as TurnPlan;
    expect(plan.promptToRun).toBe("/compact");
    // Both stay owed to the next ordinary turn.
    expect(plan.syncRequested).toBe(false);
    expect(plan.carriedInterruptedPrompts).toBe(false);

    const ordinary = preflightTurn(input("claude", "carry on", { session })) as TurnPlan;
    expect(ordinary.promptToRun).not.toBe("carry on");
    expect(ordinary.syncRequested).toBe(true);
  });
});
