import { describe, it, expect, vi } from "vitest";
import {
  applyLegacyFallbackMigration, resolveSubstituteModel, validateEngineFallbackModelMaps,
} from "../engine-fallback.js";
import { logger } from "../logger.js";
import { ENGINE_NAMES } from "../models.js";
import type { JinnConfig, ModelRegistry } from "../types.js";

/** A loaded config, as `loadConfig` hands it to the migration. */
function configWith(
  sessions: JinnConfig["sessions"],
  claude: Partial<JinnConfig["engines"]["claude"]> = {},
): JinnConfig {
  return {
    gateway: { port: 7779, host: "127.0.0.1" },
    engines: {
      default: "claude",
      claude: { bin: "claude", model: "opus", ...claude },
      codex: { bin: "codex", model: "gpt-5.5" },
    },
    sessions,
  } as JinnConfig;
}

describe("applyLegacyFallbackMigration", () => {
  it("maps the deprecated sessions pair onto engines.claude.fallback", () => {
    const config = configWith({ rateLimitStrategy: "fallback", fallbackEngine: "codex" });

    applyLegacyFallbackMigration(config, () => {});

    expect(config.engines.claude.fallback).toEqual(["codex"]);
    // Removing the legacy keys is a later Todo: anything still reading them must behave as before.
    expect(config.sessions?.rateLimitStrategy).toBe("fallback");
    expect(config.sessions?.fallbackEngine).toBe("codex");
  });

  it("falls back to codex when only the strategy is set", () => {
    const config = configWith({ rateLimitStrategy: "fallback" });
    applyLegacyFallbackMigration(config, () => {});
    expect(config.engines.claude.fallback).toEqual(["codex"]);
  });

  it("synthesizes no chain when the strategy is absent or \"wait\"", () => {
    for (const sessions of [undefined, { rateLimitStrategy: "wait" } as const]) {
      const config = configWith(sessions);
      applyLegacyFallbackMigration(config, () => {});
      for (const name of ENGINE_NAMES) {
        expect(config.engines[name]?.fallback).toBeUndefined();
      }
    }
  });

  it("leaves an explicit chain alone, including an explicit empty one", () => {
    const chosen = configWith({ rateLimitStrategy: "fallback", fallbackEngine: "codex" }, { fallback: ["grok"] });
    applyLegacyFallbackMigration(chosen, () => {});
    expect(chosen.engines.claude.fallback).toEqual(["grok"]);

    const optedOut = configWith({ rateLimitStrategy: "fallback", fallbackEngine: "codex" }, { fallback: [] });
    applyLegacyFallbackMigration(optedOut, () => {});
    expect(optedOut.engines.claude.fallback).toEqual([]);
  });

  it("warns once per mapped engine, and not at all when the mapping does not fire", async () => {
    vi.resetModules();
    const { applyLegacyFallbackMigration: migrate } = await import("../engine-fallback.js");
    const warn = vi.fn();

    migrate(configWith({ rateLimitStrategy: "fallback", fallbackEngine: "codex" }), warn);
    migrate(configWith({ rateLimitStrategy: "fallback", fallbackEngine: "codex" }), warn);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toContain("engines.claude.fallback");

    migrate(configWith({ rateLimitStrategy: "wait" }), warn);
    expect(warn).toHaveBeenCalledTimes(1);
  });
});


describe("validateEngineFallbackModelMaps", () => {
  it("accepts an absent map and a well-formed one", () => {
    expect(validateEngineFallbackModelMaps({ codex: { bin: "codex", model: "gpt-5.5" } })).toEqual([]);
    expect(validateEngineFallbackModelMaps({
      codex: { fallbackModelMap: { "gpt-5.6-luna": "haiku", "gpt-5.6-sol": "opus" } },
    })).toEqual([]);
  });

  it("refuses a map that is not a mapping, naming the config path", () => {
    expect(validateEngineFallbackModelMaps({ codex: { fallbackModelMap: ["haiku"] } }))
      .toEqual(["engines.codex.fallbackModelMap must be a mapping of model id to model id (got array)"]);
    expect(validateEngineFallbackModelMaps({ codex: { fallbackModelMap: "haiku" } }))
      .toEqual(["engines.codex.fallbackModelMap must be a mapping of model id to model id (got string)"]);
  });

  it("refuses a value that is not a model id, naming the entry it came from", () => {
    // YAML hands every key over as a string, so a key that is not a model id is a blank one.
    expect(validateEngineFallbackModelMaps({ claude: { fallbackModelMap: { opus: 3 } } }))
      .toEqual(['engines.claude.fallbackModelMap["opus"] must be a nonempty model id (got number)']);
    expect(validateEngineFallbackModelMaps({ claude: { fallbackModelMap: { opus: "  " } } }))
      .toEqual(['engines.claude.fallbackModelMap["opus"] must be a nonempty model id (got string)']);
  });

  it("refuses a blank model id as a key, naming the config path", () => {
    expect(validateEngineFallbackModelMaps({ claude: { fallbackModelMap: { "  ": "opus" } } }))
      .toEqual(["engines.claude.fallbackModelMap has a blank model id as a key"]);
  });

  // The live break: `agy models` started printing `id<TAB>label`, discovery kept the
  // whole line as the id, and the composite was saved into the map as if it were one.
  it("refuses an entry whose value carries a control character, naming the entry", () => {
    expect(validateEngineFallbackModelMaps({
      codex: { fallbackModelMap: { "gpt-5.6-sol": "gemini-3.7-flash-high\tGemini 3.7 Flash (High)" } },
    })).toEqual([
      'engines.codex.fallbackModelMap["gpt-5.6-sol"] must be a model id with no control characters ' +
        '(got "gemini-3.7-flash-high\\tGemini 3.7 Flash (High)")',
    ]);
  });

  it("refuses a key that carries a control character, naming the config path", () => {
    expect(validateEngineFallbackModelMaps({
      codex: { fallbackModelMap: { "gpt-5.6-sol\tGPT-5.6 Sol": "opus" } },
    })).toEqual([
      'engines.codex.fallbackModelMap has a key that is not a model id (got "gpt-5.6-sol\\tGPT-5.6 Sol")',
    ]);
  });

  it("reports every bad entry rather than stopping at the first", () => {
    const problems = validateEngineFallbackModelMaps({
      claude: { fallbackModelMap: { opus: 3 } },
      codex: { fallbackModelMap: { "gpt-5.5": null } },
    });
    expect(problems).toHaveLength(2);
    expect(problems[0]).toContain("engines.claude.fallbackModelMap");
    expect(problems[1]).toContain("engines.codex.fallbackModelMap");
  });
});

describe("resolveSubstituteModel", () => {
  /** Claude as the registry reports it: the only two models a substitution may land on. */
  const registry = {
    claude: {
      name: "claude", available: true, defaultModel: "opus", effortMechanism: "claude-flag",
      models: [
        { id: "opus", label: "Opus", supportsEffort: true, effortLevels: ["high"] },
        { id: "haiku", label: "Haiku", supportsEffort: true, effortLevels: ["high"] },
      ],
    },
  } as unknown as ModelRegistry;

  /** A config whose codex block carries the map under test, and nothing else. */
  function withMap(fallbackModelMap?: Record<string, string>): JinnConfig {
    return {
      engines: {
        default: "claude",
        claude: { bin: "claude", model: "opus" },
        codex: { bin: "codex", model: "gpt-5.6-sol", fallbackModelMap },
      },
    } as unknown as JinnConfig;
  }

  const swap = { from: "codex", to: "claude" };

  it("drops a pin no map mentions, leaving the substitute on its own default", () => {
    expect(resolveSubstituteModel(withMap(), registry, { ...swap, model: "gpt-5.6-luna" })).toBeUndefined();
    expect(resolveSubstituteModel(withMap({ "gpt-5.6-sol": "opus" }), registry, { ...swap, model: "gpt-5.6-luna" }))
      .toBeUndefined();
  });

  it("carries a mapped pin the substitute actually serves", () => {
    expect(resolveSubstituteModel(withMap({ "gpt-5.6-luna": "haiku" }), registry, { ...swap, model: "gpt-5.6-luna" }))
      .toBe("haiku");
  });

  it("drops a mapped id the substitute does not serve, and says which entry it came from", () => {
    const warn = vi.spyOn(logger, "warn").mockImplementation(() => {});

    expect(resolveSubstituteModel(withMap({ "gpt-5.6-luna": "gpt-5.6-luna" }), registry, { ...swap, model: "gpt-5.6-luna" }))
      .toBeUndefined();

    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toContain("engines.codex.fallbackModelMap");
    expect(warn.mock.calls[0][0]).toContain("gpt-5.6-luna");
    // Spelled out because the Settings model-map editor refuses the same entry in
    // the same words, off the shared `fallback-map-wire` module. `packages/web`'s
    // fallback-map-wire.test.ts hard-codes this sentence too; drift reddens one of them.
    expect(warn.mock.calls[0][0]).toBe(
      'engines.codex.fallbackModelMap["gpt-5.6-luna"] maps to "gpt-5.6-luna", ' +
        'which engine "claude" does not serve — running claude on its own default model instead.',
    );
    warn.mockRestore();
  });

  it("drops a mapped id that is not spellable at all, and points at config.yaml", () => {
    const warn = vi.spyOn(logger, "warn").mockImplementation(() => {});
    const composite = "gemini-3.7-flash-high\tGemini 3.7 Flash (High)";

    expect(resolveSubstituteModel(withMap({ "gpt-5.6-luna": composite }), registry, { ...swap, model: "gpt-5.6-luna" }))
      .toBeUndefined();

    // The map is the fault, not the CLI that refused the argv, so the warning names
    // the file the operator edits and the entry inside it.
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toBe(
      'engines.codex.fallbackModelMap["gpt-5.6-luna"] in config.yaml maps to ' +
        '"gemini-3.7-flash-high\\tGemini 3.7 Flash (High)", which is not a model id — ' +
        'running claude on its own default model instead.',
    );
    warn.mockRestore();
  });

  it("resolves nothing for a turn that was never pinned", () => {
    const map = withMap({ "gpt-5.6-luna": "haiku" });
    expect(resolveSubstituteModel(map, registry, { ...swap, model: null })).toBeUndefined();
    expect(resolveSubstituteModel(map, registry, { ...swap, model: undefined })).toBeUndefined();
  });
});
