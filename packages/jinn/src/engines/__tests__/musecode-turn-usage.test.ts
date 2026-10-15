import { describe, expect, it } from "vitest";
import { MuseTurn } from "../musecode-turn.js";
import { addTokenUsage, parseUsageChanged } from "../musecode-turn-text.js";

const SESSION = "01a13f8f-4840-7f30-92cd-aa7c6655b28c";
const TURN = "01a13f8f-48cb-7e8f-ade4-adb3e742c322";
const RATES = { input: 1, cached: 0.1, output: 5 };

function turn() {
  const t = new MuseTurn(SESSION);
  t.setTurnId(TURN);
  const feed = (method: string, params: Record<string, unknown> = {}) => t.read(method, { sessionId: SESSION, ...params });
  return { t, feed };
}

const leg = (inputTokens: number, cachedTokens: number, outputTokens: number, turnId = TURN) => ({ turnId, usage: { inputTokens, cachedTokens, outputTokens, reasoningTokens: 0 } });

describe("a turn's token usage and its cost", () => {
  it("sums the model calls' session/tokenUsage when turn/completed carries no usage, as the real host's does not", () => {
    const { t, feed } = turn();
    feed("session/tokenUsage", leg(100, 20, 5));
    feed("session/tokenUsage", leg(50, 0, 10));
    feed("turn/completed", { turnId: TURN, terminal: "completed" });
    expect(t.result({ terminationReason: null, costRates: RATES }).cost).toBeCloseTo((130 * 1 + 20 * 0.1 + 15 * 5) / 1e6, 12);
  });

  it("prefers the aggregate turn/completed states over the sum of the calls", () => {
    const { t, feed } = turn();
    feed("session/tokenUsage", leg(100, 0, 5));
    feed("turn/completed", { turnId: TURN, terminal: "completed", usage: { inputTokens: 10, cachedTokens: 0, outputTokens: 1 } });
    expect(t.result({ terminationReason: null, costRates: RATES }).cost).toBeCloseTo((10 * 1 + 1 * 5) / 1e6, 12);
  });

  it("ignores another turn's usage and another session's", () => {
    const { t, feed } = turn();
    feed("session/tokenUsage", leg(1000, 0, 1000, "some-other-turn"));
    t.read("session/tokenUsage", { sessionId: "reminder-child", ...leg(1000, 0, 1000) });
    feed("session/tokenUsage", leg(100, 0, 5));
    feed("turn/completed", { turnId: TURN, terminal: "completed" });
    expect(t.result({ terminationReason: null, costRates: RATES }).cost).toBeCloseTo((100 + 25) / 1e6, 12);
  });

  it("omits cost, never 0, with no rates or with no usage", () => {
    const { t, feed } = turn();
    feed("session/tokenUsage", leg(100, 0, 5));
    feed("turn/completed", { turnId: TURN, terminal: "completed" });
    expect(t.result({ terminationReason: null })).not.toHaveProperty("cost");
    const none = turn();
    none.feed("turn/completed", { turnId: TURN, terminal: "completed" });
    expect(none.t.result({ terminationReason: null, costRates: RATES })).not.toHaveProperty("cost");
  });
});

describe("addTokenUsage", () => {
  it("adds the counters and keeps the cache counters only when one side has them", () => {
    const a = { inputTokens: 1, cachedTokens: 2, outputTokens: 3, cacheReadTokens: 4 };
    const b = { inputTokens: 10, cachedTokens: 20, outputTokens: 30 };
    expect(addTokenUsage(a, b)).toEqual({ inputTokens: 11, cachedTokens: 22, outputTokens: 33, cacheReadTokens: 4 });
    expect(addTokenUsage(undefined, b)).toBe(b);
    expect(addTokenUsage(a, undefined)).toBe(a);
    expect(addTokenUsage(undefined, undefined)).toBeUndefined();
  });
});

describe("parseUsageChanged", () => {
  it("reads a snapshot, and nothing from params without a window, a weekly block or a stamp", () => {
    const params = { observedAtMs: 5, tier: "everyday", window: { usedPercent: 42, windowDurationMins: 300, resetsAtMs: 9 }, weekly: { usedPercent: 17, resetsAtMs: 99 } };
    expect(parseUsageChanged(params)).toEqual({ observedAtMs: 5, tier: "everyday", window: { usedPercent: 42, windowDurationMins: 300, resetsAtMs: 9 }, weekly: { usedPercent: 17, resetsAtMs: 99 } });
    expect(parseUsageChanged({ ...params, weekly: undefined })).toBeUndefined();
    expect(parseUsageChanged({ ...params, observedAtMs: undefined })).toBeUndefined();
  });
});
