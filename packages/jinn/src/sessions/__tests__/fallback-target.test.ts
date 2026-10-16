import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * A session's own fallback target (`sessions.fallback_target`): how it is stored, which engine and model a
 * usage limit then switches to, why it parks instead, and what a child inherits. Without a target the
 * config's chain applies, covered in session-fallback-enforcement.test.ts.
 */

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "jinn-fallback-target-"));
process.env.JINN_HOME = tmp;

const installed = new Set(["claude", "codex", "opencode"]);
vi.mock("../../shared/models.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../shared/models.js")>()),
  engineAvailable: (_config: unknown, name: string) => installed.has(name),
}));
vi.mock("../../engines/remote-stage.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../engines/remote-stage.js")>()),
  remoteEngineAvailable: () => true,
}));
vi.mock("../../shared/paths.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../shared/paths.js")>()),
  JINN_HOME: tmp,
}));

const reg = await import("../registry.js");
const dbModule = await import("../../shared/db.js");
const { chooseSubstituteOrReason } = await import("../rate-limit-substitute.js");
const { childFallbackTarget, fallbackTargetRefusal, parseFallbackTargetPatch } = await import("../fallback-target.js");
const { sessionFallbackView } = await import("../session-fallback.js");
const { getModelRegistry, invalidateModelRegistry } = await import("../../shared/models.js");
const { recordEngineUnavailable } = await import("../../shared/engine-health.js");
const { makeSession } = await import("./helpers/session-fixture.js");
import type { JinnConfig, Session } from "../../shared/types.js";

const STATE_PATH = path.join(tmp, "tmp", "engine-health.json");
const config = {
  engines: {
    default: "claude",
    claude: { bin: "claude", model: "opus", fallback: ["opencode"] },
    codex: { bin: "codex", model: "gpt-5.6-sol" },
    opencode: { bin: "opencode", model: "opencode/big-pickle" },
  },
  models: {
    claude: { default: "opus", models: [{ id: "opus", label: "Opus" }, { id: "sonnet", label: "Sonnet" }] },
    codex: { default: "gpt-5.6-sol", models: [{ id: "gpt-5.6-sol", label: "GPT Sol" }, { id: "gpt-mini" }] },
  },
} as unknown as JinnConfig;
const engines = new Set(["claude", "codex", "opencode"]);

function choose(session: Session, overrides: Partial<Parameters<typeof chooseSubstituteOrReason>[0]> = {}) {
  return chooseSubstituteOrReason({ config, engines, session, employee: undefined, account: "claude", remote: undefined, remoteTarget: {}, ...overrides });
}

beforeEach(() => {
  fs.rmSync(STATE_PATH, { force: true });
  installed.clear();
  for (const name of ["claude", "codex", "opencode"]) installed.add(name);
  invalidateModelRegistry();
});

describe("sessions.fallback_target storage", () => {
  it("a created session stores its target, a root stores NULL, and it survives reopening the database", () => {
    const withTarget = reg.createSession({ engine: "claude", source: "web", sourceRef: "web:t1", fallbackTarget: { engine: "codex", model: "gpt-mini" } });
    const root = reg.createSession({ engine: "claude", source: "web", sourceRef: "web:t2" });
    expect(withTarget.fallbackTarget).toEqual({ engine: "codex", model: "gpt-mini" });
    expect(root.fallbackTarget).toBeNull();
    dbModule.__closeDbForTest();
    expect(reg.getSession(withTarget.id)?.fallbackTarget).toEqual({ engine: "codex", model: "gpt-mini" });
    expect(reg.getSession(root.id)?.fallbackTarget).toBeNull();
  });

  it("updateSession sets it, leaves it alone for other updates, and null clears it", () => {
    const s = reg.createSession({ engine: "claude", source: "web", sourceRef: "web:t3" });
    expect(reg.updateSession(s.id, { fallbackTarget: { engine: "codex", model: "gpt-mini" } })?.fallbackTarget).toEqual({ engine: "codex", model: "gpt-mini" });
    expect(reg.updateSession(s.id, { title: "renamed" })?.fallbackTarget).toEqual({ engine: "codex", model: "gpt-mini" });
    expect(reg.updateSession(s.id, { fallbackTarget: null })?.fallbackTarget).toBeNull();
  });

  it("a stored value that is not an engine and model reads as NULL, and a duplicate keeps the target", () => {
    const bad = reg.createSession({ engine: "claude", source: "web", sourceRef: "web:t4" });
    dbModule.initDb().prepare("UPDATE sessions SET fallback_target = ? WHERE id = ?").run('{"engine":"codex"}', bad.id);
    expect(reg.getSession(bad.id)?.fallbackTarget).toBeNull();
    dbModule.initDb().prepare("UPDATE sessions SET fallback_target = ? WHERE id = ?").run("not json", bad.id);
    expect(reg.getSession(bad.id)?.fallbackTarget).toBeNull();
    const src = reg.createSession({ engine: "claude", source: "web", sourceRef: "web:t5", fallbackTarget: { engine: "codex", model: "gpt-mini" } });
    reg.recordEngineSessionId(src.id, "claude", "claude-native-1");
    expect(reg.duplicateSession(src.id).session.fallbackTarget).toEqual({ engine: "codex", model: "gpt-mini" });
  });
});

describe("chooseSubstituteOrReason with a target", () => {
  const withTarget = (overrides: Partial<Session> = {}) => makeSession({ fallbackTarget: { engine: "codex", model: "gpt-mini" }, ...overrides });

  it("takes exactly the chosen engine and model, not the chain's first entry", () => {
    const { choice, reason } = choose(withTarget());
    expect(reason).toBeUndefined();
    expect(choice).toMatchObject({ engine: "codex", model: "gpt-mini" });
    // The same session without a target follows the chain (opencode).
    expect(choose(makeSession()).choice?.engine).toBe("opencode");
  });

  it("applies in fallback-children, and is kept but unused in auto-resume", () => {
    expect(choose(withTarget({ fallbackMode: "fallback-children" })).choice?.engine).toBe("codex");
    expect(choose(withTarget({ fallbackMode: "auto-resume" }))).toEqual({});
  });

  it("parks with a reason when the engine is not installed, never taking the chain instead", () => {
    installed.delete("codex");
    const out = choose(withTarget());
    expect(out.choice).toBeUndefined();
    expect(out.reason).toBe("the chosen fallback codex (gpt-mini) is not installed");
  });

  it("parks when the gateway has no engine instance for it", () => {
    expect(choose(withTarget(), { engines: new Set(["claude", "opencode"]) }).reason).toMatch(/not installed/);
  });

  it("parks with a reason when the chosen engine is itself exhausted", () => {
    fs.mkdirSync(path.dirname(STATE_PATH), { recursive: true });
    recordEngineUnavailable("codex", "usage limit", (Date.now() + 90 * 60_000) / 1000);
    const out = choose(withTarget());
    expect(out.choice).toBeUndefined();
    expect(out.reason).toBe("the chosen fallback codex (gpt-mini) has hit its own usage limit");
  });

  it("parks for a department-scoped session whose target is off claude, and takes a claude one", () => {
    expect(choose(withTarget({ scopeDepartment: "ops" })).reason).toMatch(/not allowed for a department-scoped session/);
    const claudeTarget = withTarget({ scopeDepartment: "ops", engine: "claude", model: "opus", fallbackTarget: { engine: "claude", model: "sonnet" } });
    expect(choose(claudeTarget).choice).toMatchObject({ engine: "claude", model: "sonnet" });
  });

  it("parks for a remote session when the target engine cannot run on a host", () => {
    const remote = { remoteHost: "build-host", remoteUser: "ci", remoteCwd: "/work" } as never;
    expect(choose(withTarget(), { remote, remoteTarget: remote }).reason).toMatch(/cannot run on this session's remote host/);
    expect(choose(withTarget({ fallbackTarget: { engine: "opencode", model: "opencode/big-pickle" } }), { remote, remoteTarget: remote }).choice)
      .toMatchObject({ engine: "opencode" });
  });

  it("a same-engine target is a model change that ignores the engine's own limit record, but not a no-op", () => {
    fs.mkdirSync(path.dirname(STATE_PATH), { recursive: true });
    recordEngineUnavailable("claude", "usage limit", (Date.now() + 90 * 60_000) / 1000);
    const sameEngine = withTarget({ model: "opus", fallbackTarget: { engine: "claude", model: "sonnet" } });
    expect(choose(sameEngine).choice).toMatchObject({ engine: "claude", model: "sonnet" });
    const noop = withTarget({ model: "sonnet", fallbackTarget: { engine: "claude", model: "sonnet" } });
    expect(choose(noop).reason).toMatch(/is the model that just hit its limit/);
  });

  it("a claude model change on a substitute account stays on that account", () => {
    const standing = { engineOverride: { originalEngine: "claude", until: new Date(Date.now() + 3600_000).toISOString(), originalAccount: "claude", substituteAccount: "claude:alt", substituteConfigDir: "/tmp/alt" } };
    const session = withTarget({ model: "opus", fallbackTarget: { engine: "claude", model: "sonnet" }, transportMeta: standing as never });
    expect(choose(session, { account: "claude:alt" }).choice?.accounts).toMatchObject({ original: "claude", substitute: "claude:alt", substituteConfigDir: "/tmp/alt" });
  });

  it("parks when the chosen model is no longer offered by an engine with a fixed catalog", () => {
    expect(choose(withTarget({ fallbackTarget: { engine: "codex", model: "gone" } })).reason).toMatch(/no longer offered/);
  });

  it("a board-walk turn never switches, target or not", () => {
    expect(choose(withTarget({ sessionKey: "board-walk:sprint-1" }))).toEqual({});
  });
});

describe("the fallback view", () => {
  const registry = () => getModelRegistry(config);

  it("reports the session's own target with its model label and source session", () => {
    const view = sessionFallbackView(config, registry(), makeSession({ fallbackTarget: { engine: "codex", model: "gpt-5.6-sol" } }));
    expect(view).toMatchObject({ targetSource: "session", target: { engine: "codex", model: "gpt-5.6-sol", label: "GPT Sol" } });
  });

  it("reports the config's chain with source config when there is no target", () => {
    const view = sessionFallbackView(config, registry(), makeSession());
    expect(view).toMatchObject({ targetSource: "config", target: { engine: "opencode" } });
  });

  it("keeps showing the chosen target in auto-resume", () => {
    const view = sessionFallbackView(config, registry(), makeSession({ fallbackMode: "auto-resume", fallbackTarget: { engine: "codex", model: "gpt-mini" } }));
    expect(view).toMatchObject({ mode: "auto-resume", targetSource: "session" });
  });
});

describe("fallbackTargetRefusal and parseFallbackTargetPatch", () => {
  const session = makeSession();
  const refuse = (target: { engine: string; model: string }, s: Session = session) => fallbackTargetRefusal(config, s, undefined, target);

  it("accepts an installed engine's offered model", () => {
    expect(refuse({ engine: "codex", model: "gpt-mini" })).toBeNull();
  });

  it("refuses an unknown engine, an engine that is not installed and a model the engine does not offer", () => {
    expect(refuse({ engine: "nope", model: "x" })).toMatch(/unknown engine "nope"/);
    installed.delete("codex");
    invalidateModelRegistry();
    expect(refuse({ engine: "codex", model: "gpt-mini" })).toMatch(/not installed/);
    installed.add("codex");
    invalidateModelRegistry();
    expect(refuse({ engine: "codex", model: "gpt-9" })).toMatch(/unknown model "gpt-9" for engine "codex"/);
  });

  it("refuses an engine a scoped session may not use, and allows claude", () => {
    const scoped = makeSession({ scopeDepartment: "ops" });
    expect(refuse({ engine: "codex", model: "gpt-mini" }, scoped)).toMatch(/confined to a department/);
    expect(refuse({ engine: "claude", model: "sonnet" }, scoped)).toBeNull();
  });

  it("reads absent, null and an object, and refuses anything else", () => {
    expect(parseFallbackTargetPatch(undefined)).toEqual({ ok: true });
    expect(parseFallbackTargetPatch(null)).toEqual({ ok: true, target: null });
    expect(parseFallbackTargetPatch({ engine: " codex ", model: "gpt-mini" })).toEqual({ ok: true, target: { engine: "codex", model: "gpt-mini" } });
    for (const bad of ["codex", 3, [], { engine: "codex" }, { engine: "", model: "x" }, { engine: "codex", model: 4 }]) {
      expect(parseFallbackTargetPatch(bad)).toMatchObject({ ok: false, error: expect.stringMatching(/^fallbackTarget must be null or an object/) });
    }
  });
});

describe("childFallbackTarget", () => {
  const target = { engine: "codex", model: "gpt-mini" };
  const cfg = {} as Pick<JinnConfig, "sessions">;

  it("a fallback-children parent passes its target on", () => {
    expect(childFallbackTarget(cfg, { fallbackMode: "fallback-children", fallbackTarget: target })).toEqual(target);
  });

  it.each(["fallback", "auto-resume"] as const)("a %s parent does not", (mode) => {
    expect(childFallbackTarget(cfg, { fallbackMode: mode, fallbackTarget: target })).toBeUndefined();
  });

  it("follows the config default for a parent with no mode, and gives nothing without a target, parent or when told to wait", () => {
    expect(childFallbackTarget({ sessions: { fallbackMode: "fallback-children" } }, { fallbackMode: null, fallbackTarget: target })).toEqual(target);
    expect(childFallbackTarget(cfg, { fallbackMode: null, fallbackTarget: target })).toBeUndefined();
    expect(childFallbackTarget(cfg, { fallbackMode: "fallback-children", fallbackTarget: null })).toBeUndefined();
    expect(childFallbackTarget(cfg, undefined)).toBeUndefined();
    expect(childFallbackTarget(cfg, { fallbackMode: "fallback-children", fallbackTarget: target }, "auto-resume")).toBeUndefined();
  });
});
