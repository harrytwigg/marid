import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * A rate-limited turn on a local named Claude profile (FR-055, FR-056): the
 * limit is that account's alone, it has no fallback chain until accounts get
 * their own, so it waits for its own reset and retries on the same profile. A
 * remote employee with `remoteClaudeConfigDir` keeps main's behaviour and
 * still inherits the engine chain, limited to engines its host can run.
 */

const engineAvailableMock = vi.fn<(...args: unknown[]) => boolean>(() => true);
vi.mock("../../shared/models.js", () => ({
  engineAvailable: (...args: unknown[]) => engineAvailableMock(...args),
  effortLevelsForModel: vi.fn(() => ["low", "medium", "high"]),
  getModelRegistry: vi.fn(() => ({})),
  ENGINE_NAMES: ["claude", "codex", "antigravity", "grok", "pi", "hermes", "opencode"],
  REMOTE_ENGINE_NAMES: ["claude", "pi", "opencode"],
  engineSupportsRemote: (name: string) => ["claude", "pi", "opencode"].includes(name),
  isKnownEngine: (name: string) => ["claude", "codex", "antigravity", "grok", "pi", "hermes", "opencode"].includes(name),
}));
vi.mock("../engine-run-mcp.js", () => ({ resolveEngineRunMcp: vi.fn(() => ({})) }));
vi.mock("../../engines/remote-stage.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../engines/remote-stage.js")>()),
  remoteEngineAvailable: vi.fn(() => true),
}));

let sessionStatus = "waiting";
vi.mock("../registry.js", () => ({
  getSession: () => makeSession({ engine: "claude", engineSessionId: "claude-thread-1", status: sessionStatus as any }),
  getMessages: vi.fn(() => []),
  updateSessionForAttempt: vi.fn((_id: string, _token: string, updates: Partial<Session>) => makeSession({ ...updates })),
  getEngineSessionRef: (session: Session, engine: string) => session.engineSessions?.[engine] ?? {},
  nextEngineSessionFields: () => ({}),
}));

const recordClaudeRateLimitMock = vi.fn();
vi.mock("../../shared/usageAwareness.js", () => ({ recordClaudeRateLimit: (...a: unknown[]) => recordClaudeRateLimitMock(...a) }));
let healthReading: Record<string, { state: string; until?: string; recheckAt?: string }> = {};
const recordEngineUnavailableMock = vi.fn();
vi.mock("../../shared/engine-health.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../shared/engine-health.js")>()),
  readEngineHealth: () => healthReading,
  recordEngineUnavailable: (...args: unknown[]) => recordEngineUnavailableMock(...args),
}));
vi.mock("../../shared/logger.js", () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));

let deadlineMs = Date.now() - 1;
vi.mock("../../shared/rateLimit.js", () => ({
  computeNextRetryDelayMs: vi.fn(() => ({ delayMs: 0, resumeAt: undefined })),
  computeRateLimitDeadlineMs: vi.fn(() => deadlineMs),
  detectRateLimit: vi.fn(() => ({ limited: false })),
  rateLimitEngineLabel: (engine: string) => engine[0]!.toUpperCase() + engine.slice(1),
}));

import { makeSession } from "./helpers/session-fixture.js";
import { handleRateLimit, type RateLimitHandlerOpts } from "../rate-limit-handler.js";
import { claudeProfileFromDir } from "../../shared/claude-profile.js";
import type { EngineResult, EngineRunOpts, Employee, Session } from "../../shared/types.js";

const FRIEND = "/Users/operator/.claude-friend";
const friendProfile = claudeProfileFromDir(FRIEND);

function opts(
  employee: Partial<Employee>,
  run: ReturnType<typeof vi.fn>,
  substitutes: Record<string, ReturnType<typeof vi.fn>>,
  engine = "claude",
): RateLimitHandlerOpts {
  return {
    session: makeSession({ engine, engineSessionId: "thread-1" }),
    attemptToken: "attempt-1",
    prompt: "hello",
    engineConfig: { bin: "claude", model: "opus" },
    config: {
      engines: {
        claude: { bin: "claude", model: "opus", fallback: ["codex", "pi"] },
        codex: { bin: "codex", model: "gpt", fallback: ["claude"] },
        pi: { bin: "pi", model: "m" },
      },
      remote: { root: "/srv/w", mount: "/mnt/h" },
    } as unknown as RateLimitHandlerOpts["config"],
    engines: new Map(Object.entries(substitutes).map(([name, fn]) => [name, { run: fn } as unknown as RateLimitHandlerOpts["engine"]])),
    engine: { run } as unknown as RateLimitHandlerOpts["engine"],
    employee: { name: "e", engine: "claude", ...employee } as Employee,
    rateLimit: { resetsAt: 1_900_000_000 },
    originalResult: { result: "", sessionId: "claude-thread-1" } as EngineResult,
    hooks: {},
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  healthReading = {};
  sessionStatus = "waiting";
  deadlineMs = Date.now() - 1;
});

describe("a local named profile hits its limit", () => {
  it("records the limit under its own account, never the default's", async () => {
    await handleRateLimit(opts({ claudeConfigDir: FRIEND }, vi.fn(), {}));
    expect(recordEngineUnavailableMock).toHaveBeenCalledWith(`claude:${friendProfile.key}`, "Claude usage limit", 1_900_000_000);
    expect(recordEngineUnavailableMock).not.toHaveBeenCalledWith("claude", expect.anything(), expect.anything());
    expect(recordClaudeRateLimitMock).toHaveBeenCalledWith(1_900_000_000, `claude:${friendProfile.key}`);
  });

  it("is not handed to the default account's fallback chain", async () => {
    const codex = vi.fn(async () => ({ result: "from-codex", sessionId: "c1" }) as EngineResult);
    const outcome = await handleRateLimit(opts({ claudeConfigDir: FRIEND }, vi.fn(), { codex }));
    expect(codex).not.toHaveBeenCalled();
    expect(outcome.kind).toBe("timeout");
  });

  it("waits and retries on the same profile", async () => {
    deadlineMs = Date.now() + 60_000;
    let seen: EngineRunOpts | undefined;
    const run = vi.fn(async (o: EngineRunOpts) => { seen = o; return { result: "ok", sessionId: "claude-thread-1" } as EngineResult; });
    const outcome = await handleRateLimit(opts({ claudeConfigDir: FRIEND }, run, { codex: vi.fn() }));
    expect(outcome.kind).toBe("resumed");
    expect(seen?.claudeProfile).toEqual(friendProfile);
  });
});

describe("the default profile and remote employees keep main's behaviour", () => {
  it("a default-profile session records under `claude` and falls back down the chain", async () => {
    const codex = vi.fn(async () => ({ result: "from-codex", sessionId: "c1" }) as EngineResult);
    const outcome = await handleRateLimit(opts({}, vi.fn(), { codex }));
    expect(recordEngineUnavailableMock).toHaveBeenCalledWith("claude", "Claude usage limit", 1_900_000_000);
    expect(recordClaudeRateLimitMock).toHaveBeenCalledWith(1_900_000_000, "claude");
    expect(codex).toHaveBeenCalledTimes(1);
    expect(outcome.kind).toBe("fallback");
  });

  it("a remote employee with remoteClaudeConfigDir still inherits the chain, limited to engines its host can run", async () => {
    const codex = vi.fn(async () => ({ result: "from-codex", sessionId: "c1" }) as EngineResult);
    const pi = vi.fn(async () => ({ result: "from-pi", sessionId: "p1" }) as EngineResult);
    const outcome = await handleRateLimit(opts(
      { remoteHost: "build-box", remoteCwd: "/srv/w/proj", remoteClaudeConfigDir: "/home/b/.claude-work" },
      vi.fn(),
      { codex, pi },
    ));
    expect(codex).not.toHaveBeenCalled();
    expect(pi).toHaveBeenCalledTimes(1);
    expect(outcome.kind).toBe("fallback");
    expect(recordEngineUnavailableMock).toHaveBeenCalledWith("claude", "Claude usage limit", 1_900_000_000);
  });
});

describe("a substitute that lands on claude, for an employee on a named profile", () => {
  const hourAhead = () => new Date(Date.now() + 3600_000).toISOString();

  it("runs on the employee's profile", async () => {
    let seen: EngineRunOpts | undefined;
    const claude = vi.fn(async (o: EngineRunOpts) => { seen = o; return { result: "ok", sessionId: "c1" } as EngineResult; });
    const outcome = await handleRateLimit(opts({ claudeConfigDir: FRIEND }, vi.fn(), { claude }, "codex"));
    expect(outcome.kind).toBe("fallback");
    expect(seen?.claudeProfile).toEqual(friendProfile);
  });

  it("is judged on the employee's own account, not the default account's", async () => {
    // The operator's account is out; the employee's own is not, so claude is still a good substitute.
    healthReading = { claude: { state: "exhausted", until: hourAhead(), recheckAt: hourAhead() } };
    const claude = vi.fn(async () => ({ result: "ok", sessionId: "c1" }) as EngineResult);
    const pi = vi.fn(async () => ({ result: "ok", sessionId: "p1" }) as EngineResult);
    const config = opts({ claudeConfigDir: FRIEND }, vi.fn(), { claude, pi }, "codex");
    (config.config.engines as any).codex.fallback = ["claude", "pi"];
    await handleRateLimit(config);
    expect(claude).toHaveBeenCalledTimes(1);
    expect(pi).not.toHaveBeenCalled();
  });

  it("skips claude when the employee's own account is the one that is out", async () => {
    healthReading = { [`claude:${friendProfile.key}`]: { state: "exhausted", until: hourAhead(), recheckAt: hourAhead() } };
    const claude = vi.fn(async () => ({ result: "ok", sessionId: "c1" }) as EngineResult);
    const pi = vi.fn(async () => ({ result: "ok", sessionId: "p1" }) as EngineResult);
    const config = opts({ claudeConfigDir: FRIEND }, vi.fn(), { claude, pi }, "codex");
    (config.config.engines as any).codex.fallback = ["claude", "pi"];
    await handleRateLimit(config);
    expect(claude).not.toHaveBeenCalled();
    expect(pi).toHaveBeenCalledTimes(1);
  });

  it("a default-profile employee's claude substitute carries no profile", async () => {
    let seen: EngineRunOpts | undefined;
    const claude = vi.fn(async (o: EngineRunOpts) => { seen = o; return { result: "ok", sessionId: "c1" } as EngineResult; });
    await handleRateLimit(opts({}, vi.fn(), { claude }, "codex"));
    expect(seen?.claudeProfile).toBeNull();
  });
});
