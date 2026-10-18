import { describe, it, expect, vi, beforeEach } from "vitest";

// A usage limit on a session with its own fallback target, through the real handler: the stand-in runs the chosen
// engine and model, and one that cannot serve parks the turn with the reason instead of taking the chain's engine.

const engineAvailableMock = vi.fn<(...args: unknown[]) => boolean>();
vi.mock("../../shared/models.js", () => ({
  engineAvailable: (...args: unknown[]) => engineAvailableMock(...args),
  effortLevelsForModel: vi.fn(() => ["low", "medium", "high"]),
  getModelRegistry: vi.fn(() => ({
    codex: { models: [{ id: "gpt-mini" }, { id: "gpt-5.3-codex" }] },
    claude: { models: [{ id: "opus" }, { id: "sonnet" }] },
    grok: { models: [{ id: "grok-build" }] },
  })),
  hasDynamicModelCatalog: () => false,
  ENGINE_NAMES: ["claude", "codex", "antigravity", "grok", "pi", "hermes"],
  isKnownEngine: (name: string) => ["claude", "codex", "antigravity", "grok", "pi", "hermes"].includes(name),
}));

const getSessionMock = vi.fn();
const updateSessionForAttemptMock = vi.fn((_id: string, _token: string, updates: Partial<Session>) => makeSession(updates));
vi.mock("../registry.js", () => ({
  getSession: (...a: unknown[]) => getSessionMock(...a),
  getMessages: vi.fn(() => []),
  updateSessionForAttempt: (...a: Parameters<typeof updateSessionForAttemptMock>) => updateSessionForAttemptMock(...a),
  getEngineSessionRef: (session: Session, engine: string) => session.engineSessions?.[engine] ?? {},
  nextEngineSessionFields: (session: Session, engine: string, id: string) => ({
    engineSessions: { ...(session.engineSessions ?? {}), [engine]: { id } },
    ...(session.engine === engine ? { engineSessionId: id } : {}),
  }),
}));
vi.mock("../engine-run-mcp.js", () => ({ resolveEngineRunMcp: vi.fn(() => ({})) }));
vi.mock("../../shared/usageAwareness.js", () => ({ recordClaudeRateLimit: vi.fn() }));
vi.mock("../../shared/engine-health.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../shared/engine-health.js")>()),
  readEngineHealth: () => ({}),
  recordEngineUnavailable: vi.fn(),
}));
vi.mock("../../shared/effort.js", () => ({ resolveEffort: vi.fn(() => "medium") }));
vi.mock("../../shared/logger.js", () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));
vi.mock("../../shared/rateLimit.js", () => ({
  computeNextRetryDelayMs: vi.fn(() => ({ delayMs: 0, resumeAt: undefined })),
  computeRateLimitDeadlineMs: vi.fn(() => Date.now() - 1),
  detectRateLimit: vi.fn(() => ({ limited: false })),
  rateLimitEngineLabel: (engine: string) => engine,
}));

import { detectRateLimit } from "../../shared/rateLimit.js";
import { makeSession } from "./helpers/session-fixture.js";
import { handleRateLimit, type RateLimitHandlerOpts } from "../rate-limit-handler.js";
import type { Session, EngineResult } from "../../shared/types.js";

const target = { engine: "codex", model: "gpt-mini" };

function makeOpts(session: Session, stored: Session = session) {
  getSessionMock.mockImplementation(() => stored);
  const codexRun = vi.fn(async () => ({ result: "from-codex", sessionId: "codex-1" }) as EngineResult);
  const grokRun = vi.fn(async () => ({ result: "from-grok", sessionId: "grok-1" }) as EngineResult);
  const claudeRun = vi.fn(async () => ({ result: "from-claude", sessionId: "claude-2" }) as EngineResult);
  const hooks = { onWaitingStart: vi.fn(), onFallbackStart: vi.fn(), onFallbackComplete: vi.fn() };
  const opts: RateLimitHandlerOpts = {
    session,
    attemptToken: "attempt-1",
    prompt: "hello",
    engineConfig: { bin: "claude", model: "opus" },
    config: {
      engines: {
        claude: { bin: "claude", model: "opus", fallback: ["grok"] },
        codex: { bin: "codex", model: "gpt-5.3-codex" },
        grok: { bin: "grok", model: "grok-build" },
      },
    } as unknown as RateLimitHandlerOpts["config"],
    engines: new Map([
      ["codex", { run: codexRun }], ["grok", { run: grokRun }], ["claude", { run: claudeRun }],
    ]) as unknown as RateLimitHandlerOpts["engines"],
    engine: { run: vi.fn() } as unknown as RateLimitHandlerOpts["engine"],
    rateLimit: { resetsAt: undefined },
    originalResult: { result: "", sessionId: "claude-thread-1" } as EngineResult,
    hooks,
  };
  return { opts, codexRun, grokRun, claudeRun, hooks };
}

describe("handleRateLimit — a session's own fallback target", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    engineAvailableMock.mockReturnValue(true);
    vi.mocked(detectRateLimit).mockReturnValue({ limited: false });
  });

  it("switches to the chosen engine and model, not the chain's engine, and says which model", async () => {
    const { opts, codexRun, grokRun, hooks } = makeOpts(makeSession({ fallbackTarget: target }));

    const outcome = await handleRateLimit(opts);

    expect(outcome.kind).toBe("fallback");
    expect(grokRun).not.toHaveBeenCalled();
    expect(codexRun).toHaveBeenCalledWith(expect.objectContaining({ model: "gpt-mini" }));
    expect(updateSessionForAttemptMock).toHaveBeenCalledWith("sess-1", "attempt-1", expect.objectContaining({ engine: "codex", model: "gpt-mini" }));
    expect(hooks.onFallbackStart).toHaveBeenCalledWith(expect.objectContaining({ substitute: "codex", model: "gpt-mini" }));
    expect(hooks.onFallbackComplete).toHaveBeenCalledWith(expect.anything(), { engine: "codex", model: "gpt-mini" });
  });

  it("a same-engine target switches the model on the same engine", async () => {
    const { opts, claudeRun } = makeOpts(makeSession({ fallbackTarget: { engine: "claude", model: "sonnet" } }));
    const outcome = await handleRateLimit(opts);
    expect(outcome.kind).toBe("fallback");
    expect(claudeRun).toHaveBeenCalledWith(expect.objectContaining({ model: "sonnet" }));
    expect(updateSessionForAttemptMock).toHaveBeenCalledWith("sess-1", "attempt-1", expect.objectContaining({ engine: "claude", model: "sonnet" }));
  });

  it("an engine that cannot serve parks the turn with the reason, and the chain's grok never runs", async () => {
    engineAvailableMock.mockImplementation((_config, name) => name !== "codex");
    const { opts, codexRun, grokRun, hooks } = makeOpts(makeSession({ fallbackTarget: target }));

    const outcome = await handleRateLimit(opts);

    expect(outcome.kind).not.toBe("fallback");
    expect(codexRun).not.toHaveBeenCalled();
    expect(grokRun).not.toHaveBeenCalled();
    expect(hooks.onFallbackStart).not.toHaveBeenCalled();
    expect(hooks.onWaitingStart).toHaveBeenCalledWith(expect.objectContaining({ reason: "the chosen fallback codex (gpt-mini) is not installed" }));
    expect(updateSessionForAttemptMock).toHaveBeenCalledWith("sess-1", "attempt-1", expect.objectContaining({
      status: "waiting", lastError: expect.stringContaining("the chosen fallback codex (gpt-mini) is not installed"),
    }));
  });

  it("auto-resume keeps the target and does not use it", async () => {
    const { opts, codexRun, hooks } = makeOpts(makeSession({ fallbackMode: "auto-resume", fallbackTarget: target }));
    await handleRateLimit(opts);
    expect(codexRun).not.toHaveBeenCalled();
    expect(hooks.onWaitingStart).toHaveBeenCalledWith(expect.not.objectContaining({ reason: expect.anything() }));
  });

  it("reads the target from the stored row: one set while the turn ran is used, one cleared is not", async () => {
    const set = makeOpts(makeSession(), makeSession({ fallbackTarget: target }));
    await handleRateLimit(set.opts);
    expect(set.codexRun).toHaveBeenCalledTimes(1);

    const cleared = makeOpts(makeSession({ fallbackTarget: target }), makeSession({ fallbackTarget: null }));
    await handleRateLimit(cleared.opts);
    expect(cleared.codexRun).not.toHaveBeenCalled();
    expect(cleared.grokRun).toHaveBeenCalledTimes(1);
  });

  describe("a target that is limited too", () => {
    const limitedRun = () => vi.fn(async () => ({ result: "", sessionId: "", error: "You've hit your usage limit." }) as EngineResult);

    it("an engine that comes back limited parks the turn with the reason, and the session goes back where it was", async () => {
      const { opts, codexRun, hooks } = makeOpts(makeSession({ fallbackTarget: target }));
      codexRun.mockImplementation(limitedRun());
      vi.mocked(detectRateLimit).mockImplementation((r) => ({ limited: Boolean(r.error?.includes("usage limit")) }));

      const outcome = await handleRateLimit(opts);

      expect(codexRun).toHaveBeenCalledTimes(1);
      expect(outcome.kind).not.toBe("fallback");
      expect(hooks.onFallbackComplete).not.toHaveBeenCalled();
      expect(hooks.onWaitingStart).toHaveBeenCalledWith(expect.objectContaining({ reason: "the chosen fallback codex (gpt-mini) is limited too" }));
      const writes = updateSessionForAttemptMock.mock.calls.map((c) => c[2]);
      const flip = writes.findIndex((w) => w.engine === "codex");
      const back = writes.findIndex((w, i) => i > flip && w.engine === "claude");
      expect(flip).toBeGreaterThanOrEqual(0);
      expect(writes[back]).toMatchObject({ engine: "claude", model: "opus", transportMeta: null });
      expect(writes.findIndex((w, i) => i > back && w.status === "waiting")).toBeGreaterThan(back);
    });

    it("a same-engine model change that comes back limited parks the same way", async () => {
      const { opts, claudeRun, hooks } = makeOpts(makeSession({ fallbackTarget: { engine: "claude", model: "sonnet" } }));
      claudeRun.mockImplementation(limitedRun());
      vi.mocked(detectRateLimit).mockImplementation((r) => ({ limited: Boolean(r.error?.includes("usage limit")) }));

      const outcome = await handleRateLimit(opts);

      expect(outcome.kind).not.toBe("fallback");
      expect(hooks.onWaitingStart).toHaveBeenCalledWith(expect.objectContaining({ reason: "the chosen fallback claude (sonnet) is limited too" }));
      expect(updateSessionForAttemptMock).toHaveBeenCalledWith("sess-1", "attempt-1", expect.objectContaining({ engine: "claude", model: "opus", transportMeta: null }));
    });

    it("an interrupted substitute is not read as a limit", async () => {
      const { opts, codexRun } = makeOpts(makeSession({ fallbackTarget: target }));
      codexRun.mockImplementation(vi.fn(async () => ({ result: "", sessionId: "", error: "Interrupted: stopped" }) as EngineResult));
      vi.mocked(detectRateLimit).mockReturnValue({ limited: true });
      expect((await handleRateLimit(opts)).kind).toBe("fallback");
    });
  });
});
