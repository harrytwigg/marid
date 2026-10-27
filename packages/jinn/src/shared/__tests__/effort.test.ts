import { describe, it, expect, beforeEach } from "vitest";
import { resolveEffort } from "../effort.js";
import { effortLevelsForModel, invalidateModelRegistry } from "../models.js";
import type { JinnConfig } from "../types.js";

const CLAUDE = ["low", "medium", "high"];
const CLAUDE_REGISTRY = ["low", "medium", "high", "xhigh", "max"];
const CODEX = ["low", "medium", "high", "xhigh"];

describe("resolveEffort (registry-driven validation)", () => {
  it("passes through codex xhigh (the previously silently-dropped level)", () => {
    expect(resolveEffort({}, { parentSessionId: "p", effortLevel: "xhigh" }, null, CODEX)).toBe("xhigh");
  });

  it("rejects xhigh for claude (not in its levels) and falls back to high", () => {
    expect(resolveEffort({}, { parentSessionId: "p", effortLevel: "xhigh" }, null, CLAUDE)).toBe("high");
  });

  it("claude still accepts low/medium/high", () => {
    expect(resolveEffort({}, { parentSessionId: "p", effortLevel: "low" }, null, CLAUDE)).toBe("low");
    expect(resolveEffort({}, { parentSessionId: "p", effortLevel: "high" }, null, CLAUDE)).toBe("high");
  });

  it("drops an unknown level and defaults (graceful degradation, no throw)", () => {
    expect(resolveEffort({ effortLevel: "ultra" }, { parentSessionId: null, effortLevel: null }, null, CLAUDE)).toBe("high");
  });

  it("returns the default without warning when the engine has no effort concept (empty levels)", () => {
    expect(resolveEffort({ effortLevel: "low" }, { parentSessionId: "p", effortLevel: "low" }, null, [])).toBe("high");
  });

  describe("built-in default when nothing chooses a level", () => {
    const unset = { parentSessionId: null, effortLevel: null } as never;
    const child = { parentSessionId: "p", effortLevel: null } as never;

    it("is high for a non-child and a child session", () => {
      expect(resolveEffort({}, unset, null, CLAUDE_REGISTRY)).toBe("high");
      expect(resolveEffort({}, child, { effortLevel: undefined } as never, CODEX)).toBe("high");
    });

    it("falls back to the nearest listed level when the model has no high", () => {
      expect(resolveEffort({}, unset, null, ["low", "medium"])).toBe("medium");
      expect(resolveEffort({}, unset, null, ["xhigh", "max"])).toBe("xhigh");
      expect(resolveEffort({}, unset, null, ["minimal", "low"])).toBe("low");
    });

    it("takes the lighter level on a tie", () => {
      expect(resolveEffort({}, unset, null, ["medium", "xhigh"])).toBe("medium");
    });

    it("uses the first level when none is a known name", () => {
      expect(resolveEffort({}, unset, null, ["fast", "slow"])).toBe("fast");
    });

    it("never returns a level the model does not list", () => {
      for (const levels of [["low"], ["low", "medium"], ["max"], ["fast"], ["low", "xhigh", "max"]]) {
        expect(levels).toContain(resolveEffort({}, unset, null, levels));
      }
    });

    it("still falls back to the built-in default when the engine config level is invalid", () => {
      expect(resolveEffort({ effortLevel: "ultra" }, unset, null, ["low", "medium"])).toBe("medium");
    });
  });

  describe("child-effort resolution chain", () => {
    it("childEffortOverride wins over everything", () => {
      expect(resolveEffort(
        { childEffortOverride: "low" },
        { parentSessionId: "p", effortLevel: "high" },
        { effortLevel: "medium" },
        CLAUDE,
      )).toBe("low");
    });
    it("session beats employee", () => {
      expect(resolveEffort({}, { parentSessionId: "p", effortLevel: "high" }, { effortLevel: "low" }, CLAUDE)).toBe("high");
    });
    it("employee default when no session level", () => {
      expect(resolveEffort({}, { parentSessionId: "p", effortLevel: null }, { effortLevel: "low" }, CLAUDE)).toBe("low");
    });
    it("skips an invalid override and continues down the chain", () => {
      expect(resolveEffort(
        { childEffortOverride: "ultra" },
        { parentSessionId: "p", effortLevel: "high" },
        null,
        CLAUDE,
      )).toBe("high");
    });
  });

  it("non-child sessions use explicit session effort before the engine default", () => {
    expect(resolveEffort({ effortLevel: "high" }, { parentSessionId: null, effortLevel: "low" }, { effortLevel: "low" }, CLAUDE)).toBe("low");
  });

  it("non-child assigned sessions use employee default before the engine default", () => {
    expect(resolveEffort({ effortLevel: "high" }, { parentSessionId: null, effortLevel: null }, { effortLevel: "low" }, CLAUDE)).toBe("low");
  });

  it("non-child sessions fall back to engine default when no session or employee effort is set", () => {
    expect(resolveEffort({ effortLevel: "high" }, { parentSessionId: null, effortLevel: null }, null, CLAUDE)).toBe("high");
  });

  it('treats "default" as unset without warning through the resolution chain', () => {
    expect(resolveEffort(
      { effortLevel: "default", childEffortOverride: "default" },
      { parentSessionId: "p", effortLevel: "default" },
      { effortLevel: "default" },
      CLAUDE,
    )).toBe("high");
  });
});

describe("effortLevelsForModel (registry lookup)", () => {
  function cfg(): JinnConfig {
    return {
      gateway: { port: 7777, host: "127.0.0.1" },
      engines: {
        default: "claude",
        claude: { bin: "claude", model: "opus" },
        codex: { bin: "codex", model: "gpt-5.4" },
        antigravity: { model: "gemini-3-flash-preview" },
      },
      models: {
        claude: { default: "opus", models: [{ id: "opus", supportsEffort: true, effortLevels: CLAUDE }] },
        codex: { default: "gpt-5.4", models: [{ id: "gpt-5.4", supportsEffort: true, effortLevels: CODEX }] },
        antigravity: { models: [{ id: "gemini-3-flash-preview", supportsEffort: false, effortLevels: [] }] },
      },
      connectors: {},
    } as unknown as JinnConfig;
  }
  beforeEach(() => invalidateModelRegistry());

  it("returns codex levels including xhigh", () => {
    expect(effortLevelsForModel(cfg(), "codex")).toContain("xhigh");
  });
  it("returns [] for antigravity (no effort support)", () => {
    expect(effortLevelsForModel(cfg(), "antigravity")).toEqual([]);
  });
  it("returns [] for an unknown engine", () => {
    expect(effortLevelsForModel(cfg(), "nope")).toEqual([]);
  });
  it("returns claude levels for its default model", () => {
    expect(effortLevelsForModel(cfg(), "claude")).toEqual(CLAUDE_REGISTRY);
  });
});

describe("resolveEffort for an engine whose level lives on the CLI's screen", () => {
  const session = { parentSessionId: null, effortLevel: null } as never;
  const levels = ["low", "medium", "high"];

  it("says `default` when nothing chose a level, so the CLI's own setting stands", () => {
    expect(resolveEffort({}, session, null, levels, "freebuff")).toBe("default");
    expect(resolveEffort({}, session, null, [], "freebuff")).toBe("default");
    expect(resolveEffort({}, session, null, levels, "codex")).toBe("high");
  });

  it("still returns a level the employee or the engine chose", () => {
    expect(resolveEffort({}, session, { effortLevel: "high" } as never, levels, "freebuff")).toBe("high");
    expect(resolveEffort({ effortLevel: "low" }, session, null, levels, "freebuff")).toBe("low");
  });
});
