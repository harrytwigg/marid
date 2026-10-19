import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Employee, Engine, EngineResult, EngineRunOpts, JinnConfig } from "../../shared/types.js";
import type { FallbackHop } from "../../shared/fallback-chain-wire.js";

/**
 * A rate-limited turn walks the session's fallback chain (docs/fallback-chains.md):
 * hop after hop within the turn, each target once, each on its own profile and
 * model, until one serves it or the chain runs out and the session waits on its own
 * target. Driven through `handleRateLimit` against a real session registry, with
 * scripted engines standing in for the providers.
 */

const signedOut = vi.hoisted(() => ({ dirs: new Set<string>() }));
// No catalogue is listed for any engine, so a link's model is never "not served": what a walk does with a model is not about discovery.
vi.mock("../../shared/models.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../shared/models.js")>()),
  engineAvailable: () => true,
  getModelRegistry: () => ({}),
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

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "jinn-fallback-walk-"));
process.env.JINN_HOME = tmp;
const reg = await import("../registry.js");
const { handleRateLimit } = await import("../rate-limit-handler.js");
const { maybeRevertEngineOverride } = await import("../engine-override.js");
const { readEngineHealth } = await import("../../shared/engine-health.js");
const { registerEmployeeAccountResolver } = await import("../../shared/engine-account.js");
const { claudeProfileFromDir } = await import("../../shared/claude-profile.js");
const { readFallbackRun, readFallbackHops } = await import("../fallback-run.js");
const { setDepartmentScopeResolver, setEmployeeDepartmentResolver } = await import("../../work-items/department-scope.js");

const DIR_A = path.join(tmp, "claude-a");
const DIR_B = path.join(tmp, "claude-b");
const DIR_C = path.join(tmp, "claude-c");
const profileA = claudeProfileFromDir(DIR_A);
const ACCOUNT_A = `claude:${profileA.key}`;
const HOUR = 3600;
const resetsIn = (seconds: number) => Math.floor(Date.now() / 1000) + seconds;

const config = {
  gateway: {},
  sessions: {},
  engines: {
    default: "claude",
    claude: { bin: "claude", model: "opus", accounts: { A: { configDir: DIR_A }, B: { configDir: DIR_B }, C: { configDir: DIR_C } } },
    opencode: { bin: "opencode" },
    codex: { bin: "codex", model: "gpt" },
  },
} as unknown as JinnConfig;

const CLAUDE_B = { engine: "claude", profile: "B", model: "sonnet" };
const OPENCODE_X = { engine: "opencode", model: "x-provider/model-x" };
const OPENCODE_Y = { engine: "opencode", model: "y-provider/model-y" };
const key = (link: { engine: string; profile?: string; model?: string }) => `${link.engine}|${link.profile ?? ""}|${link.model ?? ""}`;

function employee(extra: Partial<Employee> = {}): Employee {
  return { name: "worker-a", engine: "claude", claudeConfigDir: DIR_A, fallback: [CLAUDE_B, OPENCODE_X, OPENCODE_Y], ...extra } as Employee;
}

interface Call { engine: string; profileDir: string | null; model: string | undefined; resume: string | undefined; prompt: string }

/** Engines that answer by script, and a record of every call they took. */
function scripted(script: (call: Call, n: number) => EngineResult) {
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

const limited = (resetsAt = resetsIn(HOUR), error = "429 Too Many Requests"): EngineResult => ({ sessionId: "", result: "", error, rateLimit: { status: "rejected", resetsAt } });
const answer = (text: string, sessionId = "served-thread"): EngineResult => ({ sessionId, result: text });
const failed = (error: string): EngineResult => ({ sessionId: "", result: "", error });

/** Whose turn it is by profile and model: `A/opus`, `B/sonnet`, `x-provider/model-x`. */
const who = (call: Call): string => (call.engine === "claude" ? `${{ [DIR_A]: "A", [DIR_B]: "B", [DIR_C]: "C" }[call.profileDir ?? ""] ?? "default"}/${call.model}` : `${call.model}`);

function newSession(opts: { ref: string; employeeName?: string; model?: string; engine?: string } = { ref: "web:walk" }): string {
  const s = reg.createSession({ engine: opts.engine ?? "claude", source: "web", sourceRef: opts.ref, model: opts.model ?? "opus", employee: opts.employeeName ?? "worker-a" });
  reg.recordEngineSessionId(s.id, opts.engine ?? "claude", "a-thread");
  return s.id;
}

function recordingHooks() {
  const seen = { starts: [] as Array<{ substitute: string; model?: string; hop?: FallbackHop }>, waiting: [] as Array<{ reason?: string; hop?: FallbackHop }>, completes: [] as Array<{ engine: string; model?: string }> };
  return {
    seen,
    hooks: {
      onFallbackStart: (info: { substitute: string; model?: string; hop?: FallbackHop }) => { seen.starts.push(info); },
      onFallbackComplete: (_result: EngineResult, ran: { engine: string; model?: string }) => { seen.completes.push(ran); },
      onWaitingStart: (info: { reason?: string; hop?: FallbackHop }) => { seen.waiting.push(info); },
    },
  };
}

/** The limited turn of session `id`, as the runner hands it to `handleRateLimit`. */
function limitedTurn(id: string, who: Employee | undefined, engines: Map<string, Engine>, extra: { prompt?: string; resetsAt?: number } = {}) {
  const started = reg.beginSessionAttempt(id)!;
  const { seen, hooks } = recordingHooks();
  const session = reg.getSession(id)!;
  const opts = {
    session, attemptToken: started.attemptToken!, prompt: extra.prompt ?? "now publish them", engineConfig: { model: session.model ?? undefined }, config, engines, employee: who,
    engine: engines.get(session.engine)!, rateLimit: { resetsAt: extra.resetsAt ?? resetsIn(HOUR) }, originalResult: limited(extra.resetsAt), hooks,
  };
  return { opts: opts as unknown as Parameters<typeof handleRateLimit>[0], seen };
}

const hopsOf = (id: string): FallbackHop[] => readFallbackHops(reg.getSession(id)!.transportMeta as Record<string, unknown>);
const runOf = (id: string) => readFallbackRun(reg.getSession(id)!.transportMeta as Record<string, unknown>);
const overrideOf = (id: string) => (reg.getSession(id)!.transportMeta as Record<string, Record<string, unknown>> | null)?.engineOverride;

beforeEach(async () => {
  const db = (await import("../../shared/db.js")).initDb();
  db.exec("DELETE FROM messages; DELETE FROM queue_items; DELETE FROM sessions;");
  fs.rmSync(path.join(tmp, "tmp", "engine-health.json"), { force: true });
  registerEmployeeAccountResolver((name) => (name === "worker-a" ? ACCOUNT_A : undefined));
  signedOut.dirs.clear();
  authSeen.errors.length = 0;
});

afterEach(() => {
  registerEmployeeAccountResolver(undefined);
  setDepartmentScopeResolver(null);
  setEmployeeDepartmentResolver(null);
  vi.useRealTimers();
});

describe("a four-link chain: claude/A/opus -> claude/B/sonnet -> opencode/X -> opencode/Y", () => {
  it("walks hop by hop within one turn, each link on its own engine, profile directory and model", async () => {
    const { engines, calls } = scripted((call) => (who(call) === "y-provider/model-y" ? answer("done on Y", "y-thread") : limited()));
    const id = newSession();
    const { opts, seen } = limitedTurn(id, employee(), engines);

    const outcome = await handleRateLimit(opts);

    expect(outcome).toMatchObject({ kind: "fallback", result: { result: "done on Y" } });
    expect(calls.map((call) => [call.engine, call.profileDir, call.model])).toEqual([
      ["claude", DIR_B, "sonnet"], ["opencode", null, "x-provider/model-x"], ["opencode", null, "y-provider/model-y"],
    ]);
    expect(seen.starts.map((start) => start.substitute)).toEqual(["claude", "opencode", "opencode"]);
    expect(seen.completes).toEqual([{ engine: "opencode", model: "y-provider/model-y" }]);
    expect(hopsOf(id).map((hop) => [hop.from, hop.to, hop.reason]).reverse()).toEqual([
      [key({ engine: "claude", profile: "A", model: "opus" }), key(CLAUDE_B), "rate-limit"],
      [key(CLAUDE_B), key(OPENCODE_X), "rate-limit"],
      [key(OPENCODE_X), key(OPENCODE_Y), "rate-limit"],
    ]);
    expect(seen.starts.map((start) => start.hop?.to)).toEqual([key(CLAUDE_B), key(OPENCODE_X), key(OPENCODE_Y)]);
  });

  it("records the run, the target the session stands on, and who served the turn", async () => {
    const { engines } = scripted((call) => (who(call) === "y-provider/model-y" ? answer("done on Y", "y-thread") : limited()));
    const id = newSession();
    await handleRateLimit(limitedTurn(id, employee(), engines).opts);

    const own = key({ engine: "claude", profile: "A", model: "opus" });
    expect(runOf(id)).toMatchObject({ source: "employee", position: 3, tried: [own, key(CLAUDE_B), key(OPENCODE_X)] });
    const row = reg.getSession(id)!;
    expect(row.engine).toBe("opencode");
    expect(row.model).toBe("y-provider/model-y");
    expect(overrideOf(id)).toMatchObject({ originalEngine: "claude", originalModel: "opus", substituteTarget: { engine: "opencode", model: "y-provider/model-y" } });
    expect(row.engineSessions?.opencode?.id).toBe("y-thread");
    expect((row.transportMeta as Record<string, unknown>).fallbackServedBy).toMatchObject({ key: key(OPENCODE_Y), label: "opencode · y-provider/model-y" });
  });

  it("names why each hop was made: a throttle, an allowance window, an engine giving up its own retries", async () => {
    const texts: Record<string, string> = { "B/sonnet": "429 Too Many Requests", "x-provider/model-x": "You've hit your usage limit", "y-provider/model-y": "overloaded; opencode would not retry it for 40 min" };
    const { engines } = scripted((call) => (who(call) === "z" ? answer("never") : limited(undefined, texts[who(call)] ?? "429 Too Many Requests")));
    const id = newSession();
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"] });
    const outcome = handleRateLimit(limitedTurn(id, employee(), engines).opts);
    await vi.advanceTimersByTimeAsync(0);

    expect(hopsOf(id).map((hop) => hop.reason).reverse()).toEqual(["rate-limit", "rate-limit", "quota", "retry-exhausted"]);
    reg.updateSession(id, { status: "idle" } as never);
    await vi.advanceTimersByTimeAsync(10_000);
    await outcome;
  });

  it("holds each limit against the link that hit it: its account for Claude, its provider for opencode", async () => {
    const { engines } = scripted((call) => (who(call) === "y-provider/model-y" ? answer("ok") : limited(resetsIn(2 * HOUR))));
    const id = newSession();
    await handleRateLimit(limitedTurn(id, employee(), engines).opts);

    const health = readEngineHealth();
    expect(Object.keys(health).sort()).toEqual([ACCOUNT_A, `claude:${claudeProfileFromDir(DIR_B).key}`, "opencode/x-provider"].sort());
    expect(health["opencode/y-provider"]).toBeUndefined();
  });

  it("records a Claude hop's declared account on the override, so the thread and profile follow it", async () => {
    const { engines } = scripted((call) => (who(call) === "B/sonnet" ? answer("on B", "b-thread") : limited()));
    const id = newSession();
    await handleRateLimit(limitedTurn(id, employee(), engines).opts);

    const accountB = `claude:${claudeProfileFromDir(DIR_B).key}`;
    expect(overrideOf(id)).toMatchObject({ originalAccount: ACCOUNT_A, substituteAccount: accountB, substituteConfigDir: DIR_B, substituteTarget: { engine: "claude", profile: "B", model: "sonnet" } });
    expect(reg.getSession(id)!.engineSessions?.[accountB]?.id).toBe("b-thread");
    // A's own thread is where it was.
    expect(reg.getSession(id)!.engineSessions?.[ACCOUNT_A]?.id).toBe("a-thread");
  });
});

describe("a chain that runs out", () => {
  async function exhausted() {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"] });
    const { engines, calls } = scripted(() => limited());
    const id = newSession();
    const { opts, seen } = limitedTurn(id, employee(), engines);
    const outcome = handleRateLimit(opts);
    await vi.advanceTimersByTimeAsync(0);
    return { id, calls, seen, outcome };
  }

  it("tries each target exactly once, then waits on the session's own target", async () => {
    const { id, calls, seen, outcome } = await exhausted();

    expect(calls.map(who)).toEqual(["B/sonnet", "x-provider/model-x", "y-provider/model-y"]);
    expect(reg.getSession(id)!.status).toBe("waiting");
    expect(seen.waiting).toHaveLength(1);
    expect(seen.waiting[0]!.reason).toMatch(/every target in its fallback chain was tried \(claude · B · sonnet, opencode · x-provider\/model-x, opencode · y-provider\/model-y\); waiting for claude · A · opus to reset/);
    // Nothing is tried a second time while it waits.
    reg.updateSession(id, { status: "idle" } as never);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(await outcome).toMatchObject({ kind: "cancelled" });
    expect(calls).toHaveLength(3);
  });

  it("puts the session back on its own target, ends the run, and records the walk's last hop with no target", async () => {
    const { id, outcome } = await exhausted();

    const row = reg.getSession(id)!;
    expect(row.engine).toBe("claude");
    expect(row.model).toBe("opus");
    expect(row.engineSessionId).toBe("a-thread");
    expect(overrideOf(id)).toBeUndefined();
    expect(runOf(id)).toBeUndefined();
    const hops = hopsOf(id);
    expect(hops).toHaveLength(4);
    expect(hops[0]).toMatchObject({ to: null, toLabel: null, fromLabel: "opencode · y-provider/model-y" });
    expect(hops.map((hop) => hop.to).reverse().slice(0, 3)).toEqual([key(CLAUDE_B), key(OPENCODE_X), key(OPENCODE_Y)]);
    reg.updateSession(id, { status: "idle" } as never);
    await vi.advanceTimersByTimeAsync(10_000);
    await outcome;
  });

  it("falls to the plain wait, with no hop and no reason, when the chain has nothing the session may use", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"] });
    const { engines, calls } = scripted(() => limited());
    const id = newSession();
    const { opts, seen } = limitedTurn(id, employee({ fallback: [] }), engines);
    const outcome = handleRateLimit(opts);
    await vi.advanceTimersByTimeAsync(0);

    expect(calls).toHaveLength(0);
    expect(seen.waiting[0]).toEqual({ resumeAt: expect.any(Date), rateLimit: expect.anything() });
    expect(hopsOf(id)).toEqual([]);
    reg.updateSession(id, { status: "idle" } as never);
    await vi.advanceTimersByTimeAsync(10_000);
    await outcome;
  });
});

describe("a chain that runs out while a stand-in holds the session", () => {
  it("waits for the session's own target, which is when the override ends, and hands back there", async () => {
    const first = scripted((call) => (who(call) === "B/sonnet" ? answer("on B", "b-thread") : limited()));
    const id = newSession();
    await handleRateLimit(limitedTurn(id, employee(), first.engines).opts);
    reg.updateSession(id, { status: "idle" } as never);
    // The own target reopens in a moment; the stand-in's own limit would not lift for days.
    const standing = (reg.getSession(id)!.transportMeta as Record<string, Record<string, unknown>>).engineOverride!;
    const until = new Date(Date.now() + 1500);
    reg.updateSession(id, { transportMeta: { ...(reg.getSession(id)!.transportMeta as object), engineOverride: { ...standing, until: until.toISOString() } } } as never);

    const second = scripted(() => limited(resetsIn(5 * 24 * HOUR)));
    const turn = limitedTurn(id, employee(), second.engines, { resetsAt: resetsIn(5 * 24 * HOUR) });
    const outcome = await handleRateLimit(turn.opts);

    expect(outcome.kind).toBe("handback");
    expect(Date.now()).toBeGreaterThanOrEqual(until.getTime());
    // The remaining links were tried once each on the way; the own target is not one of them.
    expect(second.calls.map(who)).toEqual(["x-provider/model-x", "y-provider/model-y"]);
    expect(turn.seen.waiting[0]!.hop).toMatchObject({ to: null, fromLabel: "opencode · y-provider/model-y" });
    const row = reg.getSession(id)!;
    expect(row.engine).toBe("claude");
    expect(overrideOf(id)).toBeUndefined();
    expect(runOf(id)).toBeUndefined();
    expect(hopsOf(id)[0]).toMatchObject({ to: null });
  }, 15_000);
});

describe("the loop guard", () => {
  it("never takes up a legacy cycle again: claude -> codex -> claude is claude once", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"] });
    const cyclic = { ...config, engines: { ...config.engines, claude: { bin: "claude", model: "opus", fallback: ["codex"] }, codex: { bin: "codex", model: "gpt", fallback: ["claude"] } } } as unknown as JinnConfig;
    const { engines, calls } = scripted(() => limited());
    const id = newSession({ ref: "web:cycle", employeeName: "plain" });
    const { opts } = limitedTurn(id, { name: "plain", engine: "claude" } as Employee, engines);
    const outcome = handleRateLimit({ ...opts, config: cyclic });
    await vi.advanceTimersByTimeAsync(0);

    // The original engine is not a substitute for its own stand-in: codex is the only hop.
    expect(calls.map((call) => call.engine)).toEqual(["codex"]);
    reg.updateSession(id, { status: "idle" } as never);
    await vi.advanceTimersByTimeAsync(10_000);
    await outcome;
  });

  it("does not pick the original engine when a stand-in is limited in a later turn", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"] });
    const cyclic = { ...config, engines: { ...config.engines, claude: { bin: "claude", model: "opus", fallback: ["codex"] }, codex: { bin: "codex", model: "gpt", fallback: ["claude"] } } } as unknown as JinnConfig;
    const first = scripted((call) => (call.engine === "codex" ? answer("on codex", "codex-thread") : limited()));
    const id = newSession({ ref: "web:cycle-later", employeeName: "plain" });
    const plain = { name: "plain", engine: "claude" } as Employee;
    await handleRateLimit({ ...limitedTurn(id, plain, first.engines).opts, config: cyclic });
    reg.updateSession(id, { status: "idle" } as never);

    // The next turn runs on codex and is limited there: claude (the original) is not an answer.
    const second = scripted(() => limited());
    const turn = limitedTurn(id, plain, second.engines);
    const outcome = handleRateLimit({ ...turn.opts, config: cyclic });
    await vi.advanceTimersByTimeAsync(0);
    expect(second.calls).toHaveLength(0);
    expect(turn.seen.waiting[0]!.hop).toMatchObject({ to: null });
    reg.updateSession(id, { status: "idle" } as never);
    await vi.advanceTimersByTimeAsync(10_000);
    await outcome;
  });

  it("continues a run across turns: the next limit moves on from where the session stands, never back to a target tried", async () => {
    const first = scripted((call) => (who(call) === "B/sonnet" ? answer("on B", "b-thread") : limited()));
    const id = newSession();
    await handleRateLimit(limitedTurn(id, employee(), first.engines).opts);
    expect(runOf(id)).toMatchObject({ position: 1 });
    reg.updateSession(id, { status: "idle" } as never);

    // A is healthy again as far as the health store knows: the run still does not go back to it.
    fs.rmSync(path.join(tmp, "tmp", "engine-health.json"), { force: true });
    const second = scripted((call) => (who(call) === "x-provider/model-x" ? limited() : answer("on Y", "y-thread")));
    const outcome = await handleRateLimit(limitedTurn(id, employee(), second.engines).opts);

    expect(outcome.kind).toBe("fallback");
    expect(second.calls.map(who)).toEqual(["x-provider/model-x", "y-provider/model-y"]);
    expect(runOf(id)).toMatchObject({ position: 3 });
    const own = key({ engine: "claude", profile: "A", model: "opus" });
    expect(runOf(id)!.tried).toEqual([own, key(CLAUDE_B), key(OPENCODE_X)]);
    expect(hopsOf(id)).toHaveLength(3);
  });
});

describe("a revert", () => {
  it("clears the run and leaves the hops, and the next limit starts a fresh run", async () => {
    const { engines } = scripted((call) => (who(call) === "B/sonnet" ? answer("on B", "b-thread") : limited()));
    const id = newSession();
    await handleRateLimit(limitedTurn(id, employee(), engines).opts);
    expect(runOf(id)).toBeDefined();
    reg.updateSession(id, { status: "idle" } as never);

    // The window the swap was given has passed.
    const standing = (reg.getSession(id)!.transportMeta as Record<string, Record<string, unknown>>).engineOverride!;
    reg.updateSession(id, { transportMeta: { ...(reg.getSession(id)!.transportMeta as object), engineOverride: { ...standing, until: new Date(Date.now() - 1000).toISOString() } } } as never);
    const reverted = maybeRevertEngineOverride(reg.getSession(id)!);

    expect(reverted.engine).toBe("claude");
    expect(runOf(id)).toBeUndefined();
    expect(hopsOf(id)).toHaveLength(1);

    // Limited again: the run starts over from the own target, so B is tried again.
    fs.rmSync(path.join(tmp, "tmp", "engine-health.json"), { force: true });
    const again = scripted((call) => (who(call) === "B/sonnet" ? answer("on B again", "b-thread-2") : limited()));
    await handleRateLimit(limitedTurn(id, employee(), again.engines).opts);
    expect(again.calls.map(who)).toEqual(["B/sonnet"]);
    expect(runOf(id)).toMatchObject({ position: 1, tried: [key({ engine: "claude", profile: "A", model: "opus" })] });
    expect(hopsOf(id)).toHaveLength(2);
  });

  it("keeps only the newest 20 hops", async () => {
    const id = newSession();
    const old = Array.from({ length: 20 }, (_, i) => ({ at: new Date(i * 1000).toISOString(), from: "a", to: "b", fromLabel: "a", toLabel: "b", reason: "rate-limit" }));
    reg.updateSession(id, { transportMeta: { fallbackHops: old } } as never);
    const { engines } = scripted((call) => (who(call) === "B/sonnet" ? answer("on B") : limited()));
    await handleRateLimit(limitedTurn(id, employee(), engines).opts);

    const hops = hopsOf(id);
    expect(hops).toHaveLength(20);
    expect(hops[0]).toMatchObject({ to: key(CLAUDE_B) });
    expect(hops[19]).toMatchObject({ at: new Date(18_000).toISOString() });
  });
});

describe("failures that move a fallback link on, and the own target's that do not", () => {
  it("moves on from a link whose model the engine refuses, without holding it against the link's health", async () => {
    const { engines, calls } = scripted((call) => {
      if (who(call) === "B/sonnet") return failed("There's an issue with the selected model (sonnet). It may not exist or you may not have access to it. invalid model");
      return who(call) === "x-provider/model-x" ? answer("on X", "x-thread") : limited();
    });
    const id = newSession();
    const outcome = await handleRateLimit(limitedTurn(id, employee(), engines).opts);

    expect(outcome).toMatchObject({ kind: "fallback", result: { result: "on X" } });
    expect(calls.map(who)).toEqual(["B/sonnet", "x-provider/model-x"]);
    expect(hopsOf(id).map((hop) => hop.reason)).toEqual(["invalid-model", "rate-limit"]);
    expect(readEngineHealth()[`claude:${claudeProfileFromDir(DIR_B).key}`]).toBeUndefined();
  });

  it("moves on from a link whose Claude login is signed out, and lets the auth outage ledger record it", async () => {
    const { engines, calls } = scripted((call) => (who(call) === "B/sonnet" ? failed("API Error: authentication_failed") : who(call) === "x-provider/model-x" ? answer("on X") : limited()));
    const id = newSession();
    await handleRateLimit(limitedTurn(id, employee(), engines).opts);

    expect(calls.map(who)).toEqual(["B/sonnet", "x-provider/model-x"]);
    expect(hopsOf(id)[0]).toMatchObject({ reason: "auth" });
    expect(authSeen.errors).toEqual(["API Error: authentication_failed"]);
    // A signed-out login is not an exhausted account.
    expect(readEngineHealth()[`claude:${claudeProfileFromDir(DIR_B).key}`]).toBeUndefined();
  });

  it("passes over a profile that is signed out without launching it, and names why", async () => {
    signedOut.dirs.add(DIR_B);
    const { engines, calls } = scripted((call) => (who(call) === "x-provider/model-x" ? answer("on X") : limited()));
    const id = newSession();
    const { opts, seen } = limitedTurn(id, employee(), engines);
    await handleRateLimit(opts);

    expect(calls.map(who)).toEqual(["x-provider/model-x"]);
    // The turn moved to B on paper and off it again: two hops, the second for the sign-in.
    expect(seen.starts.map((start) => start.hop?.reason)).toEqual(["rate-limit", "auth"]);
    expect(hopsOf(id).map((hop) => [hop.from, hop.to, hop.reason]).reverse()).toEqual([
      [key({ engine: "claude", profile: "A", model: "opus" }), key(CLAUDE_B), "rate-limit"],
      [key(CLAUDE_B), key(OPENCODE_X), "auth"],
    ]);
  });

  it("does not move on from the session's own target: its model refusal is the turn's failure, not a hop", async () => {
    // The wait's retry runs the own target again; an invalid-model answer there settles the turn as it always did.
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"] });
    const { engines } = scripted(() => limited());
    const id = newSession();
    const { opts } = limitedTurn(id, employee({ fallback: [] }), engines, { resetsAt: resetsIn(1) });
    const own = { name: "claude", async run() { return failed("invalid model: opus"); } } as unknown as Engine;
    const outcome = handleRateLimit({ ...opts, engine: own });
    await vi.advanceTimersByTimeAsync(40_000);

    expect(await outcome).toMatchObject({ kind: "resumed", result: { error: "invalid model: opus" } });
    expect(hopsOf(id)).toEqual([]);
  });
});

describe("scoped sessions", () => {
  it("skip a link that is not a Claude account, and say why in the hop", async () => {
    setDepartmentScopeResolver(() => "scoped");
    setEmployeeDepartmentResolver((name) => (name === "worker-a" ? "ops" : undefined));
    const { engines, calls } = scripted((call) => (who(call) === "C/opus" ? answer("on C", "c-thread") : limited()));
    const id = newSession();
    const chain = [OPENCODE_X, { engine: "claude", profile: "C", model: "opus" }];
    const outcome = await handleRateLimit(limitedTurn(id, employee({ fallback: chain }), engines).opts);

    expect(outcome.kind).toBe("fallback");
    expect(calls.map(who)).toEqual(["C/opus"]);
    expect(hopsOf(id)[0]).toMatchObject({ to: key(chain[1]!), skipped: [{ key: key(OPENCODE_X), reason: "scoped" }] });
  });
});

describe("what a hop's thread carries (docs/fallback-chains.md, Context across a hop)", () => {
  it("resumes the same thread, with the new model, for another model on the same account", async () => {
    const { engines, calls } = scripted((call) => answer(`on ${who(call)}`, "a-thread"));
    const id = newSession();
    await handleRateLimit(limitedTurn(id, employee({ fallback: [{ engine: "claude", profile: "A", model: "sonnet" }] }), engines).opts);

    expect(calls).toEqual([{ engine: "claude", profileDir: DIR_A, model: "sonnet", resume: "a-thread", prompt: "now publish them" }]);
    expect(reg.getSession(id)!.engineSessionId).toBe("a-thread");
  });

  it("resumes the same opencode session, with the other provider's model, on an opencode provider hop", async () => {
    const { engines, calls } = scripted((call) => answer(`on ${who(call)}`, "oc-thread"));
    const id = newSession({ ref: "web:oc", employeeName: "oc-worker", engine: "opencode", model: "x-provider/model-x" });
    reg.recordEngineSessionId(id, "opencode", "oc-thread");
    const worker = { name: "oc-worker", engine: "opencode", fallback: [OPENCODE_Y] } as Employee;
    await handleRateLimit(limitedTurn(id, worker, engines).opts);

    expect(calls).toEqual([{ engine: "opencode", profileDir: null, model: "y-provider/model-y", resume: "oc-thread", prompt: "now publish them" }]);
  });

  it("resumes another account's own thread, with what it has not seen put in front", async () => {
    const accountB = `claude:${claudeProfileFromDir(DIR_B).key}`;
    const { engines, calls } = scripted(() => answer("on B", "b-thread"));
    const id = newSession();
    // B ran this conversation before and was last brought up to date at 10:00; A has taken turns since.
    const synced = "2026-10-19T10:00:00.000Z";
    reg.recordEngineSessionId(id, "claude", "b-old", { lastSyncedAt: synced });
    reg.updateSession(id, { engineSessions: { [ACCOUNT_A]: { id: "a-thread" }, [accountB]: { id: "b-thread", lastSyncedAt: synced } } } as never);
    const db = (await import("../../shared/db.js")).initDb();
    const insertAt = (role: string, content: string, at: string) => db.prepare("INSERT INTO messages (id, session_id, role, content, timestamp) VALUES (?, ?, ?, ?, ?)").run(`${role}-${content}`, id, role, content, Date.parse(at));
    insertAt("user", "an old question B saw", "2026-10-19T09:00:00.000Z");
    insertAt("assistant", "an old answer B saw", "2026-10-19T09:30:00.000Z");
    insertAt("user", "a question B has not seen", "2026-10-19T11:00:00.000Z");
    insertAt("assistant", "an answer B has not seen", "2026-10-19T11:30:00.000Z");
    insertAt("user", "now publish them", "2026-10-19T12:00:00.000Z");
    await handleRateLimit(limitedTurn(id, employee({ fallback: [CLAUDE_B] }), engines).opts);

    expect(calls).toHaveLength(1);
    expect(calls[0]!.resume).toBe("b-thread");
    expect(calls[0]!.prompt).toContain("USER: a question B has not seen");
    expect(calls[0]!.prompt).toContain("ASSISTANT: an answer B has not seen");
    expect(calls[0]!.prompt).not.toContain("an old question B saw");
    expect(calls[0]!.prompt.endsWith("CURRENT MESSAGE:\nnow publish them")).toBe(true);
    // The current message is asked once, not also as the transcript's last line.
    expect(calls[0]!.prompt.match(/now publish them/g)).toHaveLength(1);
  });

  it("starts fresh, with the conversation handed over, for another account with no thread, and never resumes one profile's id under another", async () => {
    const { engines, calls } = scripted(() => answer("on B", "b-thread"));
    const id = newSession();
    reg.insertMessage(id, "user", "draft the release notes");
    reg.insertMessage(id, "assistant", "drafted on A");
    reg.insertMessage(id, "user", "now publish them");
    await handleRateLimit(limitedTurn(id, employee({ fallback: [CLAUDE_B] }), engines).opts);

    expect(calls[0]!.resume).toBeUndefined();
    expect(calls[0]!.prompt).toMatch(/^Continue this conversation and respond to the last USER message\./);
    expect(calls[0]!.prompt).toContain("ASSISTANT: drafted on A");
    expect(calls[0]!.prompt).not.toContain("a-thread");
  });

  it("starts fresh on another engine with no thread, too", async () => {
    const { engines, calls } = scripted(() => answer("on X", "x-thread"));
    const id = newSession();
    reg.insertMessage(id, "user", "now publish them");
    await handleRateLimit(limitedTurn(id, employee({ fallback: [OPENCODE_X] }), engines).opts);

    expect(calls[0]).toMatchObject({ engine: "opencode", resume: undefined });
    expect(calls[0]!.prompt).toMatch(/^Continue this conversation/);
  });
});
