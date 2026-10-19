import { describe, expect, it } from "vitest";
import { buildHop, chainExhaustedReason, hopLogLine, hopNoticeText, isInvalidModelFailure, limitReason } from "../fallback-hop.js";

describe("limitReason", () => {
  it.each([
    ["429 Too Many Requests", "rate-limit"],
    ["You've hit your usage limit. Resets at 4pm", "quota"],
    ["rate limit exceeded", "rate-limit"],
    ["usage limit reached (rate limit)", "rate-limit"],
    ["overloaded; opencode would not retry it for 40 min", "retry-exhausted"],
    [undefined, "rate-limit"],
  ] as const)("reads %j as %s", (error, reason) => {
    expect(limitReason({ error })).toBe(reason);
  });
});

describe("isInvalidModelFailure", () => {
  it.each([
    ["There's an issue with the selected model (x). invalid model", true],
    ["Unknown model: z", true],
    ["model_not_found", true],
    ["Error: the model glm-9 is not available", true],
    ["429 rate limit", false],
    ["authentication_failed", false],
    ["connect ECONNRESET", false],
    [undefined, false],
  ] as const)("%j -> %s", (error, expected) => {
    expect(isInvalidModelFailure(error)).toBe(expected);
  });
});

describe("hops", () => {
  const at = new Date("2026-10-19T10:00:00.000Z");
  const from = { key: "claude|work|opus", label: "claude · work · opus" };
  const to = { key: "claude|spare|sonnet", label: "claude · spare · sonnet" };

  it("record both ends, the reason, the failing target's reset and what was passed over", () => {
    expect(buildHop({ at, from, to, reason: "rate-limit", resetsAt: 1_792_000_000, skipped: [{ key: "x", reason: "scoped" }] })).toEqual({
      at: at.toISOString(), from: from.key, to: to.key, fromLabel: from.label, toLabel: to.label, reason: "rate-limit",
      resetsAt: new Date(1_792_000_000_000).toISOString(), skipped: [{ key: "x", reason: "scoped" }],
    });
  });

  it("leave out what they have none of, and record the chain running out as a hop to nothing", () => {
    expect(buildHop({ at, from, to: null, reason: "quota", skipped: [] })).toEqual({
      at: at.toISOString(), from: from.key, to: null, fromLabel: from.label, toLabel: null, reason: "quota",
    });
  });

  it("log one line: who, where to, why, and what was skipped", () => {
    const hop = buildHop({ at, from, to, reason: "rate-limit", skipped: [{ key: "opencode||x", reason: "not-installed" }] });
    expect(hopLogLine("s1", hop)).toBe("Session s1: fallback hop claude · work · opus -> claude · spare · sonnet (rate-limit); skipped opencode||x (not-installed)");
    expect(hopLogLine("s1", buildHop({ at, from, to: null, reason: "quota", skipped: [] }))).toBe("Session s1: fallback hop claude · work · opus -> (chain exhausted) (quota)");
  });

  it("read as a notice naming both targets in full", () => {
    const hop = buildHop({ at, from, to, reason: "rate-limit", resetsAt: 1_792_000_000, skipped: [] });
    expect(hopNoticeText(hop)).toMatch(/^⚠️ claude · work · opus hit its usage limit \(resets .+\)\. Moving to claude · spare · sonnet\.$/);
    expect(hopNoticeText(buildHop({ at, from, to, reason: "invalid-model", skipped: [] }))).toBe("⚠️ claude · work · opus does not serve this model. Moving to claude · spare · sonnet.");
    expect(hopNoticeText(buildHop({ at, from, to, reason: "auth", resetsAt: 1_792_000_000, skipped: [] }))).toBe("⚠️ claude · work · opus is signed out. Moving to claude · spare · sonnet.");
    expect(hopNoticeText(buildHop({ at, from, to, reason: "quota", skipped: [] }))).toBe("⚠️ claude · work · opus hit its usage limit. Moving to claude · spare · sonnet.");
  });

  it("name the targets an exhausted run tried", () => {
    expect(chainExhaustedReason(["a", "b"], "own")).toBe("every target in its fallback chain was tried (a, b); waiting for own to reset");
  });
});
