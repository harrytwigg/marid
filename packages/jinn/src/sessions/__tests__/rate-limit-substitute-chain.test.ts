import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Which link a rate-limited turn moves onto, from the session's resolved chain
 * (`shared/fallback-chain.ts`): the walk's rules for object links, remote and
 * scoped sessions, health, where a run stands, and what a link that is a string
 * entry keeps of the old derivation of its model.
 */

vi.mock("../../shared/models.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../shared/models.js")>()),
  engineAvailable: () => true,
  // Only codex lists a catalogue (the one model a session's own fallback target names); no other link's model is ever "not served".
  getModelRegistry: () => ({ codex: { models: [{ id: "gpt-mini" }] } }),
}));
vi.mock("../../engines/remote-stage.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../engines/remote-stage.js")>()),
  remoteEngineAvailable: () => true,
}));
let health: Record<string, { state: "exhausted"; until: string; recheckAt: string }> = {};
vi.mock("../../shared/engine-health.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../shared/engine-health.js")>()),
  readEngineHealth: () => health,
}));

import { chooseSubstituteOrReason, type ChooseSubstituteInput } from "../rate-limit-substitute.js";
import { setDepartmentScopeResolver, setEmployeeDepartmentResolver } from "../../work-items/department-scope.js";
import { claudeProfileFromDir } from "../../shared/claude-profile.js";
import { makeSession } from "./helpers/session-fixture.js";
import type { Employee, JinnConfig } from "../../shared/types.js";

const FRIEND = path.join(os.tmpdir(), "claude-chain-friend");
const friend = claudeProfileFromDir(FRIEND);
const FRIEND_ACCOUNT = `claude:${friend.key}`;
const engines = new Set(["claude", "codex", "pi", "opencode"]);
const spent = () => { const until = new Date(Date.now() + 3600_000).toISOString(); return { state: "exhausted" as const, until, recheckAt: until }; };

function configWith(claude: Record<string, unknown> = {}, other: Record<string, unknown> = {}): JinnConfig {
  return {
    engines: {
      default: "claude",
      claude: { bin: "claude", model: "opus", accounts: { friend: { configDir: FRIEND } }, ...claude },
      codex: { bin: "codex", model: "gpt" }, pi: { bin: "pi", model: "m" }, opencode: { bin: "opencode" }, ...other,
    },
  } as unknown as JinnConfig;
}

function decide(config: JinnConfig, over: Partial<ChooseSubstituteInput> = {}, employee: Partial<Employee> = {}) {
  const emp = { name: "e", engine: "claude", ...employee } as Employee;
  const remote = emp.remoteHost ? { remoteHost: emp.remoteHost } : undefined;
  return chooseSubstituteOrReason({
    config, engines, session: makeSession({ engine: "claude" }), employee: emp, account: "claude", remote, remoteTarget: remote ?? {}, ...over,
  });
}

const OWN = "claude||opus";
const run = (position: number, ...tried: string[]) => ({ position, tried: [OWN, ...tried] });

beforeEach(() => { health = {}; });
afterEach(() => { setDepartmentScopeResolver(null); setEmployeeDepartmentResolver(null); });

describe("object links", () => {
  const chain = [{ engine: "claude", profile: "friend", model: "sonnet" }, { engine: "opencode", model: "x/model-x" }, { engine: "pi" }];

  it("run as the link names them: the engine, the declared profile, the model", () => {
    const { choice, next } = decide(configWith({ fallback: chain }));
    expect(choice).toEqual({
      engine: "claude", model: "sonnet", claudeProfile: friend,
      accounts: { original: "claude", substitute: FRIEND_ACCOUNT, substituteConfigDir: friend.dir, fallbackModelMap: undefined },
    });
    expect(next).toMatchObject({ index: 1, link: { key: "claude|friend|sonnet" } });
  });

  it("carry the model they name to another engine, and leave an unnamed one to the swap", () => {
    expect(decide(configWith({ fallback: chain }), { run: run(1, "claude|friend|sonnet") }).choice).toEqual({ engine: "opencode", model: "x/model-x", claudeProfile: null });
    expect(decide(configWith({ fallback: chain }), { run: run(2, "claude|friend|sonnet", "opencode||x/model-x") }).choice).toEqual({ engine: "pi", claudeProfile: null });
  });

  it("continue after where the run stands, never back to a link tried, and end with nothing", () => {
    expect(decide(configWith({ fallback: chain }), { run: run(2, "claude|friend|sonnet", "opencode||x/model-x", "pi||") }).choice).toBeUndefined();
    // Positioned on the second link, a tried first link is not offered again even though it is healthy.
    expect(decide(configWith({ fallback: chain }), { run: run(2, "claude|friend|sonnet", "opencode||x/model-x") }).next?.link.key).toBe("pi||");
  });

  it("read the run from the session when the caller does not hold one", () => {
    const session = makeSession({ engine: "claude", transportMeta: { fallbackRun: { source: "engine", position: 1, tried: [OWN, "claude|friend|sonnet"], startedAt: "2026-10-19T10:00:00.000Z" } } as never });
    expect(decide(configWith({ fallback: chain }), { session }).next?.link.key).toBe("opencode||x/model-x");
  });
});

describe("health", () => {
  it("passes over a link at its limit, and names it, but still takes it when nothing else is left", () => {
    health = { codex: spent() };
    const config = configWith({ fallback: ["codex", "pi"] });
    expect(decide(config).next).toMatchObject({ link: { key: "pi||" }, skipped: [{ key: "codex||", reason: "exhausted" }] });
    health = { codex: spent(), pi: spent() };
    expect(decide(config).next?.link.key).toBe("codex||");
  });

  it("keeps an opencode provider's limit to that provider", () => {
    health = { "opencode/x": spent() };
    const config = configWith({ fallback: [{ engine: "opencode", model: "x/a" }, { engine: "opencode", model: "y/b" }] });
    expect(decide(config).choice?.model).toBe("y/b");
  });
});

describe("remote sessions keep the remote rule", () => {
  const remoteEmployee = { remoteHost: "box" };
  const asRemote = (config: JinnConfig) => decide(config, {}, remoteEmployee);

  it("take an engine their host can run, never a local profile or another engine", () => {
    const config = configWith({ fallback: [{ engine: "claude", profile: "friend" }, { engine: "codex" }, { engine: "pi" }] });
    const { choice, next } = asRemote(config);
    expect(choice).toEqual({ engine: "pi", claudeProfile: null });
    expect(next?.skipped).toEqual([{ key: "claude|friend|opus", reason: "remote" }, { key: "codex||", reason: "remote" }]);
  });

  it("wait when no link can run there", () => {
    expect(asRemote(configWith({ fallback: ["codex"] })).choice).toBeUndefined();
  });
});

describe("a department-scoped session", () => {
  it("takes a Claude account and skips every other engine, with the reason", () => {
    const scoped = makeSession({ engine: "claude", scopeDepartment: "side-project" });
    const config = configWith({ fallback: [{ engine: "opencode", model: "x/m" }, { engine: "claude", profile: "friend" }] });
    const { choice, next } = decide(config, { session: scoped });
    expect(choice?.accounts?.substitute).toBe(FRIEND_ACCOUNT);
    expect(next?.skipped).toEqual([{ key: "opencode||x/m", reason: "scoped" }]);
    expect(decide(configWith({ fallback: [{ engine: "opencode", model: "x/m" }] }), { session: scoped }).choice).toBeUndefined();
  });
});

describe("a session standing on a stand-in with no run recorded (an override written before runs were)", () => {
  const standing = (engine: string, model: string | null, extra: Record<string, unknown> = {}) => makeSession({
    engine, model, transportMeta: { engineOverride: { originalEngine: "claude", originalModel: "opus", until: "2999-01-01T00:00:00Z", ...extra } } as never,
  });

  it("continues past the link it stands on, found by engine and model, not back to the engine it left", () => {
    const config = configWith({ fallback: ["codex", "pi"] });
    expect(decide(config, { session: standing("codex", null), account: "codex" }).next?.link.key).toBe("pi||");
  });

  it("reads a chain that no longer names the stand-in as standing on the own target, and still never offers it twice in a walk", () => {
    const config = configWith({ fallback: ["pi"] });
    expect(decide(config, { session: standing("codex", null), account: "codex" }).next?.link.key).toBe("pi||");
  });

  it("does not offer the own target as a way out of a stand-in, though it is healthy", () => {
    const config = configWith({ fallback: ["codex"] });
    expect(decide(config, { session: standing("codex", null), account: "codex" }).choice).toBeUndefined();
  });
});

describe("a string entry keeps the old derivation of its model", () => {
  it("for another Claude account, through the account's fallbackModelMap, not the model the session had", () => {
    const config = configWith({ fallback: ["claude:friend"], fallbackModelMap: { opus: "sonnet" } });
    // No model is chosen by the link: the swap derives it (opus -> sonnet through the map).
    expect(decide(config).choice?.model).toBeUndefined();
    expect(decide(config).choice?.accounts?.fallbackModelMap).toEqual({ opus: "sonnet" });
  });

  it("for another engine, through the engine's map, and not at all when the map names nothing", () => {
    expect(decide(configWith({ fallback: ["codex"], fallbackModelMap: { opus: "gpt-5" } })).choice).toEqual({ engine: "codex", claudeProfile: null });
  });
});

describe("a session with its own fallback target", () => {
  it("takes exactly that, as one link after its own target, and never the chain", () => {
    const session = makeSession({ engine: "claude", fallbackTarget: { engine: "codex", model: "gpt-mini" } });
    const config = configWith({ fallback: ["pi"] });
    const { choice, next, chain } = decide(config, { session });
    expect(choice).toMatchObject({ engine: "codex", model: "gpt-mini" });
    expect(next).toMatchObject({ index: 1, link: { key: "codex||gpt-mini" } });
    expect(chain?.source).toBe("session");
  });
});

describe("turns that never move", () => {
  it("are left alone: a board walk, an auto-resume session", () => {
    const config = configWith({ fallback: ["codex"] });
    expect(decide(config, { session: makeSession({ engine: "claude", sessionKey: "board-walk:2026-10-06T10:00:00.000Z" }) })).toEqual({});
    expect(decide(config, { session: makeSession({ engine: "claude", fallbackMode: "auto-resume" }) })).toEqual({});
  });
});

describe("an unprofiled Claude link reached from another engine runs as the employee's own account", () => {
  it("on the employee's profile, judged on the employee's account", () => {
    const WORK = path.join(os.tmpdir(), "claude-chain-work");
    const config = configWith({}, { pi: { bin: "pi", model: "m", fallback: ["claude", "codex"] } });
    const onPi = { engine: "pi" } as const;
    const employee = { name: "e", engine: "pi", claudeConfigDir: WORK } as Employee;
    const work = claudeProfileFromDir(WORK);
    expect(decide(config, { session: makeSession({ engine: "pi", model: null }), account: "pi" }, employee).choice).toEqual({ engine: "claude", claudeProfile: work });
    // The employee's own account is the one that is out: claude is passed over for codex.
    health = { [`claude:${work.key}`]: spent() };
    expect(decide(config, { session: makeSession({ engine: "pi", model: null }), account: "pi" }, employee).choice?.engine).toBe("codex");
    expect(onPi.engine).toBe("pi");
  });
});
