import { describe, expect, it } from "vitest";
import { EXTENDED_CONTEXT_WINDOW, resolveContextWindow } from "../context-window.js";
import type { ModelRegistry } from "../types.js";

const model = (id: string, label: string, contextWindow?: number) => ({
  id, label, supportsEffort: false, effortLevels: [], ...(contextWindow !== undefined ? { contextWindow } : {}),
});

const registry: ModelRegistry = {
  claude: {
    name: "claude",
    available: true,
    defaultModel: "opus",
    effortMechanism: "claude-flag",
    models: [
      model("opus", "Opus (Latest)", 200_000),
      model("sonnet", "Sonnet (Latest)", 200_000),
      model("fable", "Fable (Latest)"),
      model("claude-opus-4-1", "Opus 4.1", 200_000),
      model("claude-haiku-9", "Haiku 9", 0),
    ],
  },
  opencode: {
    name: "opencode",
    available: true,
    defaultModel: "opencode/big-pickle",
    effortMechanism: "none",
    models: [model("opencode/big-pickle", "big-pickle", 200_000), model("opencode/bare", "bare")],
  },
  codex: { name: "codex", available: true, defaultModel: "", effortMechanism: "codex-config", models: [] },
};

describe("resolveContextWindow", () => {
  it("reads an alias's window and label from the registry", () => {
    expect(resolveContextWindow("claude", "opus", registry)).toEqual({ model: "opus", modelLabel: "Opus (Latest)", contextWindow: 200_000 });
    expect(resolveContextWindow("claude", "sonnet", registry).contextWindow).toBe(200_000);
  });

  it("reads a full model id", () => {
    expect(resolveContextWindow("claude", "claude-opus-4-1", registry)).toEqual({ model: "claude-opus-4-1", modelLabel: "Opus 4.1", contextWindow: 200_000 });
  });

  it("uses the engine's default for a null, empty or blank model", () => {
    for (const none of [null, undefined, "", "  "]) {
      expect(resolveContextWindow("claude", none, registry)).toEqual({ model: "opus", modelLabel: "Opus (Latest)", contextWindow: 200_000 });
    }
    expect(resolveContextWindow("opencode", null, registry).model).toBe("opencode/big-pickle");
  });

  it("reads the [1m] variant of an alias or a full id as 1,000,000, labelled from its base model", () => {
    expect(resolveContextWindow("claude", "opus[1m]", registry)).toEqual({ model: "opus[1m]", modelLabel: "Opus (Latest) (1M)", contextWindow: EXTENDED_CONTEXT_WINDOW });
    expect(resolveContextWindow("claude", "claude-opus-4-1[1m]", registry).contextWindow).toBe(1_000_000);
    expect(resolveContextWindow("claude", "OPUS[1M]", registry).contextWindow).toBe(1_000_000);
  });

  it("gives a [1m] variant its window even when the base model is unknown, with no label", () => {
    expect(resolveContextWindow("claude", "claude-future-7[1m]", registry)).toEqual({ model: "claude-future-7[1m]", modelLabel: null, contextWindow: 1_000_000 });
  });

  it("leaves the [1m] suffix alone on engines that do not use it", () => {
    expect(resolveContextWindow("opencode", "opencode/big-pickle[1m]", registry)).toEqual({ model: "opencode/big-pickle[1m]", modelLabel: null, contextWindow: null });
  });

  it("is null, never a guess, for a model the registry does not know", () => {
    expect(resolveContextWindow("claude", "claude-unlisted-3", registry)).toEqual({ model: "claude-unlisted-3", modelLabel: null, contextWindow: null });
    expect(resolveContextWindow("claude", "opus-latest", registry).contextWindow).toBeNull();
  });

  it("is null for a known model that states no window, or a non-positive one", () => {
    expect(resolveContextWindow("claude", "fable", registry)).toEqual({ model: "fable", modelLabel: "Fable (Latest)", contextWindow: null });
    expect(resolveContextWindow("claude", "claude-haiku-9", registry).contextWindow).toBeNull();
    expect(resolveContextWindow("opencode", "opencode/bare", registry).contextWindow).toBeNull();
  });

  it("is all null for an engine with no entry or no default model", () => {
    expect(resolveContextWindow("nonesuch", null, registry)).toEqual({ model: null, modelLabel: null, contextWindow: null });
    expect(resolveContextWindow("codex", null, registry)).toEqual({ model: null, modelLabel: null, contextWindow: null });
    // A model named on an engine the registry lacks is still reported, without a window.
    expect(resolveContextWindow("nonesuch", "some-model", registry)).toEqual({ model: "some-model", modelLabel: null, contextWindow: null });
  });
});
