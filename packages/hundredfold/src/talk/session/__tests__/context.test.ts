import { describe, expect, it } from "vitest";
import {
  TALK_HANDOFF_TURN_TOKENS,
  contextTokens,
  estimateTokens,
  handoffSuggested,
  truncateTurns,
} from "../context.js";
import type { TalkTurnRecord } from "../types.js";

function turn(tokens: number, label = "t"): TalkTurnRecord {
  return { at: 0, text: `${label}:${tokens}`, estimatedTokens: tokens };
}

describe("estimateTokens", () => {
  it("counts four characters to the token, rounding up", () => {
    expect(estimateTokens("")).toBe(0);
    expect(estimateTokens("abcd")).toBe(1);
    expect(estimateTokens("abcde")).toBe(2);
  });
});

describe("truncateTurns", () => {
  it("keeps everything while the estimate fits the budget", () => {
    const turns = [turn(100, "a"), turn(100, "b")];
    const result = truncateTurns(turns, 1000);
    expect(result.dropped).toBe(0);
    expect(result.turns).toHaveLength(2);
  });

  it("drops oldest first and reports how many it dropped", () => {
    const turns = [turn(400, "a"), turn(400, "b"), turn(400, "c")];
    const result = truncateTurns(turns, 900);
    expect(result.dropped).toBe(1);
    expect(result.turns.map((t) => t.text)).toEqual(["b:400", "c:400"]);
  });

  it("drops as many as it takes to get under budget", () => {
    const turns = [turn(400, "a"), turn(400, "b"), turn(400, "c"), turn(400, "d")];
    const result = truncateTurns(turns, 500);
    expect(result.dropped).toBe(3);
    expect(result.turns.map((t) => t.text)).toEqual(["d:400"]);
  });

  it("retains the newest turn even when it alone blows the budget", () => {
    const turns = [turn(100, "a"), turn(9000, "huge")];
    const result = truncateTurns(turns, 500);
    expect(result.turns).toHaveLength(1);
    expect(result.turns[0]!.text).toBe("huge:9000");
    expect(result.dropped).toBe(1);
  });

  it("leaves an empty history alone", () => {
    expect(truncateTurns([], 500)).toEqual({ turns: [], dropped: 0 });
  });
});

describe("contextTokens", () => {
  it("sums the per-turn estimates", () => {
    expect(contextTokens([turn(10), turn(32)])).toBe(42);
    expect(contextTokens([])).toBe(0);
  });
});

describe("handoffSuggested", () => {
  it("fires above the threshold and stays quiet at or below it", () => {
    expect(handoffSuggested(turn(TALK_HANDOFF_TURN_TOKENS + 1))).toBe(true);
    expect(handoffSuggested(turn(TALK_HANDOFF_TURN_TOKENS))).toBe(false);
    expect(handoffSuggested(turn(10))).toBe(false);
  });
});
