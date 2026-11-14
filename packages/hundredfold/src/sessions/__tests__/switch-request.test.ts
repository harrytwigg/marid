import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { HundredfoldConfig, Session } from "../../shared/types.js";

/**
 * The refusal's list: structured (`listSwitchTargets`) and rendered into `error`
 * (`renderRefusal`), bounded; and the property that every target the list offers a session is
 * a target the resolver accepts it for (SC-005).
 */

const home = fs.mkdtempSync(path.join(os.tmpdir(), "hundredfold-switch-request-"));
process.env.HUNDREDFOLD_HOME = home;
const HEALTH_PATH = path.join(home, "tmp", "engine-health.json");
const OUTSIDE = process.env.HUNDREDFOLD_VITEST_SYSTEM_TEMP_ROOT ?? "/tmp";
const ALPHA = path.join(OUTSIDE, "switch-request-alpha");
const BETA = path.join(OUTSIDE, "switch-request-beta");

vi.mock("../../shared/models.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../shared/models.js")>()),
  engineAvailable: () => true,
}));

const { resetDepartmentFixtures, writeDepartmentFile, writeEmployeeFile } = await import("../../gateway/__tests__/department-fixtures.js");
const { listSwitchTargets, resolveSwitchTarget } = await import("../switch-target.js");
const { renderRefusal, REFUSAL_ERROR_MAX_CHARS, switchRequestOf } = await import("../switch-request.js");
const { claudeProfileFromDir } = await import("../../shared/claude-profile.js");
let registry: typeof import("../registry.js");

const config = {
  gateway: { port: 7797, host: "127.0.0.1" },
  engines: { default: "claude", claude: { bin: "claude", model: "opus", accounts: { alpha: { configDir: ALPHA }, beta: { configDir: BETA } } }, codex: { bin: "codex", model: "gpt-5.5" } },
  models: {
    claude: { default: "opus", models: [{ id: "opus" }, { id: "sonnet" }] },
    codex: { default: "gpt-5.5", models: [{ id: "gpt-5.5" }, { id: "gpt-5.4" }] },
  },
  remote: { root: "/srv/root", mount: "/mnt/hundredfold" },
  connectors: {},
  logging: { file: false, stdout: false, level: "error" },
} as unknown as HundredfoldConfig;

beforeAll(async () => {
  registry = await import("../registry.js");
  const { refreshOrg } = await import("../../gateway/org-registry.js");
  (await import("../../shared/db.js")).initDb();
  resetDepartmentFixtures();
  writeDepartmentFile("lab", "name: lab\nscope: scoped\n");
  writeEmployeeFile("lab", "lab-dev", { department: "lab" });
  writeEmployeeFile("platform", "plain-dev", { department: "platform" });
  writeEmployeeFile("platform", "far-dev", { department: "platform", remoteHost: "build-box", remoteUser: "ci", remoteCwd: "/srv/root/work" });
  refreshOrg(config);
});
afterAll(() => fs.rmSync(HEALTH_PATH, { force: true }));
beforeEach(() => fs.rmSync(HEALTH_PATH, { force: true }));

const session = (over: Partial<Parameters<typeof registry.createSession>[0]> = {}): Session =>
  registry.createSession({ engine: "claude", source: "web", sourceRef: `web:r-${Math.random()}`, model: "opus", employee: "plain-dev", ...over });

describe("switchRequestOf", () => {
  it("is undefined for a body naming no target, and reads the three fields (null and empty profile included) when one is named", () => {
    expect(switchRequestOf({ goal: "g", sessionId: "x" })).toBeUndefined();
    expect(switchRequestOf(undefined)).toBeUndefined();
    expect(switchRequestOf({ profile: "" })).toEqual({ engine: undefined, profile: "", model: undefined });
    expect(switchRequestOf({ profile: null })).toEqual({ engine: undefined, profile: null, model: undefined });
    expect(switchRequestOf({ model: "sonnet", sessionId: "x" })).toEqual({ engine: undefined, profile: undefined, model: "sonnet" });
  });
});

describe("renderRefusal", () => {
  const manyModels = Array.from({ length: 60 }, (_, i) => ({ id: `provider/model-with-a-long-name-${i}`, label: `m${i}` }));
  const list = {
    current: { engine: "claude", profile: null, model: "opus" },
    engines: [
      { name: "claude", defaultModel: "opus", health: { state: "ok" as const }, models: [{ id: "opus", label: "Opus" }, { id: "sonnet", label: "Sonnet" }], profiles: [{ name: "", label: "own login", health: { state: "ok" as const } }, { name: "work", label: "work", health: { state: "exhausted" as const, until: "2026-11-12T15:00:00.000Z" } }] },
      { name: "opencode", defaultModel: "provider/model-with-a-long-name-0", health: { state: "ok" as const }, models: manyModels },
    ],
  };
  let own: Session;
  beforeAll(() => { own = session(); });

  it("stays within the bound with 60 opencode models and ends that engine's line with the count and how to read it all", () => {
    const text = renderRefusal(config, own, 'unknown engine "?"', list, { engine: "?" });
    expect(text.length).toBeLessThanOrEqual(REFUSAL_ERROR_MAX_CHARS);
    const lines = text.split("\n");
    expect(lines[0]).toMatch(/^unknown engine "\?" — call again with one of these\. Now: Claude · own login · Opus.*\.$/);
    expect(lines[1]).toBe('claude: profiles "" (own login), work (exhausted until 2026-11-12T15:00Z); models opus, sonnet.');
    expect(lines[2]).toMatch(/^opencode: models provider\/model-with-a-long-name-0, .*… \+\d+ more \(call with engine "opencode", model "\?" for its list\)\.$/);
    const shown = (lines[2].match(/provider\/model-with-a-long-name-\d+/g) ?? []).length;
    expect(lines[2]).toContain(`+${60 - shown} more`);
  });

  it("lists only the named engine for model \"?\", with the same bound and its own tail", () => {
    const text = renderRefusal(config, own, "unknown model \"?\"", list, { engine: "opencode", model: "?" });
    expect(text.split("\n")).toHaveLength(2);
    expect(text).not.toContain("claude:");
    expect(text.length).toBeLessThanOrEqual(REFUSAL_ERROR_MAX_CHARS);
    const shown = (text.match(/provider\/model-with-a-long-name-\d+/g) ?? []).length;
    expect(shown).toBeGreaterThan(20);
    expect(text).toContain(`+${60 - shown} more`);
  });

  it("lists everything when it all fits, with no count", () => {
    const small = { ...list, engines: [list.engines[0]] };
    const text = renderRefusal(config, own, "x", small, { engine: "?" });
    expect(text).not.toContain("more (call with");
    expect(text).toContain("models opus, sonnet.");
  });

  it("gives an exhausted engine's window and an engine with no listed models", () => {
    const text = renderRefusal(config, own, "x", { ...list, engines: [{ name: "codex", defaultModel: "gpt-5.5", health: { state: "exhausted", until: "2026-11-12T15:00:00.000Z" }, models: [] }] }, { engine: "?" });
    expect(text).toContain("codex (exhausted until 2026-11-12T15:00Z): no listed models.");
  });
});

describe("listSwitchTargets", () => {
  it("names the session's current target, with own login first and every declared profile", () => {
    const targets = listSwitchTargets(config, session());
    expect(targets.current).toEqual({ engine: "claude", profile: null, model: "opus" });
    const claude = targets.engines.find((e) => e.name === "claude")!;
    expect(claude.profiles!.map((p) => [p.name, p.label])).toEqual([["", "own login"], ["alpha", "alpha"], ["beta", "beta"]]);
    expect(targets.engines.map((e) => e.name)).toContain("codex");
  });

  it("marks an exhausted profile with the window's end, and the engine only when every profile is out", () => {
    const until = new Date(Date.now() + 3_600_000).toISOString();
    fs.mkdirSync(path.dirname(HEALTH_PATH), { recursive: true });
    fs.writeFileSync(HEALTH_PATH, JSON.stringify({ [`claude:${claudeProfileFromDir(ALPHA)!.key}`]: { state: "exhausted", until, recheckAt: until, reason: "spent" } }));
    const claude = listSwitchTargets(config, session()).engines.find((e) => e.name === "claude")!;
    expect(claude.profiles!.find((p) => p.name === "alpha")!.health).toEqual({ state: "exhausted", until });
    expect(claude.health.state).toBe("ok");
  });

  it("lists claude only for a department-scoped session, and no profiles for a remote employee's", () => {
    expect(listSwitchTargets(config, session({ employee: "lab-dev" })).engines.map((e) => e.name)).toEqual(["claude"]);
    const remote = listSwitchTargets(config, session({ employee: "far-dev" }));
    expect(remote.engines.find((e) => e.name === "claude")!.profiles).toBeUndefined();
  });

  it.each([["unscoped", "plain-dev"], ["scoped", "lab-dev"], ["remote", "far-dev"]])("every target it offers a %s session is one the resolver accepts for it (SC-005)", (_name, employee) => {
    const s = session({ employee });
    const targets = listSwitchTargets(config, s);
    type Candidate = { engine: string; profile: string | undefined; model: string };
    const candidates: Candidate[] = targets.engines
      .filter((e) => e.health.state === "ok")
      .flatMap((e) => (e.profiles?.filter((p) => p.health.state === "ok").map((p) => p.name) ?? [undefined]).map((profile) => ({ e, profile })))
      .flatMap(({ e, profile }) => e.models.map((model) => ({ engine: e.name, profile, model: model.id })));
    const isOwn = (c: Candidate) => c.engine === targets.current.engine && c.model === targets.current.model
      && (c.profile === undefined || (c.profile === "" ? targets.current.profile === null : c.profile === targets.current.profile));
    const checked = candidates.filter((c) => !isOwn(c)).map((c) => {
      const result = resolveSwitchTarget(config, s, { engine: c.engine, ...(c.profile === undefined ? {} : { profile: c.profile }), model: c.model }, { caller: "session" });
      expect(result.ok, `${c.engine}/${c.profile}/${c.model}: ${result.ok ? "" : result.error}`).toBe(true);
      return c;
    }).length;
    expect(checked).toBeGreaterThan(0);
  });
});
