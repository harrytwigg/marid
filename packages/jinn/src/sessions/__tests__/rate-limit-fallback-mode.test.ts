import { describe, it, expect, vi, beforeEach } from "vitest";

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
import type { Session, EngineResult } from "../../shared/types.js";
import type { SessionFallbackMode } from "../../shared/session-fallback-config.js";

/**
 * The turn-level behaviour of a session's fallback mode: with a chain configured and an engine
 * installed, `fallback` hands the turn to the substitute and `auto-resume` parks the session
 * (Branch B) and never starts the substitute.
 */

function makeOpts(fallbackRun: ReturnType<typeof vi.fn>, session: Session, sessions?: Record<string, unknown>): RateLimitHandlerOpts & { waiting: ReturnType<typeof vi.fn> } {
  const waiting = vi.fn();
  return {
    session,
    attemptToken: "attempt-1",
    prompt: "hello",
    engineConfig: { bin: "claude", model: "opus" },
    config: {
      ...(sessions ? { sessions } : {}),
      engines: { claude: { bin: "claude", model: "opus", fallback: ["codex"] }, codex: { bin: "codex", model: "gpt-5.3-codex" } },
    } as unknown as RateLimitHandlerOpts["config"],
    engines: new Map([["codex", { run: fallbackRun } as unknown as RateLimitHandlerOpts["engine"]]]),
    engine: { run: vi.fn() } as unknown as RateLimitHandlerOpts["engine"],
    rateLimit: { resetsAt: undefined },
    originalResult: { result: "", sessionId: "claude-thread-1" } as EngineResult,
    hooks: { onWaitingStart: waiting },
    waiting,
  };
}

describe("handleRateLimit — per-session fallback mode", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    engineAvailableMock.mockReturnValue(true);
    getSessionMock.mockImplementation(() => makeSession());
  });

  it("an auto-resume session with a configured chain never substitutes and enters waiting", async () => {
    const fallbackRun = vi.fn(async () => ({ result: "from-codex", sessionId: "codex-1" }) as EngineResult);
    const opts = makeOpts(fallbackRun, makeSession({ fallbackMode: "auto-resume" }));

    const outcome = await handleRateLimit(opts);

    expect(fallbackRun).not.toHaveBeenCalled();
    expect(outcome.kind).not.toBe("fallback");
    expect(updateSessionForAttemptMock).toHaveBeenCalledWith("sess-1", "attempt-1", expect.objectContaining({ status: "waiting" }));
    expect(updateSessionForAttemptMock).not.toHaveBeenCalledWith("sess-1", "attempt-1", expect.objectContaining({ engine: "codex" }));
    expect(opts.waiting).toHaveBeenCalledTimes(1);
  });

  it("the same session in fallback substitutes, and never waits", async () => {
    const fallbackRun = vi.fn(async () => ({ result: "from-codex", sessionId: "codex-1" }) as EngineResult);
    const opts = makeOpts(fallbackRun, makeSession({ fallbackMode: "fallback" }));

    const outcome = await handleRateLimit(opts);

    expect(fallbackRun).toHaveBeenCalledTimes(1);
    expect(outcome.kind).toBe("fallback");
    expect(opts.waiting).not.toHaveBeenCalled();
  });

  it.each<[string, SessionFallbackMode | null, "auto-resume" | "fallback", boolean]>([
    ["a session with no mode takes the config's auto-resume", null, "auto-resume", false],
    ["a session with no mode takes the config's fallback", null, "fallback", true],
    ["a session's own fallback outranks the config's auto-resume", "fallback", "auto-resume", true],
    ["a session's own auto-resume outranks the config's fallback", "auto-resume", "fallback", false],
  ])("%s", async (_name, own, configured, substitutes) => {
    const fallbackRun = vi.fn(async () => ({ result: "from-codex", sessionId: "codex-1" }) as EngineResult);
    await handleRateLimit(makeOpts(fallbackRun, makeSession({ fallbackMode: own }), { fallbackMode: configured }));
    expect(fallbackRun).toHaveBeenCalledTimes(substitutes ? 1 : 0);
  });
});
