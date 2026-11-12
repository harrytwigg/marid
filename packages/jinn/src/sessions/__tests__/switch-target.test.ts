import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { JinnConfig, Session } from "../../shared/types.js";

/**
 * `resolveSwitchTarget`: who may switch a session to what. Every refusal code, the own-target
 * comparison, and the two callers (the operator's selector, a session asking for itself).
 */

const home = fs.mkdtempSync(path.join(os.tmpdir(), "jinn-switch-target-"));
process.env.JINN_HOME = home;
const HEALTH_PATH = path.join(home, "tmp", "engine-health.json");
const uninstalled = new Set<string>();

vi.mock("../../shared/models.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../shared/models.js")>()),
  engineAvailable: (_config: unknown, name: string) => !uninstalled.has(name),
}));

const { resetDepartmentFixtures, writeDepartmentFile, writeEmployeeFile } = await import("../../gateway/__tests__/department-fixtures.js");
const { claudeProfileFromDir } = await import("../../shared/claude-profile.js");
const { getModelRegistry } = await import("../../shared/models.js");
const { resolveSwitchTarget, ownSwitchTarget, describeSwitchTarget } = await import("../switch-target.js");
const { switchRefusalBody } = await import("../switch-request.js");

let registry: typeof import("../registry.js");

// Outside the instance home (which the redirected temp dir sits in): an employee's profile may not lie inside it.
const OUTSIDE = process.env.JINN_VITEST_SYSTEM_TEMP_ROOT ?? "/tmp";
const FRIEND = path.join(OUTSIDE, "switch-target-friend");
const SPARE = path.join(OUTSIDE, "switch-target-spare");
const friend = claudeProfileFromDir(FRIEND);

const config = {
  gateway: { port: 7797, host: "127.0.0.1" },
  engines: {
    default: "claude",
    claude: { bin: "claude", model: "opus", accounts: { friend: { configDir: FRIEND }, spare: { configDir: SPARE } } },
    codex: { bin: "codex", model: "gpt-5.5" },
  },
  models: {
    claude: { default: "opus", models: [{ id: "opus", label: "Opus" }, { id: "sonnet", label: "Sonnet" }] },
    codex: { default: "gpt-5.5", models: [{ id: "gpt-5.5" }] },
  },
  remote: { root: "/srv/root", mount: "/mnt/jinn" },
  connectors: {},
  logging: { file: false, stdout: false, level: "error" },
} as unknown as JinnConfig;

beforeAll(async () => {
  registry = await import("../registry.js");
  const { refreshOrg } = await import("../../gateway/org-registry.js");
  (await import("../../shared/db.js")).initDb();
  resetDepartmentFixtures();
  writeDepartmentFile("lab", "name: lab\nscope: scoped\n");
  writeEmployeeFile("lab", "lab-dev", { department: "lab" });
  writeEmployeeFile("platform", "plain-dev", { department: "platform" });
  writeEmployeeFile("platform", "friend-dev", { department: "platform", claudeConfigDir: FRIEND });
  writeEmployeeFile("platform", "far-dev", { department: "platform", remoteHost: "build-box", remoteUser: "ci", remoteCwd: "/srv/root/work" });
  refreshOrg(config);
});

afterAll(() => {
  fs.rmSync(HEALTH_PATH, { force: true });
});

beforeEach(() => {
  fs.rmSync(HEALTH_PATH, { force: true });
  uninstalled.clear();
});

function session(over: Partial<Parameters<typeof registry.createSession>[0]> = {}): Session {
  return registry.createSession({ engine: "claude", source: "web", sourceRef: `web:t-${Math.random()}`, model: "opus", employee: "plain-dev", ...over });
}

const operator = { caller: "operator" } as const;
const asSession = { caller: "session" } as const;

function refused(result: ReturnType<typeof resolveSwitchTarget>) {
  if (result.ok) throw new Error(`expected a refusal, got ${JSON.stringify(result.target)}`);
  return result;
}

function exhaust(key: string, until = new Date(Date.now() + 3_600_000).toISOString()) {
  fs.mkdirSync(path.dirname(HEALTH_PATH), { recursive: true });
  fs.writeFileSync(HEALTH_PATH, JSON.stringify({ [key]: { state: "exhausted", until, recheckAt: until, reason: "spent" } }));
  return until;
}

describe("invalid-target", () => {
  it.each([
    ["an unknown engine", { engine: "nonesuch" }, /unknown engine "nonesuch"/],
    ["an engine given as a profile spelling", { engine: "claude:friend" }, /names a Claude profile/],
    ["a non-string engine", { engine: 7 }, /engine must be a non-empty string/],
    ["a profile on another engine", { engine: "codex", profile: "friend" }, /profile applies only to the claude engine/],
    ["a null profile on another engine", { engine: "codex", profile: null }, /profile applies only to the claude engine/],
    ["an undeclared profile", { profile: "nobody" }, /unknown Claude profile "nobody" — declared profiles: friend, spare/],
    ["a non-string profile", { profile: 3 }, /profile must be a string or null/],
    ["an unknown model", { model: "no-such-model" }, /unknown model "no-such-model"/],
  ])("refuses %s, for the operator and for the session alike", (_name, request, error) => {
    const s = session();
    for (const options of [operator, asSession]) {
      const result = refused(resolveSwitchTarget(config, s, request, options));
      expect(result).toMatchObject({ code: "invalid-target", status: 400 });
      expect(result.error).toMatch(error);
    }
  });

  it("refuses, for a session asking, an engine that is not installed where it runs", () => {
    uninstalled.add("codex");
    const s = session();
    expect(refused(resolveSwitchTarget(config, s, { engine: "codex" }, asSession))).toMatchObject({ code: "invalid-target" });
    // The selector lists installed engines only, so the operator's switch keeps its old reach.
    expect(resolveSwitchTarget(config, s, { engine: "codex" }, operator).ok).toBe(true);
  });
});

describe("not-allowed", () => {
  it("keeps a department-scoped session on claude, whoever asks", () => {
    const s = session({ employee: "lab-dev" });
    for (const options of [operator, asSession]) {
      expect(refused(resolveSwitchTarget(config, s, { engine: "codex" }, options))).toMatchObject({ code: "not-allowed", status: 403 });
    }
  });

  it("names an unknown engine as invalid before it asks whether a scoped session may go there", () => {
    expect(refused(resolveSwitchTarget(config, session({ employee: "lab-dev" }), { engine: "nonesuch" }, operator)).code).toBe("invalid-target");
  });

  it("lets a department-scoped session change profile, for the operator and for itself", () => {
    const s = session({ employee: "lab-dev" });
    for (const options of [operator, asSession]) {
      const result = resolveSwitchTarget(config, s, { profile: "friend" }, options);
      expect(result).toMatchObject({ ok: true, target: { engine: "claude", profile: "friend", claudeConfigDir: friend.dir } });
    }
  });

  it("refuses a remote employee's session a local profile, and lets it keep its host's login", () => {
    const s = session({ employee: "far-dev" });
    const result = refused(resolveSwitchTarget(config, s, { profile: "friend" }, operator));
    expect(result).toMatchObject({ code: "not-allowed", status: 403 });
    expect(result.error).toMatch(/runs on a remote host and uses that host's Claude login/);
    expect(resolveSwitchTarget(config, s, { profile: "" }, operator).ok).toBe(true);
  });
});

describe("target-exhausted", () => {
  it("is refused for a session asking, with the end of the window, and allowed for the operator", () => {
    const s = session();
    const until = exhaust(`claude:${friend.key}`);

    const result = refused(resolveSwitchTarget(config, s, { profile: "friend" }, asSession));
    expect(result).toMatchObject({ code: "target-exhausted", status: 409, until });
    expect(result.error).toContain(until);
    expect(resolveSwitchTarget(config, s, { profile: "friend" }, operator).ok).toBe(true);
  });

  it("reads another profile's allowance as its own: an exhausted friend does not stop a move to spare", () => {
    exhaust(`claude:${friend.key}`);
    expect(resolveSwitchTarget(config, session(), { profile: "spare" }, asSession).ok).toBe(true);
  });

  it("is refused for an engine whose allowance is spent", () => {
    exhaust("codex");
    expect(refused(resolveSwitchTarget(config, session(), { engine: "codex" }, asSession))).toMatchObject({ code: "target-exhausted" });
  });
});

describe("same-target", () => {
  it("refuses a session its own target, and gives the operator the answer to act on", () => {
    const s = session();
    const result = refused(resolveSwitchTarget(config, s, { engine: "claude", model: "opus" }, asSession));
    expect(result).toMatchObject({ code: "same-target", status: 400 });
    expect(result.error).toMatch(/already runs on Claude · own login · Opus.* — call compact_session without a target/);
    expect(resolveSwitchTarget(config, s, { engine: "claude", model: "opus" }, operator)).toMatchObject({ ok: true, sameTarget: true });
  });

  it("reads a null model as the engine's default", () => {
    const s = session({ model: undefined });
    expect(ownSwitchTarget(config, s).model).toBeNull();
    expect(refused(resolveSwitchTarget(config, s, { model: "opus" }, asSession)).code).toBe("same-target");
    expect(resolveSwitchTarget(config, s, { model: "sonnet" }, asSession).ok).toBe(true);
  });

  it("compares profiles by account: a declared profile on the employee's own directory is the same target", () => {
    const s = session({ employee: "friend-dev" });
    expect(refused(resolveSwitchTarget(config, s, { profile: "friend" }, asSession)).code).toBe("same-target");
    expect(refused(resolveSwitchTarget(config, s, { profile: "" }, asSession)).code).toBe("same-target");
    expect(resolveSwitchTarget(config, s, { profile: "spare" }, asSession).ok).toBe(true);
  });

  it("compares the session's own engine under an engine override, not the stand-in", () => {
    const s = session({ engine: "codex", model: "gpt-5.5" });
    registry.updateSession(s.id, {
      transportMeta: { engineOverride: { originalEngine: "claude", originalModel: "opus", until: "2999-01-01T00:00:00Z", syncSince: "2026-10-19T10:00:00.000Z" } },
    } as never);
    const row = registry.getSession(s.id)!;

    expect(ownSwitchTarget(config, row)).toMatchObject({ engine: "claude", model: "opus" });
    expect(refused(resolveSwitchTarget(config, row, { engine: "claude", model: "opus" }, asSession)).code).toBe("same-target");
    expect(resolveSwitchTarget(config, row, { engine: "codex" }, asSession).ok).toBe(true);
  });
});

describe("the profile", () => {
  it("reads null and the empty string as the session's own login", () => {
    const s = session({ claudeConfigDir: friend.dir });
    for (const profile of [null, ""]) {
      expect(resolveSwitchTarget(config, s, { profile }, operator)).toMatchObject({
        ok: true,
        target: { engine: "claude", profile: null, claudeConfigDir: null },
      });
    }
  });

  it("keeps the row's profile and model when the request names neither", () => {
    const s = session({ claudeConfigDir: friend.dir, model: "sonnet" });
    expect(resolveSwitchTarget(config, s, { engine: "claude" }, operator)).toMatchObject({
      ok: true,
      target: { profile: "friend", claudeConfigDir: friend.dir, model: "sonnet" },
    });
  });

  it("keeps the profile for a move to another engine, and leaves a return to it", () => {
    const s = session({ claudeConfigDir: friend.dir });
    const away = resolveSwitchTarget(config, s, { engine: "codex" }, operator);
    expect(away).toMatchObject({ ok: true, target: { engine: "codex", claudeConfigDir: friend.dir } });
  });

  it("pins the engine's default model for a move to another account, so its slot can be recorded", () => {
    const s = session({ model: undefined });
    expect(resolveSwitchTarget(config, s, { profile: "friend" }, operator)).toMatchObject({ ok: true, target: { model: "opus" } });
  });
});

describe("describeSwitchTarget", () => {
  it("reads as the operator does: engine, profile or own login, model label", () => {
    expect(describeSwitchTarget(config, { engine: "claude", profile: null, claudeConfigDir: null, model: "opus", effortLevel: null })).toMatch(/^Claude · own login · Opus/);
    expect(describeSwitchTarget(config, { engine: "claude", profile: "friend", claudeConfigDir: friend.dir, model: "sonnet", effortLevel: null })).toMatch(/^Claude · friend · Sonnet/);
    expect(describeSwitchTarget(config, { engine: "codex", profile: null, claudeConfigDir: friend.dir, model: null, effortLevel: null })).toBe("Codex · gpt-5.5");
    expect(describeSwitchTarget(config, { engine: "claude", profile: null, claudeConfigDir: SPARE, model: "opus", effortLevel: null })).toMatch(/^Claude · another profile · Opus/);
  });
});

describe("a model the engine does not offer", () => {
  it("never accepts \"?\" (a list request, not a model) from a session or the operator, and lists only the named engine", () => {
    const s = session();
    for (const caller of [asSession, operator]) {
      const result = refused(resolveSwitchTarget(config, s, { engine: "opencode", model: "?" }, caller));
      expect(result.code).toBe("invalid-target");
    }
    const { status, body } = switchRefusalBody(config, s, refused(resolveSwitchTarget(config, s, { engine: "opencode", model: "?" }, asSession)), { engine: "opencode", model: "?" });
    expect(status).toBe(400);
    const lines = String(body.error).split("\n");
    expect(lines).toHaveLength(2);
    expect(lines[1]).toMatch(/^opencode: /);
  });

  it("refuses, for a session, a free-id engine's model its list does not name, and leaves the operator free to type one", () => {
    const s = session();
    const typo = refused(resolveSwitchTarget(config, s, { engine: "opencode", model: "prov/model-typo" }, asSession));
    expect(typo.code).toBe("invalid-target");
    expect(typo.error).toContain("prov/model-typo");
    const [listed] = getModelRegistry(config).opencode.models;
    expect(resolveSwitchTarget(config, s, { engine: "opencode", model: listed.id }, asSession).ok).toBe(true);
    expect(resolveSwitchTarget(config, s, { engine: "opencode", model: "prov/model-typo" }, operator)).toMatchObject({ ok: true, target: { model: "prov/model-typo" } });
  });
});

describe("the effort a switch inherits", () => {
  it("is the session's own pin under a stand-in, so a window that ends before the resume does not read as a move", () => {
    const s = session({ effortLevel: "high" });
    const before = ownSwitchTarget(config, registry.getSession(s.id)!);
    registry.updateSession(s.id, {
      transportMeta: { engineOverride: { originalEngine: "claude", originalModel: "opus", until: "2999-01-01T00:00:00Z", syncSince: "2026-10-19T10:00:00.000Z" } },
    } as never);
    const during = ownSwitchTarget(config, registry.getSession(s.id)!);

    expect(before.effortLevel).toBe("high");
    expect(during).toEqual(before);
  });

  it("is dropped when the target model takes no effort levels, for the operator and for a session", () => {
    const s = session({ effortLevel: "high" });
    // The slot the session once left on opencode kept the effort it ran with there.
    registry.updateSession(s.id, { engineSessions: {
      opencode: { id: "old-thread", model: getModelRegistry(config).opencode.models[0].id, effortLevel: "high" },
    } } as never);
    const row = registry.getSession(s.id)!;

    for (const caller of [operator, asSession]) {
      expect(resolveSwitchTarget(config, row, { engine: "opencode" }, caller)).toMatchObject({ ok: true, target: { engine: "opencode", effortLevel: null } });
    }
    // The same effort stays on a target that takes it, and a requested one the model cannot take is still refused.
    expect(resolveSwitchTarget(config, row, { model: "sonnet" }, operator)).toMatchObject({ ok: true, target: { engine: "claude", effortLevel: "high" } });
    expect(refused(resolveSwitchTarget(config, row, { engine: "opencode", effortLevel: "high" }, operator)).error).toContain("does not support effort levels");
  });
});
