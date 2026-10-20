import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, vi } from "vitest";
import type { Employee, Engine, EngineResult, EngineRunOpts, JinnConfig } from "../../shared/types.js";
import type { FallbackHop } from "../../shared/fallback-chain-wire.js";

/**
 * Shared set-up for the fallback-walk suites (fallback-walk*.test.ts): the mocks, a real
 * session registry in a temporary home, scripted engines standing in for the providers,
 * and the helpers that drive `handleRateLimit`. Each suite calls `useWalkHarness()`.
 */
const signedOut = vi.hoisted(() => ({ dirs: new Set<string>() }));
const catalogue = vi.hoisted(() => ({ value: {} as Record<string, unknown> }));
// No catalogue is listed for any engine, so a link's model is never "not served": what a walk does with a model is not about discovery.
vi.mock("../../shared/models.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../shared/models.js")>()),
  engineAvailable: () => true,
  getModelRegistry: () => catalogue.value,
}));
vi.mock("../../shared/claude-profile-signin.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../shared/claude-profile-signin.js")>()),
  verifyLocalClaudeProfile: (profile: { dir: string } | null) => (profile && signedOut.dirs.has(profile.dir) ? `The Claude profile \`${profile.dir}\` is not signed in.` : undefined),
}));
// Discovering opencode's effort levels waits on a catalogue this test has no use for.
vi.mock("../../shared/effort-wait.js", () => ({ awaitEffortLevels: async () => {} }));
const authSeen = vi.hoisted(() => ({ errors: [] as Array<string | null | undefined> }));
vi.mock("../claude-auth-watch.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../claude-auth-watch.js")>()),
  refuseClaudeLaunch: () => undefined,
  observeClaudeTurnOutcome: (_employee: unknown, error: string | null | undefined) => { authSeen.errors.push(error); },
}));

export const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "jinn-fallback-walk-"));
process.env.JINN_HOME = tmp;
export const reg = await import("../registry.js");
export const { handleRateLimit } = await import("../rate-limit-handler.js");
export const { maybeRevertEngineOverride } = await import("../engine-override.js");
export const { readEngineHealth } = await import("../../shared/engine-health.js");
export const { registerEmployeeAccountResolver } = await import("../../shared/engine-account.js");
export const { claudeProfileFromDir } = await import("../../shared/claude-profile.js");
export const { readFallbackRun, readFallbackHops } = await import("../fallback-run.js");
export const { setDepartmentScopeResolver, setEmployeeDepartmentResolver } = await import("../../work-items/department-scope.js");

export const DIR_A = path.join(tmp, "claude-a");
export const DIR_B = path.join(tmp, "claude-b");
export const DIR_C = path.join(tmp, "claude-c");
export const profileA = claudeProfileFromDir(DIR_A);
export const ACCOUNT_A = `claude:${profileA.key}`;
export const HOUR = 3600;
export const resetsIn = (seconds: number) => Math.floor(Date.now() / 1000) + seconds;

export const config = {
  gateway: {},
  sessions: {},
  engines: {
    default: "claude",
    claude: { bin: "claude", model: "opus", accounts: { A: { configDir: DIR_A }, B: { configDir: DIR_B }, C: { configDir: DIR_C } } },
    opencode: { bin: "opencode" },
    codex: { bin: "codex", model: "gpt" },
  },
} as unknown as JinnConfig;

export const CLAUDE_B = { engine: "claude", profile: "B", model: "sonnet" };
export const OPENCODE_X = { engine: "opencode", model: "x-provider/model-x" };
export const OPENCODE_Y = { engine: "opencode", model: "y-provider/model-y" };
export const key = (link: { engine: string; profile?: string; model?: string }) => `${link.engine}|${link.profile ?? ""}|${link.model ?? ""}`;

export function employee(extra: Partial<Employee> = {}): Employee {
  return { name: "worker-a", engine: "claude", claudeConfigDir: DIR_A, fallback: [CLAUDE_B, OPENCODE_X, OPENCODE_Y], ...extra } as Employee;
}

export interface Call { engine: string; profileDir: string | null; model: string | undefined; resume: string | undefined; prompt: string }

/** Engines that answer by script, and a record of every call they took. */
export function scripted(script: (call: Call, n: number) => EngineResult) {
  const calls: Call[] = [];
  const make = (name: string): Engine => ({
    name,
    async run(opts: EngineRunOpts) {
      const call = { engine: name, profileDir: opts.claudeProfile?.dir ?? null, model: opts.model, resume: opts.resumeSessionId, prompt: opts.prompt };
      calls.push(call);
      return script(call, calls.length);
    },
  } as Engine);
  const engines = new Map<string, Engine>([["claude", make("claude")], ["opencode", make("opencode")], ["codex", make("codex")]]);
  return { engines, calls };
}

export const limited = (resetsAt = resetsIn(HOUR), error = "429 Too Many Requests"): EngineResult => ({ sessionId: "", result: "", error, rateLimit: { status: "rejected", resetsAt } });
export const answer = (text: string, sessionId = "served-thread"): EngineResult => ({ sessionId, result: text });
export const failed = (error: string): EngineResult => ({ sessionId: "", result: "", error });

/** Whose turn it is by profile and model: `A/opus`, `B/sonnet`, `x-provider/model-x`. */
export const who = (call: Call): string => (call.engine === "claude" ? `${{ [DIR_A]: "A", [DIR_B]: "B", [DIR_C]: "C" }[call.profileDir ?? ""] ?? "default"}/${call.model}` : `${call.model}`);

export function newSession(opts: { ref: string; employeeName?: string; model?: string; engine?: string } = { ref: "web:walk" }): string {
  const s = reg.createSession({ engine: opts.engine ?? "claude", source: "web", sourceRef: opts.ref, model: opts.model ?? "opus", employee: opts.employeeName ?? "worker-a" });
  reg.recordEngineSessionId(s.id, opts.engine ?? "claude", "a-thread");
  return s.id;
}

export function recordingHooks() {
  const seen = { starts: [] as Array<{ substitute: string; model?: string; hop?: FallbackHop }>, waiting: [] as Array<{ reason?: string; hop?: FallbackHop; exhausted?: { tried: string[]; own: string } }>, completes: [] as Array<{ engine: string; model?: string }>, failed: [] as EngineResult[] };
  return {
    seen,
    hooks: {
      onFallbackStart: (info: { substitute: string; model?: string; hop?: FallbackHop }) => { seen.starts.push(info); },
      onFallbackFailed: (result: EngineResult) => { seen.failed.push(result); },
      onFallbackComplete: (_result: EngineResult, ran: { engine: string; model?: string }) => { seen.completes.push(ran); },
      onWaitingStart: (info: { reason?: string; hop?: FallbackHop; exhausted?: { tried: string[]; own: string } }) => { seen.waiting.push(info); },
    },
  };
}

/** The limited turn of session `id`, as the runner hands it to `handleRateLimit`. */
export function limitedTurn(id: string, who: Employee | undefined, engines: Map<string, Engine>, extra: { prompt?: string; resetsAt?: number } = {}) {
  const started = reg.beginSessionAttempt(id)!;
  const { seen, hooks } = recordingHooks();
  const session = reg.getSession(id)!;
  const opts = {
    session, attemptToken: started.attemptToken!, prompt: extra.prompt ?? "now publish them", engineConfig: { model: session.model ?? undefined }, config, engines, employee: who,
    engine: engines.get(session.engine)!, rateLimit: { resetsAt: extra.resetsAt ?? resetsIn(HOUR) }, originalResult: limited(extra.resetsAt), hooks,
  };
  return { opts: opts as unknown as Parameters<typeof handleRateLimit>[0], seen };
}

export const hopsOf = (id: string): FallbackHop[] => readFallbackHops(reg.getSession(id)!.transportMeta as Record<string, unknown>);
export const runOf = (id: string) => readFallbackRun(reg.getSession(id)!.transportMeta as Record<string, unknown>);
export const overrideOf = (id: string) => (reg.getSession(id)!.transportMeta as Record<string, Record<string, unknown>> | null)?.engineOverride;

/** The per-test reset every walk suite needs. */
export function useWalkHarness(): void {
  beforeEach(async () => {
    const db = (await import("../../shared/db.js")).initDb();
    db.exec("DELETE FROM messages; DELETE FROM queue_items; DELETE FROM sessions;");
    fs.rmSync(path.join(tmp, "tmp", "engine-health.json"), { force: true });
    registerEmployeeAccountResolver((name) => (name === "worker-a" ? ACCOUNT_A : undefined));
    signedOut.dirs.clear();
    catalogue.value = {};
    authSeen.errors.length = 0;
  });

  afterEach(() => {
    registerEmployeeAccountResolver(undefined);
    setDepartmentScopeResolver(null);
    setEmployeeDepartmentResolver(null);
    vi.useRealTimers();
  });
}

// Values made by vi.hoisted cannot be exported where they are declared.
export { signedOut, catalogue, authSeen };
