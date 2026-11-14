import { describe, expect, it } from "vitest";
import { parseAntigravityModels } from "../antigravity-models.js";

describe("parseAntigravityModels", () => {
  it("parses one model per non-empty `agy models` line without effort support", () => {
    const parsed = parseAntigravityModels(`
Gemini 3.5 Flash (Medium)
Gemini 3.5 Flash (High)
Claude Sonnet 4.6 (Thinking)
`);

    expect(parsed.defaultModel).toBe("Gemini 3.5 Flash (Medium)");
    expect(parsed.models).toEqual([
      { id: "Gemini 3.5 Flash (Medium)", label: "Gemini 3.5 Flash Medium", supportsEffort: false, effortLevels: [] },
      { id: "Gemini 3.5 Flash (High)", label: "Gemini 3.5 Flash High", supportsEffort: false, effortLevels: [] },
      { id: "Claude Sonnet 4.6 (Thinking)", label: "Claude Sonnet 4.6 Thinking", supportsEffort: false, effortLevels: [] },
    ]);
  });

  // A newer `agy models` prints `id<TAB>label`. Before the split, the whole line
  // became the id, and that composite reached `--model` as an unspellable string.
  it("takes the id from the first tab-separated field and the label from the second", () => {
    const parsed = parseAntigravityModels("gemini-3.7-flash-high\tGemini 3.7 Flash (High)\n");

    expect(parsed.defaultModel).toBe("gemini-3.7-flash-high");
    expect(parsed.models).toEqual([
      { id: "gemini-3.7-flash-high", label: "Gemini 3.7 Flash (High)", supportsEffort: false, effortLevels: [] },
    ]);
  });

  it("drops a line whose id still carries a control character rather than shipping it", () => {
    const parsed = parseAntigravityModels("gemini-3.7-flash-high\tGemini 3.7 Flash (High)\n\u0007bell-id\tBell\n");

    expect(parsed.models.map((model) => model.id)).toEqual(["gemini-3.7-flash-high"]);
  });
});
