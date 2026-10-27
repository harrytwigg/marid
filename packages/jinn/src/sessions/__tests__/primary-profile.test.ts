import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * A session started on a declared Claude account (`engine: "claude:<name>"`):
 * the engine string is parsed in one place, and the session's own account,
 * profile, fallback chain, rate-limit account and revert target all follow the
 * profile it was started on instead of its employee's login.
 */

vi.mock("../../shared/models.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../shared/models.js")>()),
  engineAvailable: () => true,
  getModelRegistry: () => ({ codex: { models: [{ id: "gpt-mini" }] } }),
}));

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "jinn-primary-profile-"));
process.env.JINN_HOME = tmp;
const reg = await import("../registry.js");
const { beginEngineSubstitution, maybeRevertEngineOverride } = await import("../engine-override.js");
const { currentClaudeAccount, ownClaudeAccount, ownClaudeProfile, sessionClaudeProfile } = await import("../session-account.js");
const { rateLimitAccount } = await import("../rate-limit-account.js");
const { parsePrimaryEngine, resolvePrimaryEngine } = await import("../primary-profile.js");
const { chooseSubstituteOrReason } = await import("../rate-limit-substitute.js");
const { sessionFallbackChain } = await import("../../shared/fallback-chain.js");
const { registerEmployeeAccountResolver } = await import("../../shared/engine-account.js");
const { claudeProfileFromDir } = await import("../../shared/claude-profile.js");
const { makeSession } = await import("./helpers/session-fixture.js");
import type { Employee, JinnConfig } from "../../shared/types.js";

const FRIEND = path.join(os.tmpdir(), "primary-profile-friend");
const SPARE = path.join(os.tmpdir(), "primary-profile-spare");
const EMPLOYEE_OWN = path.join(os.tmpdir(), "primary-profile-employee-own");
const friend = claudeProfileFromDir(FRIEND);
const spare = claudeProfileFromDir(SPARE);
const employeeOwn = claudeProfileFromDir(EMPLOYEE_OWN);
const FRIEND_ACCOUNT = `claude:${friend.key}`;
const SPARE_ACCOUNT = `claude:${spare.key}`;
const EMPLOYEE_ACCOUNT = `claude:${employeeOwn.key}`;

function configWith(accounts: Record<string, unknown>, claude: Record<string, unknown> = {}): JinnConfig {
  return {
    engines: {
      default: "claude",
      claude: { bin: "claude", model: "opus", accounts, ...claude },
      codex: { bin: "codex", model: "gpt" },
    },
  } as unknown as JinnConfig;
}

const config = configWith({ friend: { configDir: FRIEND, fallback: [] }, spare: { configDir: SPARE, fallback: ["claude:friend", "codex"] } });
const employee = { name: "side-dev", engine: "claude", claudeConfigDir: EMPLOYEE_OWN } as Employee;

beforeEach(async () => {
  const db = (await import("../../shared/db.js")).initDb();
  db.exec("DELETE FROM messages; DELETE FROM queue_items; DELETE FROM sessions;");
  registerEmployeeAccountResolver((name) => (name === "side-dev" ? EMPLOYEE_ACCOUNT : "claude"));
});
afterEach(() => registerEmployeeAccountResolver(undefined));

describe("parsePrimaryEngine", () => {
  it("reads claude:<name> as the claude engine on that declared account", () => {
    const parsed = parsePrimaryEngine(config, "claude:friend");
    expect(parsed).toMatchObject({ ok: true, engine: "claude", profile: { name: "friend", key: FRIEND_ACCOUNT, profile: friend } });
  });

  it("leaves a bare engine name exactly as it was", () => {
    expect(parsePrimaryEngine(config, " codex ")).toEqual({ ok: true, engine: "codex" });
    expect(parsePrimaryEngine(config, "claude")).toEqual({ ok: true, engine: "claude" });
  });

  it("refuses an undeclared name, listing the declared ones", () => {
    const parsed = parsePrimaryEngine(config, "claude:nobody");
    expect(parsed).toMatchObject({ ok: false, status: 400 });
    expect((parsed as { error: string }).error).toMatch(/unknown Claude profile "nobody".*declared profiles: friend, spare/);
  });

  it("says so when no profile is declared at all, and refuses an empty name", () => {
    expect((parsePrimaryEngine(configWith({}), "claude:friend") as { error: string }).error).toMatch(/no Claude profiles are declared/);
    expect(parsePrimaryEngine(config, "claude:")).toMatchObject({ ok: false });
  });

  it("does not offer an account whose configDir is unusable", () => {
    const bad = configWith({ rel: { configDir: "relative/dir" } });
    expect(parsePrimaryEngine(bad, "claude:rel")).toMatchObject({ ok: false, status: 400 });
  });
});

describe("resolvePrimaryEngine", () => {
  it("refuses a department-scoped caller with a 403 that does not list the declared profiles", () => {
    const refused = resolvePrimaryEngine(config, "claude:friend", { scopedCaller: true });
    expect(refused).toMatchObject({ ok: false, status: 403 });
    expect((refused as { error: string }).error).not.toMatch(/friend/);
    expect(resolvePrimaryEngine(config, "claude:nobody", { scopedCaller: true })).toMatchObject({ status: 403 });
  });

  it("lets a scoped caller name a bare engine as before", () => {
    expect(resolvePrimaryEngine(config, "claude", { scopedCaller: true })).toEqual({ ok: true, engine: "claude" });
  });

  it("refuses a remote employee, which runs on its host's login", () => {
    const remote = { name: "far", engine: "claude", remoteHost: "build-box" } as Employee;
    expect(resolvePrimaryEngine(config, "claude:friend", { employee: remote })).toMatchObject({ ok: false, status: 400 });
    expect(resolvePrimaryEngine(config, "claude", { employee: remote })).toEqual({ ok: true, engine: "claude" });
  });
});

describe("the session's own account and profile", () => {
  it("is the profile it was started on, over its employee's", () => {
    const session = makeSession({ employee: "side-dev", claudeConfigDir: friend.dir });
    expect(ownClaudeAccount(session)).toBe(FRIEND_ACCOUNT);
    expect(currentClaudeAccount(session)).toBe(FRIEND_ACCOUNT);
    expect(ownClaudeProfile(session, employee)).toEqual(friend);
    expect(sessionClaudeProfile(session, employee)).toEqual(friend);
  });

  it("is the employee's when no profile was chosen", () => {
    const session = makeSession({ employee: "side-dev" });
    expect(ownClaudeAccount(session)).toBe(EMPLOYEE_ACCOUNT);
    expect(sessionClaudeProfile(session, employee)).toEqual(employeeOwn);
  });

  it("is the chosen profile for a session with no employee at all", () => {
    const session = makeSession({ claudeConfigDir: friend.dir });
    expect(currentClaudeAccount(session)).toBe(FRIEND_ACCOUNT);
    expect(sessionClaudeProfile(session, null)).toEqual(friend);
  });

  it("is ignored once the employee has become remote, which runs on its host's login", () => {
    const remote = { name: "far", engine: "claude", remoteHost: "build-box" } as Employee;
    expect(sessionClaudeProfile(makeSession({ employee: "far", claudeConfigDir: friend.dir }), remote)).toBeNull();
  });

  it("is what a rate limit is recorded against", () => {
    const session = makeSession({ employee: "side-dev", claudeConfigDir: friend.dir });
    expect(rateLimitAccount("claude", employee, session)).toEqual({ claudeProfile: friend, account: FRIEND_ACCOUNT });
    // Without a chosen profile the employee's own account is the one limited, as before.
    expect(rateLimitAccount("claude", employee, makeSession({ employee: "side-dev" }))).toEqual({ claudeProfile: employeeOwn, account: EMPLOYEE_ACCOUNT });
  });
});

describe("an account override on a session started on a chosen profile", () => {
  const swap = (sessionId: string) => beginEngineSubstitution({
    session: reg.getSession(sessionId)!, attemptToken: "attempt-1", config, employee, substitute: "claude",
    accounts: { original: FRIEND_ACCOUNT, substitute: SPARE_ACCOUNT, substituteConfigDir: spare.dir },
    until: new Date(Date.now() + 3600_000), syncSince: new Date().toISOString(), lastError: "limit",
  });

  it("wins while it stands, and the revert returns to the chosen profile, not the employee's", () => {
    const s = reg.createSession({ engine: "claude", source: "web", sourceRef: "web:primary-1", model: "opus", employee: "side-dev", claudeConfigDir: friend.dir });
    reg.recordEngineSessionId(s.id, "claude", "friend-thread-1");
    reg.updateSession(s.id, { status: "running", attemptToken: "attempt-1" } as never);
    expect(reg.getEngineSessionRef(reg.getSession(s.id)!, "claude").id).toBe("friend-thread-1");

    swap(s.id);
    const during = reg.getSession(s.id)!;
    expect(currentClaudeAccount(during)).toBe(SPARE_ACCOUNT);
    expect(sessionClaudeProfile(during, employee)).toEqual(spare);
    expect(rateLimitAccount("claude", employee, during)).toEqual({ claudeProfile: spare, account: SPARE_ACCOUNT });

    const meta = during.transportMeta as Record<string, Record<string, unknown>>;
    reg.updateSession(s.id, { transportMeta: { ...meta, engineOverride: { ...meta.engineOverride, until: "2020-01-01T00:00:00.000Z" } } as never });
    const after = maybeRevertEngineOverride(reg.getSession(s.id)!, employee);
    expect(currentClaudeAccount(after)).toBe(FRIEND_ACCOUNT);
    expect(sessionClaudeProfile(after, employee)).toEqual(friend);
    expect(after.engineSessionId).toBe("friend-thread-1");
  });
});

describe("the fallback chain of a session started on a chosen profile", () => {
  const registry = { codex: { models: [{ id: "gpt-mini" }] }, claude: { available: true, models: [] } } as never;
  const chainOf = (session: ReturnType<typeof makeSession>, emp?: Employee) =>
    sessionFallbackChain({ config, employee: emp, session, registry, health: {}, scope: { scoped: false, remote: false } });

  it("starts at the chosen profile and, with no employee, inherits that account's own chain", () => {
    const { source, links } = chainOf(makeSession({ claudeConfigDir: spare.dir }));
    expect(source).toBe("account");
    expect(links.map((link) => link.account)).toEqual([SPARE_ACCOUNT, FRIEND_ACCOUNT, "codex"]);
  });

  it("never lists the chosen profile as its own fallback", () => {
    // An employee chain that names the very profile the session was started on.
    const named = { ...employee, claudeConfigDir: undefined, fallback: [{ engine: "claude", profile: "friend" }, "codex"] } as unknown as Employee;
    const { links } = chainOf(makeSession({ employee: "side-dev", claudeConfigDir: friend.dir }), named);
    expect(links.map((link) => link.account)).toEqual([FRIEND_ACCOUNT, "codex"]);
  });

  it("keeps the precedence: the employee's own chain still outranks the account's", () => {
    const withChain = { ...employee, fallback: ["codex"] } as unknown as Employee;
    const { source, links } = chainOf(makeSession({ employee: "side-dev", claudeConfigDir: spare.dir }), withChain);
    expect(source).toBe("employee");
    expect(links.map((link) => link.account)).toEqual([SPARE_ACCOUNT, "codex"]);
  });

  it("is the employee's account chain when no profile was chosen", () => {
    const { links } = chainOf(makeSession());
    expect(links[0]!.account).toBe("claude");
  });
});

describe("the substitute walk from a chosen profile", () => {
  const engines = new Set(["claude", "codex"]);

  it("swaps to the next account, recording the chosen profile as the one to come back to", () => {
    const session = makeSession({ claudeConfigDir: spare.dir });
    const decision = chooseSubstituteOrReason({
      config, engines, session, employee: undefined, account: SPARE_ACCOUNT, remote: undefined, remoteTarget: {},
    });
    expect(decision.choice).toMatchObject({
      engine: "claude", claudeProfile: friend,
      accounts: { original: SPARE_ACCOUNT, substitute: FRIEND_ACCOUNT, substituteConfigDir: friend.dir },
    });
  });
});

describe("a fork or duplicate of a session started on a chosen profile", () => {
  it("starts on the same profile", () => {
    const source = reg.createSession({ engine: "claude", source: "web", sourceRef: "web:primary-fork", model: "opus", claudeConfigDir: friend.dir });
    reg.recordEngineSessionId(source.id, "claude", "friend-thread-1");
    const { session: copy } = reg.duplicateSession(source.id);
    expect(copy.claudeConfigDir).toBe(friend.dir);
    expect(reg.getSession(copy.id)!.claudeConfigDir).toBe(friend.dir);
  });

  it("leaves a session with no chosen profile without one", () => {
    const source = reg.createSession({ engine: "claude", source: "web", sourceRef: "web:primary-fork-none", model: "opus", employee: "side-dev" });
    reg.recordEngineSessionId(source.id, "claude", "thread-1");
    expect(reg.duplicateSession(source.id).session.claudeConfigDir).toBeNull();
  });
});
