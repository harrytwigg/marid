import { describe, it, expect, vi, beforeEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// The health store and the context builder resolve the instance home at import,
// so it has to be a throwaway before anything under test is pulled in.
process.env.JINN_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "jinn-engine-swap-floor-"));

// Registry side effects only — the model registry, the fallback walk, the model
// resolver and preflight all run for real, because "a model the substitute
// serves" is only worth asserting against the registry that actually answers it.
const getSessionMock = vi.fn();
const updateSessionForAttemptMock = vi.fn((_id: string, _token: string, updates: unknown) => updates as never);
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

// Zero delay, deadline already past: Branch B exits without sleeping if it is ever reached.
vi.mock("../../shared/rateLimit.js", () => ({
  computeNextRetryDelayMs: vi.fn(() => ({ delayMs: 0, resumeAt: undefined })),
  computeRateLimitDeadlineMs: vi.fn(() => Date.now() - 1),
  detectRateLimit: vi.fn(() => ({ limited: false })),
  nextUnstatedParkDelayMs: vi.fn(() => 0),
  MAX_UNSTATED_PARK_ATTEMPTS: 3,
  rateLimitEngineLabel: (engine: string) => (engine === "codex" ? "Codex" : "Claude"),
}));

vi.mock("../../shared/usageAwareness.js", () => ({
  recordClaudeRateLimit: vi.fn(),
  isLikelyNearClaudeUsageLimit: vi.fn(() => false),
  getClaudeExpectedResetAt: vi.fn(() => undefined),
}));

import { makeSession } from "./helpers/session-fixture.js";
import { handleRateLimit, type RateLimitHandlerOpts } from "../rate-limit-handler.js";
import { preflightTurn } from "../turn/preflight.js";
import type { TurnInput } from "../turn/types.js";
import { getModelRegistry, invalidateModelRegistry } from "../../shared/models.js";
import type { EngineResult, JinnConfig, Session } from "../../shared/types.js";

/**
 * The incident: codex hit its usage limit on a session pinned
 * to `gpt-5.6-luna`, the swap rewrote `engine` to claude and left the pin alone,
 * and the session's NEXT turn asked Anthropic for a codex model — `model_not_found`.
 * The swap and the turn after it are asserted together here because the bug lived
 * in the gap between them: each half looked correct on its own.
 */

const PINNED_MODEL = "gpt-5.6-luna";

/** Both engines installed, codex falling through to claude, with the catalog the
 *  real registry answers "does claude serve this?" from. */
function config(fallbackModelMap?: Record<string, string>): JinnConfig {
  return {
    gateway: { port: 7779, host: "127.0.0.1" },
    engines: {
      default: "codex",
      claude: { bin: process.execPath, model: "opus" },
      codex: { bin: process.execPath, model: "gpt-5.6-sol", fallback: ["claude"], ...(fallbackModelMap ? { fallbackModelMap } : {}) },
    },
    models: {
      claude: {
        default: "opus",
        models: [
          { id: "opus", supportsEffort: true, effortLevels: ["low", "medium", "high"] },
          { id: "haiku", supportsEffort: true, effortLevels: ["low", "medium", "high"] },
        ],
      },
      codex: {
        default: "gpt-5.6-sol",
        models: [
          { id: "gpt-5.6-sol", supportsEffort: true, effortLevels: ["low", "medium", "high", "xhigh"] },
          { id: PINNED_MODEL, supportsEffort: true, effortLevels: ["low", "medium", "high", "xhigh"] },
        ],
      },
    },
    connectors: {},
  } as unknown as JinnConfig;
}

function limitedCodexSession(): Session {
  return makeSession({ engine: "codex", engineSessionId: "codex-thread-1", model: PINNED_MODEL });
}

function handlerOpts(cfg: JinnConfig, session: Session): RateLimitHandlerOpts {
  const stub = (result: string) => ({ run: vi.fn(async () => ({ result, sessionId: "claude-1" }) as EngineResult) });
  return {
    session,
    attemptToken: "attempt-1",
    prompt: "hello",
    engineConfig: { bin: process.execPath, model: PINNED_MODEL },
    config: cfg,
    engines: new Map([["claude", stub("from-claude")]]) as unknown as RateLimitHandlerOpts["engines"],
    engine: stub("from-codex") as unknown as RateLimitHandlerOpts["engine"],
    rateLimit: { resetsAt: undefined },
    originalResult: { result: "", sessionId: "codex-thread-1" } as EngineResult,
    hooks: {},
  } as unknown as RateLimitHandlerOpts;
}

/** The session as the swap leaves it: the fixture with Branch A's write applied. */
async function swap(cfg: JinnConfig): Promise<{ session: Session; write: Record<string, unknown> }> {
  const session = limitedCodexSession();
  getSessionMock.mockImplementation(() => session);

  const outcome = await handleRateLimit(handlerOpts(cfg, session));
  expect(outcome.kind).toBe("fallback");

  const write = updateSessionForAttemptMock.mock.calls[0][2] as Record<string, unknown>;
  return { session: { ...session, ...write } as Session, write };
}

/** What the NEXT turn on that session would actually run. */
function nextTurnModel(cfg: JinnConfig, session: Session): string | undefined {
  const plan = preflightTurn({
    session,
    attemptToken: "attempt-2",
    prompt: "and now this",
    attachments: [],
    config: cfg,
    engines: new Map([["claude", { run: vi.fn() }], ["codex", { run: vi.fn() }]]),
    gatewayBootId: "boot-1",
    connectorNames: [],
    channel: "web",
    user: "tester",
  } as unknown as TurnInput);
  expect(plan.ok).toBe(true);
  if (!plan.ok) throw new Error(plan.error);
  return plan.model;
}

function modelsClaudeServes(cfg: JinnConfig): string[] {
  return getModelRegistry(cfg).claude!.models.map((model) => model.id);
}

beforeEach(() => {
  vi.clearAllMocks();
  invalidateModelRegistry();
});

describe("rate-limit engine substitution — the model floor", () => {
  it("leaves no foreign pin on the row it hands to the substitute", async () => {
    const cfg = config();

    const { write } = await swap(cfg);

    expect(write.engine).toBe("claude");
    // Null rather than a claude model id: nothing was mapped, so the pin is simply
    // dropped and claude's own configured default applies from here on.
    expect(write.model).toBeNull();
    expect(write.model).not.toBe(PINNED_MODEL);
  });

  it("parks the pin on the override record so the revert has something to restore", async () => {
    const { write } = await swap(config());

    expect((write.transportMeta as Record<string, any>).engineOverride).toMatchObject({
      originalEngine: "codex",
      originalModel: PINNED_MODEL,
    });
  });

  it("leaves the next turn on a model the substitute serves — the original regression", async () => {
    const cfg = config();
    const { session } = await swap(cfg);

    const model = nextTurnModel(cfg, session);

    expect(model).not.toBe(PINNED_MODEL);
    expect(modelsClaudeServes(cfg)).toContain(model);
    // With nothing mapped, that is claude's configured default.
    expect(model).toBe("opus");
  });

  it("carries the pinned tier across when fallbackModelMap names a model claude serves", async () => {
    const cfg = config({ [PINNED_MODEL]: "haiku" });

    const { session, write } = await swap(cfg);

    expect(write.model).toBe("haiku");
    expect(nextTurnModel(cfg, session)).toBe("haiku");
  });

  it("runs the substituted turn itself on the resolved model, not the limited engine's", async () => {
    const cfg = config({ [PINNED_MODEL]: "haiku" });
    const session = limitedCodexSession();
    getSessionMock.mockImplementation(() => session);
    const opts = handlerOpts(cfg, session);

    await handleRateLimit(opts);

    const substitute = opts.engines.get("claude")!;
    expect(substitute.run).toHaveBeenCalledWith(expect.objectContaining({ model: "haiku" }));
  });

  it("falls to claude's own default when the map names a model claude does not serve", async () => {
    const cfg = config({ [PINNED_MODEL]: PINNED_MODEL });

    const { session, write } = await swap(cfg);

    expect(write.model).toBeNull();
    expect(nextTurnModel(cfg, session)).toBe("opus");
  });
});
