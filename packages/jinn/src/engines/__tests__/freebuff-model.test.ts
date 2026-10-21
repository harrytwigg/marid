import { describe, expect, it } from "vitest";
import { isForeignModelId, pickerModelFor } from "../freebuff-model.js";

describe("isForeignModelId", () => {
  it.each(["sonnet", "opus", "haiku", "fable", "sonnet[1m]", "claude-sonnet-5", "claude-opus-4.6", "gpt-5.5", "gpt-5.3-codex", "o3-mini"])("%s belongs to another engine", (id) => {
    expect(isForeignModelId(id)).toBe(true);
  });

  it.each(["MiMo v2.6 Flash Slow", "GPT-6 Luna", "Claude Haiku 5.5 · 100k context", "Claude Haiku", "DeepSeek V4.1 Flash", "Muse Spark 1.3", "GLM 5.3 Flash"])("%s is a picker label", (label) => {
    expect(isForeignModelId(label)).toBe(false);
  });
});

describe("pickerModelFor", () => {
  it("passes a picker label through, whatever the engine config says", () => {
    expect(pickerModelFor("MiMo v2.6 Flash Slow", "GLM 5.3 Flash")).toBe("MiMo v2.6 Flash Slow");
  });

  it("falls back to the engine's configured model for the employee-file default `sonnet`", () => {
    expect(pickerModelFor("sonnet", "MiMo v2.6 Flash Slow")).toBe("MiMo v2.6 Flash Slow");
    expect(pickerModelFor("claude-opus-4.6", "MiMo v2.6 Flash Slow")).toBe("MiMo v2.6 Flash Slow");
  });

  it("falls back to the CLI's own choice when nothing is configured", () => {
    expect(pickerModelFor("sonnet", undefined)).toBeUndefined();
    expect(pickerModelFor("gpt-5.5", "  ")).toBeUndefined();
  });

  it("uses the configured model when the session names none", () => {
    expect(pickerModelFor(undefined, "MiMo v2.6 Flash Slow")).toBe("MiMo v2.6 Flash Slow");
    expect(pickerModelFor("  ", undefined)).toBeUndefined();
  });
});
