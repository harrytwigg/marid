import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * A rate-limited turn of a department-scoped session keeps the stage directory as its
 * cwd on every spawn it makes (FR-020b), and never moves onto another engine (FR-026a):
 * the retry after a wait, and a substitute on another Claude account, both start in the
 * stage directory; `engines.claude.fallback: [codex]` makes it wait instead.
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
import type { EngineResult, EngineRunOpts, Employee, Session } from "../../shared/types.js";


import fs from "node:fs";
import { refreshOrg } from "../../gateway/org-registry.js";
import { resolvedStageDir } from "../../gateway/department-stage/stage.js";
import { departmentStageDir } from "../../gateway/department-scope/paths.js";
import { resetDepartmentFixtures, writeDepartmentFile, writeEmployeeFile, writeSkill } from "../../gateway/__tests__/department-fixtures.js";
import { JINN_HOME } from "../../shared/paths.js";

const SLUG = "rl-scoped-dept";
const WORK2 = "/srv/operator/.claude-work2";
const WORK3 = "/srv/operator/.claude-work3";
const stageDir = () => resolvedStageDir(SLUG);

function opts(
  employee: Partial<Employee>,
  run: ReturnType<typeof vi.fn>,
  substitutes: Record<string, ReturnType<typeof vi.fn>>,
  scoped = true,
): RateLimitHandlerOpts {
  return {
    session: makeSession({ engine: "claude", engineSessionId: "thread-1", employee: scoped ? "rl-scoped-dev" : "rl-open-dev", scopeDepartment: scoped ? SLUG : null }),
    attemptToken: "attempt-1",
    prompt: "hello",
    engineConfig: { bin: "claude", model: "opus" },
    config: {
      engines: {
        claude: { bin: "claude", model: "opus", fallback: ["codex"], accounts: { work2: { configDir: WORK2, fallback: ["claude", "codex"] }, work3: { configDir: WORK3, fallback: ["codex"] } } },
        codex: { bin: "codex", model: "gpt" },
      },
    } as unknown as RateLimitHandlerOpts["config"],
    engines: new Map(Object.entries(substitutes).map(([name, fn]) => [name, { run: fn } as unknown as RateLimitHandlerOpts["engine"]])),
    engine: { run } as unknown as RateLimitHandlerOpts["engine"],
    employee: { name: scoped ? "rl-scoped-dev" : "rl-open-dev", engine: "claude", ...employee } as Employee,
    rateLimit: { resetsAt: 1_900_000_000 },
    originalResult: { result: "", sessionId: "claude-thread-1" } as EngineResult,
    hooks: {},
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  healthReading = {};
  sessionStatus = "waiting";
  deadlineMs = Date.now() + 60_000;
  resetDepartmentFixtures();
  fs.rmSync(departmentStageDir(SLUG), { recursive: true, force: true });
  writeSkill("review");
  writeDepartmentFile(SLUG, `name: ${SLUG}\nscope: scoped\nskills: [review]\n`);
  writeEmployeeFile(SLUG, "rl-scoped-dev");
  writeEmployeeFile("engineering", "rl-open-dev");
  refreshOrg();
});

describe("a scoped session that hits the limit and waits (Branch B)", () => {
  it("retries in the stage directory, not the Jinn home", async () => {
    let seen: EngineRunOpts | undefined;
    const run = vi.fn(async (o: EngineRunOpts) => { seen = o; return { result: "ok", sessionId: "claude-thread-1" } as EngineResult; });
    const outcome = await handleRateLimit(opts({}, run, {}));
    expect(outcome.kind).toBe("resumed");
    expect(seen?.cwd).toBe(stageDir());
    expect(seen?.cwd).not.toBe(JINN_HOME);
    expect(fs.existsSync(`${seen?.cwd}/CLAUDE.md`)).toBe(true);
  });

  it("waits with engines.claude.fallback: [codex] rather than move to codex", async () => {
    const codex = vi.fn(async () => ({ result: "from-codex", sessionId: "c1" }) as EngineResult);
    const run = vi.fn(async () => ({ result: "ok", sessionId: "claude-thread-1" }) as EngineResult);
    const outcome = await handleRateLimit(opts({}, run, { codex }));
    expect(codex).not.toHaveBeenCalled();
    expect(outcome.kind).toBe("resumed");
    expect(run).toHaveBeenCalledTimes(1);
  });

  it("reverts an edit to the stage directory made before the retry", async () => {
    fs.mkdirSync(stageDir(), { recursive: true });
    fs.writeFileSync(`${stageDir()}/CLAUDE.md`, "edited by the session");
    const run = vi.fn(async () => ({ result: "ok", sessionId: "claude-thread-1" }) as EngineResult);
    await handleRateLimit(opts({}, run, {}));
    expect(fs.readFileSync(`${stageDir()}/CLAUDE.md`, "utf-8")).toContain("## Department scope");
  });
});

describe("a scoped session moved onto another Claude account (Branch A)", () => {
  it("runs the substitute in the stage directory", async () => {
    let seen: EngineRunOpts | undefined;
    const substitute = vi.fn(async (o: EngineRunOpts) => { seen = o; return { result: "from-default", sessionId: "d1" } as EngineResult; });
    const outcome = await handleRateLimit(opts({ claudeConfigDir: WORK2 }, vi.fn(), { claude: substitute, codex: vi.fn() }));
    expect(outcome.kind).toBe("fallback");
    expect(seen?.cwd).toBe(stageDir());
    expect(seen?.claudeProfile ?? null).toBeNull();
  });

  it("skips the engine entries of its account's chain: a chain of [codex] leaves it waiting", async () => {
    const codex = vi.fn(async () => ({ result: "from-codex", sessionId: "c1" }) as EngineResult);
    const run = vi.fn(async (o: EngineRunOpts) => ({ result: "ok", sessionId: "claude-thread-1", cwd: o.cwd }) as EngineResult);
    const outcome = await handleRateLimit(opts({ claudeConfigDir: WORK3 }, run, { claude: vi.fn(), codex }));
    expect(codex).not.toHaveBeenCalled();
    expect(outcome.kind).toBe("resumed");
    expect(run.mock.calls[0]![0].cwd).toBe(stageDir());
  });

  it("an unscoped session still runs in the Jinn home, and still falls back to codex", async () => {
    let seen: EngineRunOpts | undefined;
    const codex = vi.fn(async (o: EngineRunOpts) => { seen = o; return { result: "from-codex", sessionId: "c1" } as EngineResult; });
    const outcome = await handleRateLimit(opts({}, vi.fn(), { codex }, false));
    expect(outcome.kind).toBe("fallback");
    expect(seen?.cwd).toBe(JINN_HOME);
  });
});
