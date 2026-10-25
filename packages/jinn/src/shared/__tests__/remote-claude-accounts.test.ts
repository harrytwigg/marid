import { describe, expect, it, vi } from "vitest";

vi.mock("../models.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../models.js")>()),
  getModelRegistry: () => ({}),
}));
vi.mock("../../engines/remote-stage.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../engines/remote-stage.js")>()),
  remoteEngineAvailable: () => true,
}));
import { availabilityRegistry } from "../../sessions/availability-registry.js";
import { rerouteAtCreation } from "../../sessions/fallback-reroute.js";
import { makeSession } from "../../sessions/__tests__/helpers/session-fixture.js";
import { declaredClaudeAccounts, declaredRemoteAccountByKey, declaredRemoteAccountByName, declaredRemoteClaudeAccounts } from "../claude-accounts-config.js";
import { validateConfigShape } from "../config.js";
import { employeeFallbackProblems, loadEmployeeFallback } from "../employee-fallback.js";
import { remoteClaudeAccountKey } from "../engine-account.js";
import { claudeAccountsFor } from "../engine-limits-accounts.js";
import { latestLimitReadings } from "../fallback-chain-limits.js";
import { linkAccount, sessionFallbackChain } from "../fallback-chain.js";
import { employeeSubject } from "../fallback-chain-subjects.js";
import type { ModelRegistry, Employee, JinnConfig } from "../types.js";

/**
 * Declared remote Claude accounts: `engines.claude.accounts.<name>` with `remoteHost`, a profile
 * directory on that host that a remote employee on the same `user@host` can fall back to.
 */

const LOCAL_DIR = "/srv/operator/.claude-local";
const REMOTE_DIR = "/home/me/.claude-b";
const HOME_DIR = "/home/me/.claude-a";
const SPARE = { remoteHost: "build-host", remoteUser: "me", configDir: REMOTE_DIR };
const SPARE_KEY = remoteClaudeAccountKey({ remoteHost: "build-host", remoteUser: "me" }, REMOTE_DIR);
const HOME_KEY = remoteClaudeAccountKey({ remoteHost: "build-host", remoteUser: "me" }, HOME_DIR);

function configWith(accounts: Record<string, unknown>, extra: Record<string, unknown> = {}): JinnConfig {
  return {
    engines: { default: "claude", claude: { bin: "claude", model: "opus", accounts: { local: { configDir: LOCAL_DIR }, spare: SPARE, ...accounts }, ...extra }, codex: { bin: "codex", model: "gpt" } },
    remote: { root: "/srv/work", mount: "/mnt/jinn" },
  } as unknown as JinnConfig;
}

const problems = (accounts: Record<string, unknown>) => validateConfigShape({ engines: configWith(accounts).engines });

function entry(name: string): ModelRegistry[string] {
  return { name, available: true, defaultModel: "opus", effortMechanism: "none" as const, models: [] };
}
const registry = { claude: entry("claude"), codex: entry("codex"), opencode: entry("opencode") } as unknown as ModelRegistry;

function remoteEmployee(over: Partial<Employee> = {}): Employee {
  return {
    name: "dev", displayName: "Dev", department: "eng", rank: "senior", engine: "claude", model: "opus", persona: "p",
    remoteHost: "build-host", remoteUser: "me", remoteCwd: "/srv/work/dev", remoteClaudeConfigDir: HOME_DIR, ...over,
  };
}

describe("validation", () => {
  it("accepts a remote account beside a local one", () => {
    expect(problems({})).toEqual([]);
    expect(problems({ other: { remoteHost: "other-host", configDir: REMOTE_DIR } })).toEqual([]);
  });

  it("refuses a remote account with a chain of its own", () => {
    expect(problems({ spare: { ...SPARE, fallback: ["codex"] } })).toEqual(["engines.claude.accounts.spare: a remote account has no chain of its own; write the chain on its employees' fallback"]);
    expect(problems({ spare: { ...SPARE, fallbackModelMap: { opus: "sonnet" } } }).join()).toContain("a remote account has no chain of its own");
  });

  it("refuses a directory that is not absolute on the host, home-relative included", () => {
    expect(problems({ spare: { ...SPARE, configDir: ".claude-b" } }).join()).toContain("must be an absolute path on build-host");
    expect(problems({ spare: { ...SPARE, configDir: "~/.claude-b" } }).join()).toContain("not home-relative");
    expect(problems({ spare: { remoteHost: "build-host" } }).join()).toContain("configDir must be an absolute path on build-host");
  });

  it("does not judge a remote directory by the gateway's filesystem or instance home", () => {
    expect(validateConfigShape({ engines: configWith({ spare: { ...SPARE, configDir: "/root/.claude" } }).engines })).toEqual([]);
  });

  it("refuses a remoteUser without a remoteHost", () => {
    expect(problems({ spare: { remoteUser: "me", configDir: REMOTE_DIR } }).join()).toContain("remoteUser is set but remoteHost is not");
  });

  it("refuses the root of the host as a profile directory", () => {
    expect(problems({ spare: { ...SPARE, configDir: "/" } }).join()).toContain("not the root of build-host");
  });

  it("refuses a host or user that would reach ssh's own arguments", () => {
    expect(problems({ spare: { ...SPARE, remoteHost: "-oProxyCommand=x" } }).join()).toContain("not a plain hostname");
    expect(problems({ spare: { ...SPARE, remoteUser: "a b" } }).join()).toContain("not a plain username");
  });

  it("refuses two accounts on one directory of one user@host, and allows the same path on another host or user", () => {
    expect(problems({ twin: { ...SPARE, configDir: `${REMOTE_DIR}/` } }).join()).toContain("is already account spare's on me@build-host");
    expect(problems({ twin: { ...SPARE, remoteHost: "other-host" } })).toEqual([]);
    expect(problems({ twin: { ...SPARE, remoteUser: "you" } })).toEqual([]);
  });

  it("never collides a remote directory with a local one", () => {
    expect(problems({ local: { configDir: REMOTE_DIR } })).toEqual([]);
  });
});

describe("declared remote accounts", () => {
  it("are keyed as a remote employee on that directory is, and left out of the local ones", () => {
    const config = configWith({});
    const [spare] = declaredRemoteClaudeAccounts(config);
    expect(spare).toMatchObject({ name: "spare", key: SPARE_KEY, remoteHost: "build-host", remoteUser: "me", configDir: REMOTE_DIR, destination: "me@build-host" });
    expect(declaredRemoteAccountByName(config, "spare")?.key).toBe(SPARE_KEY);
    expect(declaredRemoteAccountByKey(config, SPARE_KEY)?.name).toBe("spare");
    expect(declaredClaudeAccounts(config).map((account) => account.name)).toEqual(["local"]);
    expect(linkAccount({ engine: "claude", profile: "spare" }, config)).toBe(SPARE_KEY);
  });

  it("use the bare host as the destination when no user is named", () => {
    const [bare] = declaredRemoteClaudeAccounts(configWith({ spare: { remoteHost: "build-host", configDir: REMOTE_DIR } }));
    expect(bare).toMatchObject({ destination: "build-host", key: remoteClaudeAccountKey({ remoteHost: "build-host" }, REMOTE_DIR) });
  });
});

describe("chain resolution", () => {
  const resolve = (employee: Employee, config = configWith({}), session: Parameters<typeof makeSession>[0] = {}) =>
    sessionFallbackChain({ config, employee, session: makeSession({ employee: employee.name, ...session }), registry, health: {} }).links;

  it("gives a remote subject the remote account on its own user@host, as a usable link keyed on the remote login", () => {
    const links = resolve(remoteEmployee({ fallback: [{ engine: "claude", profile: "spare" }] }));
    expect(links.map((link) => [link.key, link.account, link.skip])).toEqual([["claude||opus", expect.any(String), undefined], ["claude|spare|opus", SPARE_KEY, undefined]]);
  });

  it("refuses a local profile for a remote subject, naming why", () => {
    const [, link] = resolve(remoteEmployee({ fallback: [{ engine: "claude", profile: "local" }] }));
    expect(link).toMatchObject({ skip: "remote", skipDetail: 'profile "local" is a profile on the gateway, not on me@build-host' });
  });

  it("refuses a remote account on another host or user for a remote subject", () => {
    const config = configWith({ elsewhere: { remoteHost: "other-host", configDir: REMOTE_DIR }, someoneElse: { ...SPARE, remoteUser: "you", configDir: "/home/you/.claude" } });
    const [, elsewhere, someoneElse] = resolve(remoteEmployee({ fallback: [{ engine: "claude", profile: "elsewhere" }, { engine: "claude", profile: "someoneElse" }] }), config);
    expect(elsewhere).toMatchObject({ skip: "remote", skipDetail: 'profile "elsewhere" is on other-host, not this session\'s host me@build-host' });
    expect(someoneElse).toMatchObject({ skip: "remote", skipDetail: 'profile "someoneElse" is on you@build-host, not this session\'s host me@build-host' });
  });

  it("refuses any remote account for a local subject", () => {
    const local = { ...remoteEmployee({ fallback: [{ engine: "claude", profile: "spare" }] }), remoteHost: undefined, remoteUser: undefined, remoteCwd: undefined, remoteClaudeConfigDir: undefined } as Employee;
    const [, link] = resolve(local);
    expect(link).toMatchObject({ skip: "remote", skipDetail: 'profile "spare" is on remote host build-host' });
  });

  it("calls a name that is neither a local nor a remote account unknown", () => {
    const [, link] = resolve(remoteEmployee({ fallback: [{ engine: "claude", profile: "ghost" }] }));
    expect(link?.skip).toBe("profile-unknown");
  });

  it("refuses to judge a remote account for a subject whose host is unknown", () => {
    const [, link] = sessionFallbackChain({
      config: configWith({}), employee: remoteEmployee({ fallback: [{ engine: "claude", profile: "spare" }] }), session: makeSession({ employee: "dev" }), registry, health: {},
      scope: { scoped: false, remote: true },
    }).links;
    expect(link).toMatchObject({ skip: "remote", skipDetail: expect.stringContaining("(unknown)") });
  });

  it("names the employee's own declared account on its own link, so a chain naming it is the same target", () => {
    const config = configWith({ home: { ...SPARE, configDir: HOME_DIR } });
    const own = remoteEmployee({ fallback: [{ engine: "claude", profile: "home" }, { engine: "claude", profile: "spare" }] });
    const links = resolve(own, config);
    expect(links[0]).toMatchObject({ key: "claude|home|opus", account: HOME_KEY, label: "claude · home · opus" });
    expect(links.map((link) => link.key)).toEqual(["claude|home|opus", "claude|spare|opus"]);
  });

  it("shows a remote employee's chain in the editor with the account link usable", () => {
    const subject = employeeSubject({ config: configWith({}), registry, health: {} }, remoteEmployee({ fallback: [{ engine: "claude", profile: "spare" }] }), { scoped: false, remote: true, host: "me@build-host" });
    expect(subject.effective[0]).toMatchObject({ account: SPARE_KEY });
    expect(subject.effective[0]?.skip).toBeUndefined();
  });
});

describe("an employee's chain at load", () => {
  const check = (employee: Employee, chain: unknown[], config = configWith({ other: { remoteHost: "other-host", configDir: REMOTE_DIR } })) => employeeFallbackProblems(config, employee, chain);

  it("accepts the remote account on the employee's own user@host", () => {
    expect(check(remoteEmployee(), [{ engine: "claude", profile: "spare" }])).toEqual([]);
  });

  it("refuses a local profile for a remote employee", () => {
    expect(check(remoteEmployee(), [{ engine: "claude", profile: "local" }]))
      .toEqual(['fallback[0]: profile "local" is a local profile; a remote employee falls back only to an account declared with remoteHost build-host']);
  });

  it("refuses a remote account on another destination", () => {
    expect(check(remoteEmployee(), [{ engine: "claude", profile: "other" }])).toEqual(['fallback[0]: profile "other" is declared on other-host, not me@build-host']);
  });

  it("refuses a remote account for a local employee", () => {
    const local = { ...remoteEmployee(), remoteHost: undefined, remoteUser: undefined, remoteClaudeConfigDir: undefined } as Employee;
    expect(check(local, [{ engine: "claude", profile: "spare" }])[0]).toContain('profile "spare" is declared on me@build-host; a local employee');
  });

  it("keeps the unknown-name refusal", () => {
    expect(check(remoteEmployee(), [{ engine: "claude", profile: "ghost" }])[0]).toContain('profile "ghost" names no account under engines.claude.accounts');
  });

  it("refuses the employee's own declared account, spelled with or without its profile", () => {
    const config = configWith({ home: { ...SPARE, configDir: HOME_DIR } });
    expect(check(remoteEmployee(), [{ engine: "claude", profile: "home" }], config)[0]).toContain("is the target this chain falls back from");
    expect(check(remoteEmployee(), [{ engine: "claude" }], config)[0]).toContain("is the target this chain falls back from");
  });

  it("leaves the employee loading with the chain dropped and the reason kept, as for any invalid chain", () => {
    const loaded = loadEmployeeFallback([{ engine: "claude", profile: "local" }], { ...remoteEmployee() }, configWith({}), "dev.yaml");
    expect(loaded.fallback).toBeUndefined();
    expect(loaded.problems?.[0]).toContain("is a local profile");
  });
});

describe("limits", () => {
  it("lists a declared remote account as a remote entry, read over SSH like any remote login", () => {
    const accounts = claudeAccountsFor([], configWith({}));
    const spare = accounts.find((account) => account.key === SPARE_KEY);
    expect(spare).toEqual({
      key: SPARE_KEY, label: "spare", location: { kind: "remote", host: "build-host" }, profile: null,
      remote: { destination: "me@build-host", configDir: REMOTE_DIR }, employees: [],
    });
  });

  it("adds a remote employee on that directory to the entry's employees", () => {
    const on = remoteEmployee({ remoteClaudeConfigDir: REMOTE_DIR });
    const accounts = claudeAccountsFor([on], configWith({}));
    expect(accounts.filter((account) => account.key === SPARE_KEY)).toEqual([expect.objectContaining({ label: "spare", employees: ["dev"] })]);
  });

  it("reads the cached usage of a remote account for its chain link", () => {
    expect(Object.keys(latestLimitReadings(configWith({})))).toContain(SPARE_KEY);
  });
});

describe("a new session whose account is spent", () => {
  const NOW = new Date("2026-10-19T10:00:00.000Z");
  const spent = { state: "exhausted" as const, until: new Date(NOW.getTime() + 3600_000).toISOString(), recheckAt: new Date(NOW.getTime() + 3600_000).toISOString() };

  // The caller reads the employee's own login's health as `claude` (substituteHealth), as for a new session.
  it("starts a remote employee on the remote account, with its directory on the host, and refuses it elsewhere", () => {
    const employee = remoteEmployee({ fallback: [{ engine: "claude", profile: "spare" }] });
    const args = { config: configWith({}), employee, engine: "claude", model: "opus", registry: availabilityRegistry({}, () => true), health: { claude: spent }, now: NOW };
    const choice = rerouteAtCreation({ ...args, scope: { scoped: false, remote: true, host: "me@build-host" } });
    expect(choice).toMatchObject({ engine: "claude", reroute: { account: { original: HOME_KEY, substitute: SPARE_KEY, configDir: REMOTE_DIR } } });
    expect(rerouteAtCreation({ ...args, scope: { scoped: false, remote: true, host: "you@build-host" } })).toBeUndefined();
  });
});
