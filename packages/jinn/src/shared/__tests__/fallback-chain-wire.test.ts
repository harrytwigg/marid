import { describe, it, expect } from "vitest";
import { fallbackChainProblems, fallbackLinkKey, fallbackLinkLabel, fallbackLinkOf, type FallbackChainContext } from "../fallback-chain-wire.js";

const engines = ["claude", "codex", "opencode"] as const;

function ctx(self?: FallbackChainContext["self"]): FallbackChainContext {
  return { engines, profiles: new Set(["work", "spare"]), self };
}

describe("fallbackLinkOf", () => {
  it("reads both string forms and the object form", () => {
    expect(fallbackLinkOf("codex")).toEqual({ engine: "codex" });
    expect(fallbackLinkOf("claude:work")).toEqual({ engine: "claude", profile: "work" });
    expect(fallbackLinkOf({ engine: " opencode ", model: "openrouter/x" })).toEqual({ engine: "opencode", model: "openrouter/x" });
  });

  it("drops blank optional fields and refuses entries of neither form", () => {
    expect(fallbackLinkOf({ engine: "claude", profile: " ", model: "" })).toEqual({ engine: "claude" });
    expect(fallbackLinkOf({ model: "sonnet" })).toBeNull();
    expect(fallbackLinkOf(["codex"])).toBeNull();
    expect(fallbackLinkOf("  ")).toBeNull();
  });
});

describe("fallbackLinkKey and fallbackLinkLabel", () => {
  it("tell targets apart by engine, profile and model", () => {
    const keys = new Set([
      { engine: "claude" },
      { engine: "claude", profile: "work" },
      { engine: "claude", profile: "work", model: "sonnet" },
      { engine: "opencode", model: "opencode-go/x" },
      { engine: "opencode", model: "openrouter/x" },
    ].map(fallbackLinkKey));
    expect(keys.size).toBe(5);
    expect(fallbackLinkLabel({ engine: "claude", profile: "work", model: "sonnet" })).toBe("claude · work · sonnet");
  });
});

describe("fallbackChainProblems", () => {
  it("accepts the same engine on other profiles and models, mixed with legacy strings", () => {
    const chain = [
      { engine: "claude", profile: "work", model: "sonnet" },
      { engine: "claude", profile: "spare" },
      { engine: "opencode", model: "opencode-go/glm" },
      { engine: "opencode", model: "openrouter/glm" },
      "codex",
    ];
    expect(fallbackChainProblems("engines.claude.fallback", chain, ctx({ engine: "claude" }))).toEqual([]);
  });

  it("refuses an exact duplicate, naming both positions and the target", () => {
    const chain = [{ engine: "opencode", model: "openrouter/x" }, "codex", { engine: "opencode", model: "openrouter/x" }];
    expect(fallbackChainProblems("engines.claude.fallback", chain, ctx())).toEqual([
      "engines.claude.fallback[2] duplicates engines.claude.fallback[0] (opencode · openrouter/x): a chain tries each target once, so list it once",
    ]);
  });

  it("treats a legacy string and its object form as the same target", () => {
    expect(fallbackChainProblems("c", ["claude:work", { engine: "claude", profile: "work" }], ctx())).toHaveLength(1);
  });

  it("refuses the chain's own target, in either form", () => {
    expect(fallbackChainProblems("engines.codex.fallback", ["codex"], ctx({ engine: "codex" }))[0]).toMatch(/is the target this chain falls back from/);
    expect(fallbackChainProblems("a", [{ engine: "claude", profile: "work" }], ctx({ engine: "claude", profile: "work" }))).toHaveLength(1);
  });

  it("refuses unknown engines, misplaced or undeclared profiles, and bad models", () => {
    const problems = fallbackChainProblems("c", [
      "gemini",
      { engine: "codex", profile: "work" },
      { engine: "claude", profile: "nobody" },
      { engine: "claude", model: 7 },
      { model: "sonnet" },
    ], ctx());
    expect(problems).toEqual([
      'c[0]: "gemini" is not a known engine (claude, codex, opencode)',
      "c[1]: only a claude target takes a profile",
      'c[2]: profile "nobody" names no account under engines.claude.accounts',
      "c[3].model must be a model id",
      "c[4] must be an engine name or a mapping with engine, profile and model",
    ]);
  });

  it("refuses a chain that is not a list, and says nothing of an absent one", () => {
    expect(fallbackChainProblems("c", "codex", ctx())).toEqual(["c must be a list of fallback targets"]);
    expect(fallbackChainProblems("c", undefined, ctx())).toEqual([]);
  });
});
