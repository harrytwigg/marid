import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  childFallbackMode, effectiveFallbackMode, isAutoResume, resolveSessionFallbackTarget, sessionFallbackView, startsOnPreferredEngine,
} from "../session-fallback.js";
import { claudeProfileFromDir } from "../../shared/claude-profile.js";
import { makeSession } from "./helpers/session-fixture.js";
import type { Employee, JinnConfig, ModelRegistry } from "../../shared/types.js";
import type { SessionFallbackMode } from "../../shared/session-fallback-config.js";

const FRIEND = path.join(os.tmpdir(), "claude-profile-friend");
const friendKey = claudeProfileFromDir(FRIEND)!.key;

const registry = {
  claude: { name: "claude", available: true, defaultModel: "opus", models: [{ id: "opus" }, { id: "sonnet" }] },
  codex: { name: "codex", available: true, defaultModel: "gpt-default", models: [{ id: "gpt-default" }, { id: "gpt-mapped" }] },
  pi: { name: "pi", available: true, defaultModel: "pi-default", models: [{ id: "pi-default" }] },
  antigravity: { name: "antigravity", available: true, defaultModel: "ag-default", models: [{ id: "ag-default" }] },
} as unknown as ModelRegistry;

function cfg(engines: Record<string, unknown> = {}, sessions?: JinnConfig["sessions"]): JinnConfig {
  return {
    engines: {
      default: "claude",
      claude: { bin: "claude", model: "opus", fallback: ["codex"], ...(engines.claude as object) },
      codex: { bin: "codex", model: "gpt-config", ...(engines.codex as object) },
      pi: { bin: "pi" },
    },
    ...(sessions ? { sessions } : {}),
  } as unknown as JinnConfig;
}

const withMode = (fallbackMode: SessionFallbackMode | null) => makeSession({ fallbackMode });

describe("effectiveFallbackMode", () => {
  it("is the session's own mode, with source session", () => {
    expect(effectiveFallbackMode(cfg(), withMode("auto-resume"))).toEqual({ mode: "auto-resume", source: "session" });
  });
  it("follows sessions.fallbackMode when the session has none, with source default", () => {
    expect(effectiveFallbackMode(cfg({}, { fallbackMode: "fallback-children" }), withMode(null))).toEqual({ mode: "fallback-children", source: "default" });
  });
  it("defaults to fallback with no session mode and no config", () => {
    expect(effectiveFallbackMode(cfg(), withMode(null))).toEqual({ mode: "fallback", source: "default" });
    expect(effectiveFallbackMode({}, undefined)).toEqual({ mode: "fallback", source: "default" });
  });
  it("ignores a garbage config value rather than trusting it", () => {
    expect(effectiveFallbackMode(cfg({}, { fallbackMode: "bogus" as never }), withMode(null)).mode).toBe("fallback");
  });
  it("answers isAutoResume and startsOnPreferredEngine from the same chain", () => {
    expect(isAutoResume(cfg(), withMode("auto-resume"))).toBe(true);
    expect(isAutoResume(cfg({}, { fallbackMode: "auto-resume" }), withMode(null))).toBe(true);
    expect(isAutoResume(cfg({}, { fallbackMode: "auto-resume" }), withMode("fallback"))).toBe(false);
    expect(startsOnPreferredEngine(cfg(), undefined)).toBe(false);
    expect(startsOnPreferredEngine(cfg({}, { fallbackMode: "auto-resume" }), undefined)).toBe(true);
    expect(startsOnPreferredEngine(cfg({}, { fallbackMode: "auto-resume" }), "fallback")).toBe(false);
  });
});

describe("childFallbackMode (the rule applied when a session is created)", () => {
  it("an explicit mode wins over every parent", () => {
    expect(childFallbackMode(cfg(), withMode("auto-resume"), "fallback")).toBe("fallback");
    expect(childFallbackMode(cfg(), withMode("fallback-children"), "auto-resume")).toBe("auto-resume");
    expect(childFallbackMode(cfg(), undefined, "fallback-children")).toBe("fallback-children");
  });
  it("a root stores NULL (undefined), so it follows the config default", () => {
    expect(childFallbackMode(cfg(), undefined)).toBeUndefined();
    expect(childFallbackMode(cfg({}, { fallbackMode: "auto-resume" }), undefined)).toBeUndefined();
  });
  it("a fallback-children parent passes it on, and so does the grandchild's parent in turn", () => {
    const child = childFallbackMode(cfg(), withMode("fallback-children"));
    expect(child).toBe("fallback-children");
    expect(childFallbackMode(cfg(), withMode(child!))).toBe("fallback-children");
  });
  it("a fallback parent's child gets auto-resume", () => {
    expect(childFallbackMode(cfg(), withMode("fallback"))).toBe("auto-resume");
  });
  it("an auto-resume parent's child gets auto-resume", () => {
    expect(childFallbackMode(cfg(), withMode("auto-resume"))).toBe("auto-resume");
  });
  it("a legacy NULL parent follows the config default", () => {
    expect(childFallbackMode(cfg(), withMode(null))).toBe("auto-resume");
    expect(childFallbackMode(cfg({}, { fallbackMode: "fallback-children" }), withMode(null))).toBe("fallback-children");
    expect(childFallbackMode(cfg({}, { fallbackMode: "auto-resume" }), withMode(null))).toBe("auto-resume");
  });
});

describe("resolveSessionFallbackTarget: engine chains", () => {
  it("a chain entry the session may use becomes the target, labelled by the substitute's model", () => {
    expect(resolveSessionFallbackTarget(cfg(), registry, makeSession({ model: "opus" }))).toEqual({ engine: "codex", model: "gpt-config", label: "gpt-config" });
  });

  it("a fallbackModelMap hit the substitute serves is the target's model", () => {
    const config = cfg({ claude: { fallbackModelMap: { opus: "gpt-mapped" } } });
    expect(resolveSessionFallbackTarget(config, registry, makeSession({ model: "opus" }))?.label).toBe("gpt-mapped");
  });

  it("a miss uses the substitute's configured model, then its registry default", () => {
    const config = cfg({ claude: { fallbackModelMap: { opus: "gpt-mapped" } } });
    expect(resolveSessionFallbackTarget(config, registry, makeSession({ model: "sonnet" }))?.label).toBe("gpt-config");
    const noConfigModel = cfg({ codex: { model: undefined } });
    expect(resolveSessionFallbackTarget(noConfigModel, registry, makeSession({ model: "opus" }))?.label).toBe("gpt-default");
  });

  it("a mapped model the substitute does not serve is not shown", () => {
    const config = cfg({ claude: { fallbackModelMap: { opus: "gpt-not-served" } } });
    expect(resolveSessionFallbackTarget(config, registry, makeSession({ model: "opus" }))?.label).toBe("gpt-config");
  });

  it("with no model anywhere the label is the engine's name", () => {
    const bare = { ...registry, codex: { ...registry.codex, defaultModel: undefined } } as unknown as ModelRegistry;
    expect(resolveSessionFallbackTarget(cfg({ codex: { model: undefined } }), bare, makeSession())).toEqual({ engine: "codex", label: "codex" });
  });

  it("an empty chain, or one naming nothing the registry knows, is null", () => {
    expect(resolveSessionFallbackTarget(cfg({ claude: { fallback: [] } }), registry, makeSession())).toBeNull();
    expect(resolveSessionFallbackTarget(cfg({ claude: { fallback: ["hermes"] } }), registry, makeSession())).toBeNull();
  });

  it("a non-Claude session walks its own engine's chain", () => {
    const config = cfg({ codex: { fallback: ["claude"] } });
    expect(resolveSessionFallbackTarget(config, registry, makeSession({ engine: "codex", model: "gpt-config" }))).toEqual({ engine: "claude", model: "opus", label: "opus" });
  });

  it("walks past an entry the registry lacks to the next one", () => {
    const config = cfg({ claude: { fallback: ["hermes", "pi"] } });
    expect(resolveSessionFallbackTarget(config, registry, makeSession())?.engine).toBe("pi");
  });
});

describe("resolveSessionFallbackTarget: Claude accounts", () => {
  const accounts = { friend: { configDir: FRIEND, fallback: [] } };

  it("a default-account chain naming a declared account targets it, with the pin carried through the map", () => {
    const config = cfg({ claude: { fallback: ["claude:friend"], accounts, fallbackModelMap: { opus: "sonnet" } } });
    expect(resolveSessionFallbackTarget(config, registry, makeSession({ model: "opus" }))).toEqual({
      engine: "claude", account: `claude:${friendKey}`, model: "sonnet", label: "claude:friend · sonnet",
    });
  });

  it("with no map hit the pin travels as it is; with no pin the label is the account alone", () => {
    const config = cfg({ claude: { fallback: ["claude:friend"], accounts } });
    expect(resolveSessionFallbackTarget(config, registry, makeSession({ model: "opus" }))?.label).toBe("claude:friend · opus");
    expect(resolveSessionFallbackTarget(config, registry, makeSession({ model: null }))?.label).toBe("claude:friend");
  });

  it("a declared account with an empty chain has nothing to fall back to", () => {
    const config = cfg({ claude: { accounts } });
    const onFriend = makeSession({ transportMeta: { engineOverride: { substituteAccount: `claude:${friendKey}`, originalAccount: "claude", originalEngine: "claude", until: "2999-01-01T00:00:00Z" } } });
    // The session stands on the friend account now, whose chain is empty.
    expect(resolveSessionFallbackTarget(config, registry, onFriend)).toBeNull();
  });

  it("an account chain may end on an engine, which is then an engine target", () => {
    const config = cfg({ claude: { fallback: ["claude:friend", "codex"], accounts } });
    expect(resolveSessionFallbackTarget(config, registry, makeSession())?.account).toBe(`claude:${friendKey}`);
  });
});

describe("resolveSessionFallbackTarget: scoped and remote sessions", () => {
  const accounts = { friend: { configDir: FRIEND, fallback: [] } };

  it("a scoped Claude session takes only a Claude account entry", () => {
    const scoped = makeSession({ scopeDepartment: "dept" });
    expect(resolveSessionFallbackTarget(cfg({ claude: { fallback: ["codex", "claude:friend"], accounts } }), registry, scoped)?.label).toBe("claude:friend · opus");
    expect(resolveSessionFallbackTarget(cfg(), registry, scoped)).toBeNull();
  });

  it("a scoped session on another engine may fall to claude only", () => {
    const scoped = makeSession({ engine: "codex", model: "gpt-config", scopeDepartment: "dept" });
    expect(resolveSessionFallbackTarget(cfg({ codex: { fallback: ["pi", "claude"] } }), registry, scoped)?.engine).toBe("claude");
    expect(resolveSessionFallbackTarget(cfg({ codex: { fallback: ["pi"] } }), registry, scoped)).toBeNull();
  });

  it("a remote employee's target is an engine that can run on its host", () => {
    const remote = { name: "r", engine: "claude", remoteHost: "host.example" } as Employee;
    const config = cfg({ claude: { fallback: ["codex", "antigravity", "pi"] } });
    expect(resolveSessionFallbackTarget(config, registry, makeSession({ employee: "r" }), remote)?.engine).toBe("pi");
    expect(resolveSessionFallbackTarget(cfg(), registry, makeSession({ employee: "r" }), remote)).toBeNull();
  });
});

describe("sessionFallbackView", () => {
  it.each(["fallback", "fallback-children", "auto-resume"] as const)("reports %s with its target whatever the mode, chain present", (mode) => {
    expect(sessionFallbackView(cfg(), registry, withMode(mode))).toEqual({
      mode, modeSource: "session", target: { engine: "codex", model: "gpt-config", label: "gpt-config" },
    });
  });
  it.each(["fallback", "fallback-children", "auto-resume"] as const)("reports %s with a null target when the chain is absent", (mode) => {
    expect(sessionFallbackView(cfg({ claude: { fallback: [] } }), registry, withMode(mode))).toEqual({ mode, modeSource: "session", target: null });
  });
  it("marks a mode that came from the config", () => {
    expect(sessionFallbackView(cfg({}, { fallbackMode: "auto-resume" }), registry, withMode(null)).modeSource).toBe("default");
  });
});
