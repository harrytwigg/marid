import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * What an `auto-resume` session changes: no substitute at a usage limit, no
 * creation-time reroute off a spent engine, and no standing stand-in at the next
 * turn. The same session in `fallback` still gets every one of them.
 */

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "jinn-fallback-enforcement-"));
process.env.JINN_HOME = tmp;

vi.mock("../../shared/models.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../shared/models.js")>()),
  engineAvailable: () => true,
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
const { chooseSubstitute } = await import("../rate-limit-substitute.js");
const { newSessionEngineSelection } = await import("../new-session-engine.js");
const { validateNewSessionSelection } = await import("../session-patch.js");
const { maybeRevertEngineOverride } = await import("../engine-override.js");
const { recordEngineUnavailable } = await import("../../shared/engine-health.js");
const { makeSession } = await import("./helpers/session-fixture.js");
import type { Engine, JinnConfig, Session } from "../../shared/types.js";
import type { SessionFallbackMode } from "../../shared/session-fallback-config.js";

const STATE_PATH = path.join(tmp, "tmp", "engine-health.json");
const engines = new Set(["claude", "codex"]);
const engineMap = new Map<string, Engine>([["claude", { name: "claude", run: vi.fn() }], ["codex", { name: "codex", run: vi.fn() }]]);

function cfg(sessions?: JinnConfig["sessions"]): JinnConfig {
  return {
    engines: { default: "claude", claude: { bin: "claude", model: "opus", fallback: ["codex"] }, codex: { bin: "codex", model: "gpt" } },
    ...(sessions ? { sessions } : {}),
  } as unknown as JinnConfig;
}

function choose(session: Session, config = cfg()) {
  return chooseSubstitute({ config, engines, session, employee: undefined, account: "claude", remote: undefined, remoteTarget: {} });
}

const spendClaude = () => {
  fs.mkdirSync(path.dirname(STATE_PATH), { recursive: true });
  fs.rmSync(STATE_PATH, { force: true });
  recordEngineUnavailable("claude", "usage limit", (Date.now() + 90 * 60_000) / 1000);
};

beforeEach(() => {
  fs.rmSync(STATE_PATH, { force: true });
});

describe("chooseSubstitute", () => {
  it("never substitutes an auto-resume session, though its chain has a usable engine", () => {
    expect(choose(makeSession({ fallbackMode: "auto-resume" }))).toBeUndefined();
  });

  it.each<SessionFallbackMode>(["fallback", "fallback-children"])("still substitutes the same session in %s", (mode) => {
    expect(choose(makeSession({ fallbackMode: mode }))?.engine).toBe("codex");
  });

  it("follows the config default for a session with no mode of its own", () => {
    expect(choose(makeSession({ fallbackMode: null }), cfg({ fallbackMode: "auto-resume" }))).toBeUndefined();
    expect(choose(makeSession({ fallbackMode: null }))?.engine).toBe("codex");
    // The session's own mode outranks the default in both directions.
    expect(choose(makeSession({ fallbackMode: "fallback" }), cfg({ fallbackMode: "auto-resume" }))?.engine).toBe("codex");
  });

  it("holds for a non-Claude session too", () => {
    const config = { ...cfg(), engines: { ...cfg().engines, codex: { bin: "codex", model: "gpt", fallback: ["claude"] } } } as unknown as JinnConfig;
    const codexSession = (fallbackMode: SessionFallbackMode) => makeSession({ engine: "codex", model: "gpt", fallbackMode });
    expect(choose(codexSession("auto-resume"), config)).toBeUndefined();
    expect(choose(codexSession("fallback"), config)?.engine).toBe("claude");
  });
});

describe("a new session's start (creation-time reroute)", () => {
  it("starts an auto-resume session on its preferred engine though that engine is spent", () => {
    spendClaude();
    const picked = newSessionEngineSelection(cfg(), engineMap, { fallbackMode: "auto-resume" });
    expect(picked.engine).toBe("claude");
    expect(picked.transportMeta).toBeUndefined();
  });

  it("reroutes the same session in fallback, recording the way back", () => {
    spendClaude();
    const picked = newSessionEngineSelection(cfg(), engineMap, { fallbackMode: "fallback" });
    expect(picked.engine).toBe("codex");
    expect(picked.transportMeta).toMatchObject({ engineOverride: { originalEngine: "claude" } });
  });

  it("uses the config default when the creation names no mode", () => {
    spendClaude();
    expect(newSessionEngineSelection(cfg({ fallbackMode: "auto-resume" }), engineMap, {}).engine).toBe("claude");
    expect(newSessionEngineSelection(cfg(), engineMap, {}).engine).toBe("codex");
  });

  it("validateNewSessionSelection skips its reroute on the same terms", () => {
    spendClaude();
    const registryConfig = { ...cfg(), models: { claude: { default: "opus", models: [{ id: "opus" }] }, codex: { default: "gpt", models: [{ id: "gpt" }] } } } as unknown as JinnConfig;
    const auto = validateNewSessionSelection(registryConfig, {}, { fallbackMode: "auto-resume" });
    expect(auto).toMatchObject({ ok: true, engine: "claude" });
    expect(auto.reroute).toBeUndefined();
    const plain = validateNewSessionSelection(registryConfig, {}, { fallbackMode: "fallback" });
    expect(plain).toMatchObject({ ok: true, engine: "codex" });
    expect(plain.reroute?.from).toBe("claude");
    // No mode named: the config default decides.
    expect(validateNewSessionSelection({ ...registryConfig, sessions: { fallbackMode: "auto-resume" } } as JinnConfig, {}).engine).toBe("claude");
  });
});

describe("a standing stand-in at the next turn start", () => {
  const standing = {
    engineOverride: {
      originalEngine: "claude", originalEngineSessionId: "claude-thread", originalModel: "opus",
      until: new Date(Date.now() + 3 * 3600_000).toISOString(), syncSince: "2026-01-01T00:00:00.000Z",
    },
  };

  function onStandIn(fallbackMode: SessionFallbackMode | null): Session {
    const s = reg.createSession({ engine: "claude", source: "web", sourceRef: `web:standin-${Math.random()}`, model: "opus" });
    reg.updateSession(s.id, { engine: "codex", engineSessionId: null, model: null, fallbackMode, transportMeta: standing as never });
    return reg.getSession(s.id)!;
  }

  it("is reverted at once for an auto-resume session, though its window has hours left", () => {
    const reverted = maybeRevertEngineOverride(onStandIn("auto-resume"), undefined, cfg());
    expect(reverted.engine).toBe("claude");
    expect(reverted.model).toBe("opus");
    expect(reverted.transportMeta?.engineOverride).toBeUndefined();
  });

  it("is reverted when the config default is auto-resume and the session has no mode", () => {
    expect(maybeRevertEngineOverride(onStandIn(null), undefined, cfg({ fallbackMode: "auto-resume" })).engine).toBe("claude");
  });

  it("stands for a session in fallback until its window passes", () => {
    const kept = maybeRevertEngineOverride(onStandIn("fallback"), undefined, cfg());
    expect(kept.engine).toBe("codex");
    expect(kept.transportMeta?.engineOverride).toBeDefined();
  });

  it("counts only the session's own mode when the caller has no config to give", () => {
    expect(maybeRevertEngineOverride(onStandIn("auto-resume")).engine).toBe("claude");
    expect(maybeRevertEngineOverride(onStandIn(null)).engine).toBe("codex");
  });
});
