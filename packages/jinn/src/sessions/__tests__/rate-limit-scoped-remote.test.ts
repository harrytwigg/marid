import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * A rate-limited turn of a department-scoped remote session retries in its department's
 * stage directory on the host (FR-061, SC-007). With no employee record to place it by,
 * a scoped session is refused rather than retried where the turn last ran; an unscoped one
 * keeps the target it was passed.
 */
vi.mock("../../shared/models.js", () => ({
  engineAvailable: () => false,
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
vi.mock("../registry.js", () => ({
  getSession: () => makeSession({ engine: "claude", engineSessionId: "claude-thread-1", status: "waiting" }),
  getMessages: vi.fn(() => []),
  updateSessionForAttempt: vi.fn((_id: string, _token: string, updates: Partial<Session>) => makeSession({ ...updates })),
  getEngineSessionRef: (session: Session, engine: string) => session.engineSessions?.[engine] ?? {},
  nextEngineSessionFields: () => ({}),
}));
vi.mock("../../shared/usageAwareness.js", () => ({ recordClaudeRateLimit: vi.fn() }));
vi.mock("../../shared/engine-health.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../shared/engine-health.js")>()),
  readEngineHealth: () => ({}),
  recordEngineUnavailable: vi.fn(),
}));
vi.mock("../../shared/logger.js", () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));
vi.mock("../../shared/rateLimit.js", () => ({
  computeNextRetryDelayMs: vi.fn(() => ({ delayMs: 0, resumeAt: undefined })),
  computeRateLimitDeadlineMs: vi.fn(() => Date.now() + 60_000),
  detectRateLimit: vi.fn(() => ({ limited: false })),
  rateLimitEngineLabel: (engine: string) => engine[0]!.toUpperCase() + engine.slice(1),
  nextUnstatedParkDelayMs: (ms: number) => ms,
  MAX_UNSTATED_PARK_ATTEMPTS: 5,
}));

import fs from "node:fs";
import { departmentStageDir } from "../../gateway/department-scope/paths.js";
import { refreshOrg } from "../../gateway/org-registry.js";
import { resetDepartmentFixtures, writeDepartmentFile, writeEmployeeFile } from "../../gateway/__tests__/department-fixtures.js";
import type { Employee, EngineResult, EngineRunOpts, Session } from "../../shared/types.js";
import { handleRateLimit, type RateLimitHandlerOpts } from "../rate-limit-handler.js";
import { makeSession } from "./helpers/session-fixture.js";

const SLUG = "rl-remote-dept";
const STAGE = `/srv/root/.jinn-departments/${SLUG}`;
const REMOTE = { remoteHost: "build-box", remoteUser: "ci", remoteCwd: "/srv/root/work", remoteClaudeConfigDir: "/srv/profiles/a" };

const remoteEmployee = { name: "remote-rl-dev", engine: "claude", ...REMOTE } as Employee;

/**
 * `scoped: false` is a session of an employee outside the department. `lostBinding` is a session
 * of the scoped employee whose `scope_department` is gone: it is still scoped (`sessionScopeDepartment`).
 */
function opts(run: ReturnType<typeof vi.fn>, extra: Partial<RateLimitHandlerOpts> & { scoped?: boolean; lostBinding?: boolean } = {}): RateLimitHandlerOpts {
  const { scoped = true, lostBinding = false, ...rest } = extra;
  return {
    session: makeSession({ engine: "claude", engineSessionId: "claude-thread-1", employee: scoped ? "remote-rl-dev" : "remote-rl-eng", scopeDepartment: scoped && !lostBinding ? SLUG : null }),
    attemptToken: "attempt-1",
    prompt: "hello",
    engineConfig: { bin: "claude", model: "opus" },
    config: {
      engines: { claude: { bin: "claude", model: "opus" } },
      remote: { root: "/srv/root", mount: "/mnt/jinn" },
    } as unknown as RateLimitHandlerOpts["config"],
    engines: new Map(),
    engine: { run } as unknown as RateLimitHandlerOpts["engine"],
    rateLimit: { resetsAt: undefined },
    originalResult: { result: "", sessionId: "claude-thread-1" } as EngineResult,
    hooks: {},
    ...rest,
  };
}

const answered = () => vi.fn(async (_opts: EngineRunOpts) => ({ result: "ok", sessionId: "claude-thread-1" }) as EngineResult);

beforeEach(() => {
  vi.clearAllMocks();
  resetDepartmentFixtures();
  fs.rmSync(departmentStageDir(SLUG), { recursive: true, force: true });
  writeDepartmentFile(SLUG, `name: ${SLUG}\nscope: scoped\n`);
  writeEmployeeFile(SLUG, "remote-rl-dev");
  writeEmployeeFile("engineering", "remote-rl-eng");
  refreshOrg();
});

describe("a rate-limited scoped remote session (Branch B)", () => {
  it("retries in the stage directory on the host, naming its department and work area", async () => {
    const run = answered();
    const outcome = await handleRateLimit(opts(run, { employee: remoteEmployee }));
    expect(outcome.kind).toBe("resumed");
    expect(run).toHaveBeenCalledTimes(1);
    expect(run.mock.calls[0]![0]).toMatchObject({ ...REMOTE, remoteCwd: STAGE, remoteDepartment: SLUG, remoteWorkArea: "/srv/root/work" });
  });

  it("is refused before any engine runs when it has no employee record to place it by", async () => {
    const run = answered();
    const substitute = answered();
    await expect(handleRateLimit(opts(run, { ...REMOTE, engines: new Map([["codex", { run: substitute } as never]]) }))).rejects.toThrow(/Refusing to retry/);
    expect(run).not.toHaveBeenCalled();
    expect(substitute).not.toHaveBeenCalled();
  });

  it("still retries an unscoped session with no employee record on the target it was passed", async () => {
    const run = answered();
    const outcome = await handleRateLimit(opts(run, { ...REMOTE, scoped: false }));
    expect(outcome.kind).toBe("resumed");
    expect(run.mock.calls[0]![0]).toMatchObject(REMOTE);
    expect(run.mock.calls[0]![0].remoteDepartment).toBeUndefined();
  });
});

describe("a rate-limited scoped remote session whose chain names another engine (FR-026a)", () => {
  const withOpencode = (run: ReturnType<typeof vi.fn>, substitute: ReturnType<typeof vi.fn>, extra: Partial<RateLimitHandlerOpts> & { scoped?: boolean; lostBinding?: boolean } = {}) => {
    const base = opts(run, extra);
    return {
      ...base,
      config: { ...base.config, engines: { claude: { bin: "claude", model: "opus", fallback: ["opencode"] }, opencode: { bin: "opencode", model: "m" } } } as unknown as RateLimitHandlerOpts["config"],
      engines: new Map([["opencode", { name: "opencode", run: substitute } as never]]),
    };
  };

  it("is not handed to opencode on its host: it waits and retries on claude in its stage directory", async () => {
    const run = answered();
    const substitute = vi.fn();
    const outcome = await handleRateLimit(withOpencode(run, substitute, { employee: remoteEmployee }));
    expect(outcome.kind).toBe("resumed");
    expect(substitute).not.toHaveBeenCalled();
    expect(run.mock.calls[0]![0]).toMatchObject({ remoteCwd: STAGE, remoteDepartment: SLUG });
  });

  it("treats a session whose binding was lost as scoped, as its cwd and prompt do: it waits too", async () => {
    const run = answered();
    const substitute = vi.fn();
    const outcome = await handleRateLimit(withOpencode(run, substitute, { employee: remoteEmployee, lostBinding: true }));
    expect(outcome.kind).toBe("resumed");
    expect(substitute).not.toHaveBeenCalled();
    expect(run.mock.calls[0]![0]).toMatchObject({ remoteCwd: STAGE, remoteDepartment: SLUG });
  });

  it("still hands an unscoped remote session to opencode, as before", async () => {
    const run = answered();
    const substitute = vi.fn(async () => ({ result: "from opencode", sessionId: "oc-1" }) as EngineResult);
    const outcome = await handleRateLimit(withOpencode(run, substitute, { ...REMOTE, scoped: false }));
    expect(outcome.kind).toBe("fallback");
    expect(substitute).toHaveBeenCalledTimes(1);
  });
});

describe("a rate-limited local scoped session with no employee record", () => {
  it("waits and retries in its stage directory, as it always has", async () => {
    const run = answered();
    const outcome = await handleRateLimit(opts(run));
    expect(outcome.kind).toBe("resumed");
    expect(run.mock.calls[0]![0].remoteHost).toBeUndefined();
    expect(fs.realpathSync(run.mock.calls[0]![0].cwd!)).toBe(fs.realpathSync(departmentStageDir(SLUG)));
  });
});
