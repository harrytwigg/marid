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
