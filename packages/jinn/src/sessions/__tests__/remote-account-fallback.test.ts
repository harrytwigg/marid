import { describe, expect, it, vi } from "vitest";
import { remoteClaudeAccountKey } from "../../shared/engine-account.js";
import type { Employee, Engine, EngineResult, EngineRunOpts, JinnConfig } from "../../shared/types.js";
import {
  answer, config as baseConfig, handleRateLimit, HOUR, limited, limitedTurn, maybeRevertEngineOverride, newSession, overrideOf,
  readEngineHealth, reg, registerEmployeeAccountResolver, resetsIn, runOf, setDepartmentScopeResolver, setEmployeeDepartmentResolver, useWalkHarness,
} from "./fallback-walk-harness.js";
import { claudeAuthScope } from "../claude-auth-watch.js";
import { rateLimitAccount } from "../rate-limit-account.js";
import { remoteScopeFor } from "../session-cwd.js";
import { accountOverride, sessionRemoteTarget, threadSlot } from "../session-account.js";
import { RemoteProfileNotReadyError } from "../../shared/remote-profile-error.js";

/**
 * A remote employee falls back to a Claude account declared on its own `user@host`
 * (`engines.claude.accounts.<name>.remoteHost`): the walk moves it there, its next
 * turns run on that account's directory on the host, and it goes back to its own
 * account and thread when the window ends.
 */

useWalkHarness();

const HOME_DIR = "/home/me/.claude-a";
const SPARE_DIR = "/home/me/.claude-b";
const HOST = { remoteHost: "build-host", remoteUser: "me" };
const OWN_KEY = remoteClaudeAccountKey(HOST, HOME_DIR);
const SPARE_KEY = remoteClaudeAccountKey(HOST, SPARE_DIR);
const STAGE_ROOT = "/srv/work";

const config = {
  ...baseConfig,
  remote: { root: STAGE_ROOT, mount: "/mnt/jinn" },
  engines: {
    ...baseConfig.engines,
    claude: { bin: "claude", model: "opus", accounts: { spare: { ...HOST, configDir: SPARE_DIR } } },
  },
} as unknown as JinnConfig;

function remoteEmployee(extra: Partial<Employee> = {}): Employee {
  return {
    name: "worker-a", engine: "claude", ...HOST, remoteCwd: `${STAGE_ROOT}/work`, remoteClaudeConfigDir: HOME_DIR,
    fallback: [{ engine: "claude", profile: "spare" }, { engine: "opencode", model: "x-provider/model-x" }], ...extra,
  } as Employee;
}

/** Engines that answer by script, recording the remote target each call ran with. */
function remoteScripted(script: (opts: EngineRunOpts, n: number) => EngineResult) {
  const calls: EngineRunOpts[] = [];
  const make = (name: string): Engine => ({ name, async run(opts: EngineRunOpts) { calls.push(opts); return script(opts, calls.length); } } as Engine);
  return { engines: new Map<string, Engine>([["claude", make("claude")], ["opencode", make("opencode")]]), calls };
}

/** The limited turn, handled against this file's config (the harness's has no remote account). */
function turn(id: string, who: Employee, engines: Map<string, Engine>) {
  return { ...limitedTurn(id, who, engines).opts, config };
}

function useRemoteAccounts(): void {
  registerEmployeeAccountResolver((name) => (name === "worker-a" ? OWN_KEY : undefined));
}

describe("a scoped remote employee rate-limited on its own account", () => {
  it("moves to the declared remote account, on its directory on the host, and never takes a non-Claude link", async () => {
    useRemoteAccounts();
    setEmployeeDepartmentResolver(() => "ops");
    setDepartmentScopeResolver(() => "scoped");
    const { engines, calls } = remoteScripted(() => answer("on spare", "spare-thread"));
    const id = newSession();
    const who = remoteEmployee();
    const outcome = await handleRateLimit(turn(id, who, engines));

    expect(outcome.kind).toBe("fallback");
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      remoteHost: "build-host", remoteUser: "me", remoteClaudeConfigDir: SPARE_DIR, remoteDepartment: "ops", remoteWorkArea: `${STAGE_ROOT}/work`, claudeProfile: null,
    });
    expect(overrideOf(id)).toMatchObject({ substituteAccount: SPARE_KEY, substituteConfigDir: SPARE_DIR });
    expect(accountOverride(reg.getSession(id)!)?.originalAccount).toBe(OWN_KEY);
    expect(runOf(id)?.position).toBe(1);
  });

  it("keeps a scoped session off the engine link when the remote account is at its limit too, and records that limit against the remote account", async () => {
    useRemoteAccounts();
    setEmployeeDepartmentResolver(() => "ops");
    setDepartmentScopeResolver(() => "scoped");
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"] });
    const { engines, calls } = remoteScripted(() => limited(resetsIn(2 * HOUR)));
    const id = newSession();
    void handleRateLimit(turn(id, remoteEmployee(), engines));
    await vi.advanceTimersByTimeAsync(0);

    // Only the Claude link ran; the opencode link is refused for a scoped session.
    expect(calls.map((call) => call.remoteClaudeConfigDir)).toEqual([SPARE_DIR]);
    const health = readEngineHealth();
    expect(health[SPARE_KEY]).toBeDefined();
    expect(health[OWN_KEY]).toBeDefined();
    expect(reg.getSession(id)!.status).toBe("waiting");
  });

  it("runs the next turn inside the window on the substitute's directory, account and thread slot", async () => {
    useRemoteAccounts();
    const { engines } = remoteScripted(() => answer("on spare", "spare-thread"));
    const id = newSession();
    const who = remoteEmployee();
    await handleRateLimit(turn(id, who, engines));

    const session = reg.getSession(id)!;
    const target = sessionRemoteTarget(who, remoteScopeFor(config.remote, session), session);
    expect(target).toMatchObject({ remoteHost: "build-host", remoteClaudeConfigDir: SPARE_DIR });
    expect(rateLimitAccount("claude", who, session)).toEqual({ claudeProfile: null, account: SPARE_KEY });
    expect(claudeAuthScope(who, session)).toBe(`me@build-host:${SPARE_DIR}`);
    expect(threadSlot(session, "claude")).toBe(SPARE_KEY);
  });

  it("goes back to its own account, directory and thread slot once the window ends", async () => {
    useRemoteAccounts();
    const { engines } = remoteScripted(() => answer("on spare", "spare-thread"));
    const id = newSession();
    const who = remoteEmployee();
    await handleRateLimit(turn(id, who, engines));

    // The window ends: the override record's `until` is in the past.
    const meta = reg.getSession(id)!.transportMeta as Record<string, Record<string, unknown>>;
    reg.updateSession(id, { transportMeta: { ...meta, engineOverride: { ...meta.engineOverride, until: new Date(Date.now() - 1000).toISOString() } } as never });
    const reverted = maybeRevertEngineOverride(reg.getSession(id)!, who, config);

    expect(accountOverride(reverted)).toBeUndefined();
    expect(sessionRemoteTarget(who, remoteScopeFor(config.remote, reverted), reverted)).toMatchObject({ remoteClaudeConfigDir: HOME_DIR });
    expect(threadSlot(reverted, "claude")).toBe(OWN_KEY);
    expect(rateLimitAccount("claude", who, reverted).account).toBe(OWN_KEY);
    expect(claudeAuthScope(who, reverted)).toBe(`me@build-host:${HOME_DIR}`);
  });
});

describe("a remote session moving on from its substitute account", () => {
  it("resumes its own thread on its own directory when the substitute is limited and the next link is its own login", async () => {
    useRemoteAccounts();
    const who = remoteEmployee({ fallback: [{ engine: "claude", profile: "spare" }, { engine: "claude", model: "sonnet" }] });
    const id = newSession();
    expect((await handleRateLimit(turn(id, who, remoteScripted(() => answer("on spare", "spare-thread")).engines))).kind).toBe("fallback");

    // A turn inside the window: spare is limited too, and the walk takes the own login on another model.
    const second = remoteScripted(() => answer("on own sonnet", "a-thread-2"));
    expect((await handleRateLimit(turn(id, who, second.engines))).kind).toBe("fallback");

    expect(second.calls).toHaveLength(1);
    expect(second.calls[0]).toMatchObject({ remoteClaudeConfigDir: HOME_DIR, resumeSessionId: "a-thread", model: "sonnet" });
    const session = reg.getSession(id)!;
    expect(overrideOf(id)).toMatchObject({ originalAccount: OWN_KEY, substituteAccount: OWN_KEY, substituteConfigDir: HOME_DIR });
    expect(threadSlot(session, "claude")).toBe(OWN_KEY);
    expect((session.engineSessions as Record<string, { id: string }>)[SPARE_KEY]?.id).toBe("spare-thread");
  });

  it("moves on from a remote account whose profile cannot run unattended instead of staying on it for the window", async () => {
    useRemoteAccounts();
    const { engines, calls } = remoteScripted((opts) => {
      if (opts.remoteClaudeConfigDir === SPARE_DIR) throw new RemoteProfileNotReadyError(`remote host not ready: the Claude profile at ${SPARE_DIR} on me@build-host is not signed in`);
      return answer("on opencode", "oc-thread");
    });
    const id = newSession();
    const outcome = await handleRateLimit(turn(id, remoteEmployee(), engines));

    expect(outcome.kind).toBe("fallback");
    expect(calls.map((call) => call.remoteClaudeConfigDir === SPARE_DIR ? "spare" : call.model)).toEqual(["spare", "x-provider/model-x"]);
    expect(reg.getSession(id)!.engine).toBe("opencode");
    expect(accountOverride(reg.getSession(id)!)).toBeUndefined();
    expect(readEngineHealth()[SPARE_KEY]).toBeUndefined();
  });

  it("goes back to its own account when a scoped session's only remote account cannot run, rather than standing on a dead login", async () => {
    useRemoteAccounts();
    setEmployeeDepartmentResolver(() => "ops");
    setDepartmentScopeResolver(() => "scoped");
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"] });
    const { engines, calls } = remoteScripted(() => { throw new RemoteProfileNotReadyError("remote host not ready: profile signed out"); });
    const id = newSession();
    void handleRateLimit(turn(id, remoteEmployee(), engines));
    await vi.advanceTimersByTimeAsync(0);

    expect(calls).toHaveLength(1);
    const session = reg.getSession(id)!;
    expect(accountOverride(session)).toBeUndefined();
    expect(session.engine).toBe("claude");
    expect(sessionRemoteTarget(remoteEmployee(), remoteScopeFor(config.remote, session), session)).toMatchObject({ remoteClaudeConfigDir: HOME_DIR });
    expect(session.status).toBe("waiting");
  });
});

describe("a remote session's other readers", () => {
  it("keep the employee's own directory with no override, and ignore an override onto a gateway profile", () => {
    useRemoteAccounts();
    const who = remoteEmployee();
    const plain = reg.getSession(newSession())!;
    expect(sessionRemoteTarget(who, remoteScopeFor(config.remote, plain), plain)).toMatchObject({ remoteClaudeConfigDir: HOME_DIR });
    const local = { ...plain, transportMeta: { engineOverride: { substituteAccount: "claude:abcd1234", substituteConfigDir: "/srv/operator/.claude-x" } } } as typeof plain;
    expect(sessionRemoteTarget(who, remoteScopeFor(config.remote, local), local)).toMatchObject({ remoteClaudeConfigDir: HOME_DIR });
    expect(rateLimitAccount("claude", who, local).account).toBe(OWN_KEY);
  });
});
