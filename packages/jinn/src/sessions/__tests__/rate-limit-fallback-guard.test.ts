import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// ── Mocks (must be declared before importing the module under test) ──────────

// engineAvailable is the guard under test — fully controllable per case.
const engineAvailableMock = vi.fn<(...args: unknown[]) => boolean>();
vi.mock("../../shared/models.js", () => ({
  engineAvailable: (...args: unknown[]) => engineAvailableMock(...args),
  effortLevelsForModel: vi.fn(() => ["low", "medium", "high"]),
  // No engine here configures a fallbackModelMap, so the substitute-model
  // resolver never gets as far as asking the registry what it serves.
  getModelRegistry: vi.fn(() => ({})),
  // The chain walker's module reads both of these at load time.
  ENGINE_NAMES: ["claude", "codex", "antigravity", "grok", "pi", "hermes"],
  isKnownEngine: (name: string) => ["claude", "codex", "antigravity", "grok", "pi", "hermes"].includes(name),
}));

// Registry side effects — no real DB.
const getSessionMock = vi.fn();
const updateSessionForAttemptMock = vi.fn((_id: string, _token: string, updates: Partial<Session>) => makeSession(updates));
vi.mock("../registry.js", () => ({
  getSession: (...a: unknown[]) => getSessionMock(...a),
  getMessages: vi.fn(() => []),
  updateSessionForAttempt: (...a: Parameters<typeof updateSessionForAttemptMock>) => updateSessionForAttemptMock(...a),
  // Faithful enough for the calls this module makes: it only ever reads an
  // INACTIVE engine's ref, where the real accessor also skips the mirror.
  getEngineSessionRef: (session: Session, engine: string) => session.engineSessions?.[engine] ?? {},
  nextEngineSessionFields: (session: Session, engine: string, id: string) => ({
    engineSessions: { ...(session.engineSessions ?? {}), [engine]: { id } },
    ...(session.engine === engine ? { engineSessionId: id } : {}),
  }),
}));

vi.mock("../engine-run-mcp.js", () => ({ resolveEngineRunMcp: vi.fn(() => ({})) }));

const recordClaudeRateLimitMock = vi.fn();
vi.mock("../../shared/usageAwareness.js", () => ({
  recordClaudeRateLimit: (...a: unknown[]) => recordClaudeRateLimitMock(...a),
}));

vi.mock("../../shared/effort.js", () => ({
  resolveEffort: vi.fn(() => "medium"),
}));

vi.mock("../../shared/logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

// rateLimit math: zero delay; deadline already in the past so the wait-and-retry
// loop (Branch B) exits immediately without sleeping or calling engine.run.
vi.mock("../../shared/rateLimit.js", () => ({
  computeNextRetryDelayMs: vi.fn(() => ({ delayMs: 0, resumeAt: undefined })),
  computeRateLimitDeadlineMs: vi.fn(() => Date.now() - 1),
  detectRateLimit: vi.fn(() => ({ limited: false })),
  rateLimitEngineLabel: (engine: string) => engine === "codex" ? "Codex" : "Claude",
}));

import { makeSession } from "./helpers/session-fixture.js";
import { handleRateLimit, type RateLimitHandlerOpts } from "../rate-limit-handler.js";
import { applyLegacyFallbackMigration } from "../../shared/engine-fallback.js";
import { computeNextRetryDelayMs, computeRateLimitDeadlineMs } from "../../shared/rateLimit.js";
import type { Session, EngineResult } from "../../shared/types.js";

/** A deprecated `sessions` pair, mapped onto engines.claude.fallback the way loadConfig maps it. */
function legacyFallbackConfig(): RateLimitHandlerOpts["config"] {
  const config = {
    sessions: { rateLimitStrategy: "fallback", fallbackEngine: "codex" },
    engines: {
      claude: { bin: "claude", model: "opus" },
      codex: { bin: "codex", model: "gpt-5.3-codex" },
    },
  } as unknown as RateLimitHandlerOpts["config"];
  applyLegacyFallbackMigration(config, () => {});
  return config;
}

function makeOpts(fallbackRun: ReturnType<typeof vi.fn>): RateLimitHandlerOpts {
  const session = makeSession();
  const fallbackEngine = { run: fallbackRun } as unknown as RateLimitHandlerOpts["engine"];
  const claudeEngine = { run: vi.fn() } as unknown as RateLimitHandlerOpts["engine"];
  return {
    session,
    attemptToken: "attempt-1",
    prompt: "hello",
    engineConfig: { bin: "claude", model: "opus" },
    config: legacyFallbackConfig(),
    engines: new Map([["codex", fallbackEngine]]),
    engine: claudeEngine,
    rateLimit: { resetsAt: undefined },
    originalResult: { result: "", sessionId: "claude-thread-1" } as EngineResult,
    hooks: {},
  };
}

describe("handleRateLimit — Codex fallback guard (#40)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // getSession is consulted inside both branches; return the live session.
    getSessionMock.mockImplementation(() => makeSession());
  });

  it("falls through to wait-and-retry when the fallback engine is NOT installed", async () => {
    engineAvailableMock.mockReturnValue(false);
    const fallbackRun = vi.fn(async () => ({ result: "from-codex", sessionId: "codex-1" }) as EngineResult);

    const outcome = await handleRateLimit(makeOpts(fallbackRun));

    // Branch A skipped → no Codex spawn.
    expect(fallbackRun).not.toHaveBeenCalled();
    expect(outcome.kind).not.toBe("fallback");
    // With a past deadline, Branch B exits straight to timeout.
    expect(outcome.kind).toBe("timeout");
  });

  it("never hands a board walk turn to a fallback engine, which would bring its own tools", async () => {
    engineAvailableMock.mockReturnValue(true);
    const fallbackRun = vi.fn(async () => ({ result: "from-codex", sessionId: "codex-1" }) as EngineResult);
    const opts = makeOpts(fallbackRun);
    const walkTurn = makeSession({ sessionKey: "board-walk:2026-10-02T09:00:00.000Z", sourceRef: "board-walk:2026-10-02T09:00:00.000Z", source: "cron" });

    const outcome = await handleRateLimit({ ...opts, session: walkTurn });

    expect(fallbackRun).not.toHaveBeenCalled();
    expect(outcome.kind).toBe("timeout");
  });

  it("uses the Codex fallback when the fallback engine IS installed", async () => {
    engineAvailableMock.mockReturnValue(true);
    const fallbackRun = vi.fn(async () => ({ result: "from-codex", sessionId: "codex-1" }) as EngineResult);

    const outcome = await handleRateLimit(makeOpts(fallbackRun));

    expect(fallbackRun).toHaveBeenCalledTimes(1);
    expect(outcome.kind).toBe("fallback");
    if (outcome.kind === "fallback") {
      expect(outcome.result.result).toBe("from-codex");
    }
  });

  it("tells the fallback hook which engine took over, while the session still names the limited one", async () => {
    engineAvailableMock.mockReturnValue(true);
    const opts = makeOpts(vi.fn(async () => ({ result: "from-codex" }) as EngineResult));
    const seen: { engine: string; substitute: string }[] = [];

    await handleRateLimit({
      ...opts,
      hooks: { onFallbackStart: ({ substitute }) => { seen.push({ engine: opts.session.engine, substitute }); } },
    });

    // The hook fires BEFORE the session is flipped to the substitute, which is
    // what lets the announcement read the limited engine straight off it.
    expect(seen).toEqual([{ engine: "claude", substitute: "codex" }]);
  });

  it("never hands Claude's thread id to the fallback engine, and records Codex's typed", async () => {
    engineAvailableMock.mockReturnValue(true);
    const fallbackRun = vi.fn(async () => ({ result: "from-codex", sessionId: "codex-1" }) as EngineResult);

    await handleRateLimit(makeOpts(fallbackRun));

    // No typed codex ref exists yet, so the fallback starts a fresh thread rather
    // than resuming Claude's — the mirror is never consulted for another engine.
    expect(fallbackRun).toHaveBeenCalledWith(expect.objectContaining({ resumeSessionId: undefined }));
    // The flip parks Claude's id in its typed ref and empties the mirror.
    expect(updateSessionForAttemptMock).toHaveBeenCalledWith("sess-1", "attempt-1", expect.objectContaining({
      engine: "codex",
      engineSessionId: null,
      // Claude's model goes with Claude: nothing is mapped, so the substitute
      // runs on its own default rather than on a pin it cannot serve (PLA-202).
      model: null,
      engineSessions: { claude: { id: "claude-thread-1" } },
    }));
    // The post-run write records the fallback's own thread id, typed.
    expect(updateSessionForAttemptMock).toHaveBeenCalledWith("sess-1", "attempt-1", expect.objectContaining({
      engineSessions: expect.objectContaining({ codex: { id: "codex-1" } }),
    }));
  });
});

describe("handleRateLimit — wait cancellation", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("cancels a long wait when the session leaves waiting status", async () => {
    vi.useFakeTimers();
    engineAvailableMock.mockReturnValue(false);
    vi.mocked(computeNextRetryDelayMs).mockReturnValue({ delayMs: 10_000, resumeAt: undefined });
    vi.mocked(computeRateLimitDeadlineMs).mockReturnValue(Date.now() + 60_000);

    let status: Session["status"] = "waiting";
    getSessionMock.mockImplementation(() => makeSession({ status }));
    const retryEngine = { run: vi.fn(async () => ({ result: "retry", sessionId: "claude-thread-1" }) as EngineResult) };
    const opts = {
      ...makeOpts(vi.fn()),
      config: {
        sessions: { rateLimitStrategy: "wait" },
        engines: { claude: { bin: "claude", model: "opus" } },
      } as unknown as RateLimitHandlerOpts["config"],
      engine: retryEngine as unknown as RateLimitHandlerOpts["engine"],
      hooks: {
        onWaitingStart: () => {
          setTimeout(() => { status = "idle"; }, 1000);
        },
      },
    } satisfies RateLimitHandlerOpts;

    const outcomePromise = handleRateLimit(opts);
    await vi.advanceTimersByTimeAsync(5000);
    const outcome = await outcomePromise;

    expect(outcome.kind).toBe("cancelled");
    expect(retryEngine.run).not.toHaveBeenCalled();
  });

  it("forwards an explicit platform context refresh to the resumed retry", async () => {
    vi.useFakeTimers();
    engineAvailableMock.mockReturnValue(false);
    vi.mocked(computeNextRetryDelayMs).mockReturnValue({ delayMs: 0, resumeAt: undefined });
    vi.mocked(computeRateLimitDeadlineMs).mockReturnValue(Date.now() + 60_000);
    getSessionMock.mockImplementation(() => makeSession({ status: "waiting" }));
    const retryEngine = { run: vi.fn(async () => ({ result: "retry", sessionId: "claude-thread-1" }) as EngineResult) };
    const refresh = "## Jinn platform context refresh\n- Active model: opus";
    const opts = {
      ...makeOpts(vi.fn()),
      config: {
        sessions: { rateLimitStrategy: "wait" },
        engines: { claude: { bin: "claude", model: "opus" } },
      } as unknown as RateLimitHandlerOpts["config"],
      engine: retryEngine as unknown as RateLimitHandlerOpts["engine"],
      platformContextRefresh: refresh,
      hooks: {},
    } as RateLimitHandlerOpts & { platformContextRefresh: string };

    const outcome = await handleRateLimit(opts);

    expect(outcome.kind).toBe("resumed");
    expect(retryEngine.run).toHaveBeenCalledWith(expect.objectContaining({ platformContextRefresh: refresh }));
  });

  it("retries a historical Talk session through the generic web runtime", async () => {
    vi.useFakeTimers();
    engineAvailableMock.mockReturnValue(false);
    vi.mocked(computeNextRetryDelayMs).mockReturnValue({ delayMs: 0, resumeAt: undefined });
    vi.mocked(computeRateLimitDeadlineMs).mockReturnValue(Date.now() + 60_000);
    const historical = makeSession({
      source: "talk",
      sourceRef: "talk:historical-rate-limit",
      status: "waiting",
    });
    getSessionMock.mockImplementation(() => historical);
    const retryEngine = { run: vi.fn(async () => ({ result: "retry", sessionId: "claude-thread-1" }) as EngineResult) };
    const opts = {
      ...makeOpts(vi.fn()),
      session: historical,
      config: {
        sessions: { rateLimitStrategy: "wait" },
        engines: { claude: { bin: "claude", model: "opus" } },
      } as unknown as RateLimitHandlerOpts["config"],
      engine: retryEngine as unknown as RateLimitHandlerOpts["engine"],
      hooks: {},
    } satisfies RateLimitHandlerOpts;

    const outcome = await handleRateLimit(opts);

    expect(outcome.kind).toBe("resumed");
    expect(retryEngine.run).toHaveBeenCalledWith(expect.objectContaining({ source: "web" }));
    expect(historical.source).toBe("talk");
  });

  it("labels a Codex limit as Codex without contaminating Claude usage awareness", async () => {
    vi.clearAllMocks();
    engineAvailableMock.mockReturnValue(false);
    vi.mocked(computeNextRetryDelayMs).mockReturnValue({ delayMs: 0, resumeAt: undefined });
    vi.mocked(computeRateLimitDeadlineMs).mockReturnValue(Date.now() - 1);
    const codexSession = makeSession({
      engine: "codex",
      engineSessionId: "codex-thread-1",
      model: "gpt-5.6-sol",
    });
    getSessionMock.mockImplementation(() => codexSession);

    const outcome = await handleRateLimit({
      ...makeOpts(vi.fn()),
      session: codexSession,
      engineConfig: { bin: "codex", model: "gpt-5.6-sol" },
      config: {
        sessions: { rateLimitStrategy: "wait" },
        engines: { codex: { bin: "codex", model: "gpt-5.6-sol" } },
      } as unknown as RateLimitHandlerOpts["config"],
      engine: { run: vi.fn() } as unknown as RateLimitHandlerOpts["engine"],
      originalResult: { result: "", sessionId: "codex-thread-1" } as EngineResult,
      hooks: {},
    });

    expect(outcome.kind).toBe("timeout");
    expect(updateSessionForAttemptMock).toHaveBeenCalledWith(
      codexSession.id,
      "attempt-1",
      expect.objectContaining({
        status: "waiting",
        lastError: "Codex usage limit — waiting for reset",
      }),
    );
    expect(recordClaudeRateLimitMock).not.toHaveBeenCalled();
  });
});
