import { describe, expect, it } from "vitest";
import { AUTO_COMPACT_DEFAULTS, autoCompactProblems, resolveAutoCompactPolicy } from "../auto-compact-config.js";
import { validateConfigShape } from "../config.js";
import type { JinnConfig } from "../types.js";

/** `engines.<claude|opencode>.autoCompact`. */

const withEngines = (engines: Record<string, unknown>) => ({ engines: { default: "claude", claude: {}, ...engines } }) as unknown as JinnConfig;

describe("resolveAutoCompactPolicy", () => {
  it("is disabled with documented defaults when the block is absent", () => {
    expect(resolveAutoCompactPolicy(withEngines({}), "claude")).toEqual({ enabled: false, cacheWindowSeconds: 300, minContextTokens: 100_000 });
    expect(resolveAutoCompactPolicy(withEngines({}), "opencode")).toEqual(AUTO_COMPACT_DEFAULTS.opencode);
  });

  it("reads each engine's own block", () => {
    const config = withEngines({
      claude: { autoCompact: { enabled: true, cacheWindowSeconds: 3600 } },
      opencode: { autoCompact: { enabled: true, minContextTokens: 60_000 } },
    });
    expect(resolveAutoCompactPolicy(config, "claude")).toEqual({ enabled: true, cacheWindowSeconds: 3600, minContextTokens: 100_000 });
    expect(resolveAutoCompactPolicy(config, "opencode")).toEqual({ enabled: true, cacheWindowSeconds: 300, minContextTokens: 60_000 });
  });

  it("has no budget unless one is set, and clamps one to the floor", () => {
    expect(resolveAutoCompactPolicy(withEngines({}), "opencode")).not.toHaveProperty("maxContextTokens");
    const config = withEngines({
      claude: { autoCompact: { enabled: true, maxContextTokens: 10 } },
      opencode: { autoCompact: { enabled: true, maxContextTokens: 300_000 } },
    });
    expect(resolveAutoCompactPolicy(config, "opencode")).toEqual({ enabled: true, cacheWindowSeconds: 300, minContextTokens: 100_000, maxContextTokens: 300_000 });
    expect(resolveAutoCompactPolicy(config, "claude")?.maxContextTokens).toBe(1_000);
    expect(resolveAutoCompactPolicy(withEngines({ opencode: { autoCompact: { maxContextTokens: "300000" } } }), "opencode"))
      .not.toHaveProperty("maxContextTokens");
  });

  it("only enables on a literal true", () => {
    expect(resolveAutoCompactPolicy(withEngines({ claude: { autoCompact: { enabled: "yes" } } }), "claude")?.enabled).toBe(false);
  });

  it("has no policy for an engine that cannot compact", () => {
    expect(resolveAutoCompactPolicy(withEngines({ codex: { autoCompact: { enabled: true } } }), "codex")).toBeUndefined();
  });
});

describe("autoCompactProblems", () => {
  it("accepts a well-formed block, or none", () => {
    expect(autoCompactProblems({ claude: {}, opencode: {} })).toEqual([]);
    expect(autoCompactProblems({ claude: { autoCompact: { enabled: true, cacheWindowSeconds: 300, minContextTokens: 80_000 } } })).toEqual([]);
    expect(autoCompactProblems({ opencode: { autoCompact: { enabled: true, maxContextTokens: 300_000 } } })).toEqual([]);
  });

  it("names every bad field", () => {
    expect(autoCompactProblems({
      claude: { autoCompact: { enabled: "true", cacheWindowSeconds: "300", minContextTokens: -5, maxContextTokens: 500, cacheTTL: 60 } },
    })).toEqual([
      'engines.claude.autoCompact.enabled must be a boolean (got "true")',
      'engines.claude.autoCompact.cacheWindowSeconds must be a number of at least 1 (got "300")',
      "engines.claude.autoCompact.minContextTokens must be a number of at least 1000 (got -5)",
      "engines.claude.autoCompact.maxContextTokens must be a number of at least 1000 (got 500)",
      "engines.claude.autoCompact.cacheTTL is not a known setting (enabled, cacheWindowSeconds, minContextTokens, maxContextTokens)",
    ]);
  });

  it("refuses the block on an engine that cannot compact, and a non-mapping", () => {
    expect(autoCompactProblems({ codex: { autoCompact: { enabled: true } }, opencode: { autoCompact: true } })).toEqual([
      "engines.codex.autoCompact is not supported: only claude and opencode can compact a session",
      "engines.opencode.autoCompact must be a mapping",
    ]);
  });

  it("is part of config validation", () => {
    expect(validateConfigShape({ engines: { claude: { autoCompact: { enabled: 1 } } } }))
      .toContain("engines.claude.autoCompact.enabled must be a boolean (got 1)");
  });
});
