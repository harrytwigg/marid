import { describe, it, expect } from "vitest";
import type { EngineResult } from "../types.js";
import { processStartFailure } from "../process-start.js";
import {
  computeNextRetryDelayMs, detectRateLimit, isDeadSessionError, nextUnstatedParkDelayMs,
  MAX_UNSTATED_PARK_ATTEMPTS, MAX_UNSTATED_PARK_DELAY_MS,
} from "../rateLimit.js";

function makeResult(overrides: Partial<EngineResult> = {}): EngineResult {
  return {
    sessionId: "test-session",
    result: "",
    ...overrides,
  };
}

describe("isDeadSessionError", () => {
  it("returns true for error with zero cost and no rate limit", () => {
    const result = makeResult({
      error: "Claude exited with code 1 (no stderr output)",
      cost: 0,
      numTurns: 0,
    });
    expect(isDeadSessionError(result)).toBe(true);
  });

  it("returns true for error with undefined cost/turns (no work done)", () => {
    const result = makeResult({
      error: "Claude exited with code 1",
    });
    expect(isDeadSessionError(result)).toBe(true);
  });

  it("returns false when rate limit status is present", () => {
    const result = makeResult({
      error: "Claude usage limit reached",
      cost: 0,
      rateLimit: { status: "rejected" },
    });
    expect(isDeadSessionError(result)).toBe(false);
  });

  it("returns false when cost > 0 (work was done)", () => {
    const result = makeResult({
      error: "Some error after work",
      cost: 0.05,
      numTurns: 3,
    });
    expect(isDeadSessionError(result)).toBe(false);
  });

  it("returns false when numTurns > 0 (work was done)", () => {
    const result = makeResult({
      error: "Some error after work",
      cost: 0,
      numTurns: 1,
    });
    expect(isDeadSessionError(result)).toBe(false);
  });

  it("returns false when there is no error", () => {
    const result = makeResult({ result: "success" });
    expect(isDeadSessionError(result)).toBe(false);
  });

  // Secondary pattern matching — requires zero cost as conjunction
  it("returns true for 'error_during_execution' with zero cost", () => {
    const result = makeResult({
      error: "error_during_execution",
      cost: 0,
      numTurns: 0,
    });
    expect(isDeadSessionError(result)).toBe(true);
  });

  it("returns false for 'error_during_execution' when cost > 0 (real work done)", () => {
    const result = makeResult({
      error: "error_during_execution",
      cost: 0.05,
      numTurns: 1,
    });
    expect(isDeadSessionError(result)).toBe(false);
  });

  it("returns true for 'session not found' in error text", () => {
    const result = makeResult({
      error: "Session not found or expired",
      cost: 0,
    });
    expect(isDeadSessionError(result)).toBe(true);
  });

  it("returns true for 'invalid session' in error text", () => {
    const result = makeResult({
      error: "Invalid session ID provided",
      cost: 0,
    });
    expect(isDeadSessionError(result)).toBe(true);
  });

  it("returns true for 'session expired' in error text", () => {
    const result = makeResult({
      error: "The session has expired",
      cost: 0,
    });
    expect(isDeadSessionError(result)).toBe(true);
  });

  describe("a process that never started its session", () => {
    const failure = (engine: string, output: string) =>
      makeResult({ error: processStartFailure(engine, { exitCode: 1, signal: 0 }, output) });

    it("is dead when Claude Code says the conversation is gone", () => {
      expect(isDeadSessionError(failure("claude", "No conversation found with session ID: abc"))).toBe(true);
    });

    it("is dead when codex says the rollout is gone", () => {
      expect(isDeadSessionError(failure("codex", "Error: thread/resume failed: no rollout found for thread id abc"))).toBe(true);
    });

    it("is dead when grok says the session is gone", () => {
      expect(isDeadSessionError(failure("grok", "Error: unknown session id abc"))).toBe(true);
    });

    it("keeps the resume id for any other reason the process did not start", () => {
      expect(isDeadSessionError(failure("codex", "execvp(3) failed.: Argument list too long"))).toBe(false);
      expect(isDeadSessionError(failure("grok", "error: unexpected argument '--bogus' found"))).toBe(false);
    });

    it("keeps the resume id when the wording is generic enough to describe other failures", () => {
      expect(isDeadSessionError(failure("codex", "Error: code -32600 invalid request"))).toBe(false);
      expect(isDeadSessionError(failure("codex", "Error: thread/resume failed: connection reset"))).toBe(false);
      expect(isDeadSessionError(failure("grok", "mcp: session not found"))).toBe(false);
    });
  });

  it("does not false-positive on rate limit errors with no cost", () => {
    const result = makeResult({
      error: "rate limit exceeded",
      cost: 0,
      rateLimit: { status: "rejected", resetsAt: 1234567890 },
    });
    expect(isDeadSessionError(result)).toBe(false);
  });

  it("does not interfere with detectRateLimit", () => {
    const rateLimited = makeResult({
      error: "Claude usage limit reached",
      rateLimit: { status: "rejected", resetsAt: 9999999999 },
    });
    expect(detectRateLimit(rateLimited).limited).toBe(true);
    expect(isDeadSessionError(rateLimited)).toBe(false);
  });
});

/**
 * A park against a limit that named no reset used to sleep a flat minute inside
 * a six-hour deadline: ~360 pokes at an engine already known to be out. These
 * cover the bound rather than the wiring — the sequence itself is the rule.
 */
describe("the unstated-reset park", () => {
  /** Every delay the park would sleep, from its first, until it gives up. */
  function parkDelays(): number[] {
    const delays = [computeNextRetryDelayMs(undefined).delayMs];
    for (let attempt = 1; attempt < MAX_UNSTATED_PARK_ATTEMPTS; attempt++) {
      delays.push(nextUnstatedParkDelayMs(delays[delays.length - 1]!));
    }
    return delays;
  }

  it("gives up in far fewer attempts than the flat-minute park's ~360", () => {
    expect(parkDelays()).toHaveLength(MAX_UNSTATED_PARK_ATTEMPTS);
    expect(MAX_UNSTATED_PARK_ATTEMPTS).toBeLessThan(30);
  });

  it("never shortens a wait and never exceeds the cap", () => {
    const delays = parkDelays();
    for (const [index, delay] of delays.entries()) {
      expect(delay).toBeLessThanOrEqual(MAX_UNSTATED_PARK_DELAY_MS);
      if (index > 0) expect(delay).toBeGreaterThanOrEqual(delays[index - 1]!);
    }
    expect(delays[0]).toBe(60_000);
    expect(delays.at(-1)).toBe(MAX_UNSTATED_PARK_DELAY_MS);
  });

  it("settles at the cap rather than growing past it", () => {
    expect(nextUnstatedParkDelayMs(MAX_UNSTATED_PARK_DELAY_MS)).toBe(MAX_UNSTATED_PARK_DELAY_MS);
    expect(nextUnstatedParkDelayMs(5 * 60 * 60_000)).toBe(MAX_UNSTATED_PARK_DELAY_MS);
  });

  it("spends its whole run inside the six-hour deadline it parks under", () => {
    const total = parkDelays().reduce((sum, delay) => sum + delay, 0);
    expect(total).toBeLessThan(6 * 60 * 60_000);
  });

  it("leaves a stated reset on the path it already used — slept to, not guessed at", () => {
    const resetsAt = Math.floor(Date.now() / 1000) + 900;
    const { delayMs, resumeAt } = computeNextRetryDelayMs(resetsAt);
    expect(resumeAt).toEqual(new Date(resetsAt * 1000));
    expect(delayMs).toBeGreaterThan(900_000 - 5_000);
    expect(delayMs).toBeLessThanOrEqual(910_000);
  });
});
