import { describe, it, expect } from "vitest";
import { classifyEngineFailureText, type EngineFailureClass } from "../engine-failure.js";

/**
 * The goldens the three former regex sets were pinned to. Every string here is
 * asserted somewhere else in the suite through `isRateLimitMessage`,
 * `isTransportFailure` or the respawn auth guard; this table is what makes those
 * verdicts one decision instead of three that happen to agree.
 */
const GOLDENS: readonly [string, EngineFailureClass[]][] = [
  // workflows/__tests__/retry-boundary.test.ts — transport TRUE
  ["Interactive turn failed: server_error", ["provider-outage"]],
  ["api_error", ["provider-outage"]],
  ["overloaded_error: please retry", ["rate-limit", "provider-outage"]],
  ["HTTP 503 from upstream", ["provider-outage"]],
  ["status: 502", ["provider-outage"]],
  ["Bad Gateway", ["provider-outage"]],
  ["connect ECONNRESET 1.2.3.4:443", ["network"]],
  ["socket hang up", ["network"]],
  ["fetch failed", ["network"]],

  // workflows/__tests__/retry-boundary.test.ts — transport FALSE
  ["Interactive turn failed: rate_limit", ["rate-limit"]],
  ["Interactive turn failed: billing_error", ["terminal"]],
  ["Interactive turn failed: invalid_request", ["terminal"]],
  ["Interactive turn failed: permission_error", ["terminal"]],
  ["the tests did not pass", ["terminal"]],
  ["", ["terminal"]],
  ["503 files changed", ["terminal"]],

  // workflows/__tests__/todo-runs.test.ts
  ["429 rate limit exceeded", ["rate-limit"]],
  ["the provider is overloaded", ["rate-limit", "provider-outage"]],

  // work-items/__tests__/runs.test.ts
  ["429 Too Many Requests: usage limit exceeded, retry after the window", ["rate-limit", "quota"]],
  ["429 Too Many Requests: usage limit exceeded", ["rate-limit", "quota"]],
  ["the build step exited with code 1", ["terminal"]],

  // work-items/__tests__/respawn-guards.test.ts
  ["429 Too Many Requests from the provider", ["rate-limit"]],
  [
    "Usage limit exceeded (429); the request was also rejected as 401 Unauthorized: invalid api key",
    ["rate-limit", "quota", "auth-terminal"],
  ],
  ["401 Unauthorized: the API key is invalid", ["auth-terminal"]],

  // shared/__tests__/rateLimit.test.ts
  ["Claude usage limit reached", ["quota"]],
  ["rate limit exceeded", ["rate-limit"]],
  ["Claude exited with code 1 (no stderr output)", ["terminal"]],
  ["Session not found or expired", ["terminal"]],
  ["The session has expired", ["terminal"]],
  ["Invalid session ID provided", ["terminal"]],
  ["error_during_execution", ["terminal"]],
  ["Some error after work", ["terminal"]],

  // workflows/__tests__/retry-boundary.test.ts — a model id our own config or our own
  // discovery got wrong, refused before the engine ran anything.
  ["invalid model selection", ["invalid-model"]],
  ['unknown model "gpt-5.6-sol" for engine "codex" (known: opus)', ["invalid-model"]],
  ["model not found", ["invalid-model"]],
  ["model_not_found", ["invalid-model"]],
];

describe("classifyEngineFailureText", () => {
  it.each(GOLDENS)("classifies %j", (text, expected) => {
    expect([...classifyEngineFailureText(text).classes].sort()).toEqual([...expected].sort());
  });

  // A 429 only counts as a status code when it stands alone. An id, a timestamp or a
  // byte count that merely contains the digits is not a rate limit.
  it.each([
    'unreadable error {"requestID":"req_01J429ABC"}',
    "session ses_ab429cd failed",
    "failed at 1792322429001",
  ])("does not read the digits 429 inside an id or number as a rate limit: %j", (text) => {
    expect([...classifyEngineFailureText(text).classes]).toEqual(["terminal"]);
  });

  it.each(["(HTTP 429)", "HTTP 429", "status 429", "status: 429 Too Many Requests"])(
    "reads a standalone 429 status as a rate limit: %j",
    (text) => {
      expect(classifyEngineFailureText(text).classes.has("rate-limit")).toBe(true);
    },
  );

  it("carries both readings of an overloaded provider", () => {
    // The collision the taxonomy exists for: the rate-limit detector and the
    // workflow retry boundary both claim this string, and both are right.
    const { classes } = classifyEngineFailureText("the provider is overloaded");
    expect(classes.has("rate-limit")).toBe(true);
    expect(classes.has("provider-outage")).toBe(true);
  });

  it("classifies an unrecognised failure as exactly terminal", () => {
    expect([...classifyEngineFailureText("the deploy script wrote no manifest").classes])
      .toEqual(["terminal"]);
  });

  it("treats a missing message as terminal rather than throwing", () => {
    expect([...classifyEngineFailureText(null).classes]).toEqual(["terminal"]);
    expect([...classifyEngineFailureText(undefined).classes]).toEqual(["terminal"]);
  });
});

describe("classifyEngineFailureText — stated reset time", () => {
  it("reads a reset stated as prose into Unix seconds", () => {
    const { resetsAt } = classifyEngineFailureText(
      "You've hit your usage limit. Try again at 2026-08-19T18:30:00.000Z.",
    );
    expect(resetsAt).toBe(Math.floor(Date.parse("2026-08-19T18:30:00.000Z") / 1000));
  });

  it("reads the `resets at` phrasing too", () => {
    const { resetsAt } = classifyEngineFailureText("Rate limited; resets at 2026-08-19T18:30:00Z");
    expect(resetsAt).toBe(Math.floor(Date.parse("2026-08-19T18:30:00Z") / 1000));
  });

  it("states no reset when the engine named none", () => {
    expect(classifyEngineFailureText("429 rate limit exceeded").resetsAt).toBeUndefined();
  });

  it("states no reset when the stated time is not a date", () => {
    expect(classifyEngineFailureText("rate limit hit — try again at some point").resetsAt)
      .toBeUndefined();
  });
});
