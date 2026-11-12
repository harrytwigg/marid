import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * A usage-limit retry runs on the employee's host at the reset. When that host
 * is not ready then (asleep, booting, off the network) the retry is tried again
 * with backoff until it is, and the turn fails visibly only once a bounded window
 * has passed. Before this, one failed attempt ended the wait and nothing retried.
 */

const getSessionMock = vi.fn<(...args: unknown[]) => Session | undefined>();
const updateSessionForAttemptMock = vi.fn(
  (_id: string, _token: string, updates: Partial<Session>, _expected?: readonly string[]) => makeSession(updates),
);
vi.mock("../registry.js", () => ({
  getSession: (...a: unknown[]) => getSessionMock(...a),
  getMessages: vi.fn(() => []),
  updateSessionForAttempt: (...a: Parameters<typeof updateSessionForAttemptMock>) => updateSessionForAttemptMock(...a),
  getEngineSessionRef: (session: Session, engine: string) => session.engineSessions?.[engine] ?? {},
  nextEngineSessionFields: () => ({}),
}));
const limitedMock = vi.fn<(result: EngineResult) => { limited: boolean; resetsAt?: number } | undefined>(() => undefined);
vi.mock("../../shared/rateLimit.js", async (importOriginal) => {
  const real = await importOriginal<typeof import("../../shared/rateLimit.js")>();
  return { ...real, detectRateLimit: (result: EngineResult) => limitedMock(result) ?? real.detectRateLimit(result) };
});
vi.mock("../../engines/remote-stage.js", () => ({ remoteEngineAvailable: () => false }));
vi.mock("../engine-run-mcp.js", () => ({ resolveEngineRunMcp: vi.fn(() => ({})) }));
vi.mock("../../shared/usageAwareness.js", () => ({ recordClaudeRateLimit: vi.fn() }));
vi.mock("../../shared/engine-health.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../shared/engine-health.js")>()),
  readEngineHealth: () => ({}),
  recordEngineUnavailable: vi.fn(),
}));
vi.mock("../../shared/logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { makeSession } from "./helpers/session-fixture.js";
import { handleRateLimit, type RateLimitHandlerOpts } from "../rate-limit-handler.js";
import {
  HOST_RETRY_BASE_DELAY_MS, HOST_RETRY_MAX_DELAY_MS, HOST_RETRY_WINDOW_MS, HostRetryStreak,
  hostNotReadyFromThrown, hostRetryDelayMs, isHostNotReadyError,
} from "../rate-limit-host-retry.js";
import type { EngineResult, Session } from "../../shared/types.js";

const RESET_IN_MS = 10 * 60_000;
const NOT_REACHABLE = "remote host not ready: build-box is not reachable";

function opts(run: ReturnType<typeof vi.fn>, hooks: RateLimitHandlerOpts["hooks"] = {}): RateLimitHandlerOpts {
  return {
    session: makeSession(),
    attemptToken: "attempt-1",
    prompt: "carry on",
    engineConfig: { bin: "claude", model: "opus" },
    // No fallback chain: Branch B (wait for the reset) is the only way on.
    config: { engines: { claude: { bin: "claude", model: "opus" } } } as unknown as RateLimitHandlerOpts["config"],
    engines: new Map(),
    engine: { run } as unknown as RateLimitHandlerOpts["engine"],
    remoteHost: "build-box",
    remoteUser: "jinn",
    remoteCwd: "/srv/agents/repo",
    rateLimit: { resetsAt: Math.floor((Date.now() + RESET_IN_MS) / 1000) },
    originalResult: { result: "", sessionId: "claude-thread-1" } as EngineResult,
    hooks,
  };
}

const answer: EngineResult = { result: "done", sessionId: "claude-thread-1" };

/** Drive the handler under fake time until it returns. */
async function settle<T>(pending: Promise<T>, maxMs = HOST_RETRY_WINDOW_MS + 2 * 60 * 60_000): Promise<T> {
  let done = false;
  const observed = pending.finally(() => { done = true; });
  observed.catch(() => {});
  for (let elapsed = 0; !done && elapsed < maxMs; elapsed += 60_000) {
    await vi.advanceTimersByTimeAsync(60_000);
  }
  if (!done) throw new Error("handler did not settle");
  return await observed;
}

describe("handleRateLimit — a retry whose host is not ready", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers({ now: new Date("2026-03-02T23:00:00Z") });
    // The session stays `waiting` between attempts unless a case stops it.
    getSessionMock.mockImplementation(() => makeSession({ status: "waiting" }));
    limitedMock.mockReturnValue(undefined);
  });
  afterEach(() => { vi.useRealTimers(); });

  it("retries after the engine's own check throws not-ready, and resumes once the host answers", async () => {
    const run = vi.fn()
      .mockRejectedValueOnce(new Error(NOT_REACHABLE))
      .mockResolvedValueOnce(answer);
    const onRetryHostNotReady = vi.fn();
    const onRetrySuccess = vi.fn();

    const outcome = await settle(handleRateLimit(opts(run, { onRetryHostNotReady, onRetrySuccess })));

    expect(outcome).toEqual({ kind: "resumed", result: answer });
    expect(run).toHaveBeenCalledTimes(2);
    expect(onRetrySuccess).toHaveBeenCalledWith(answer);
    expect(onRetryHostNotReady).toHaveBeenCalledTimes(1);
    expect(onRetryHostNotReady.mock.calls[0]![0]).toMatchObject({ error: NOT_REACHABLE, failures: 1 });
    // Parked back in `waiting`, saying why and when it tries again.
    const parked = updateSessionForAttemptMock.mock.calls.find(([, , u]) => typeof u === "object" && String(u.lastError).startsWith(NOT_REACHABLE));
    expect(parked?.[2]).toMatchObject({ status: "waiting", lastError: expect.stringContaining("retrying at") });
    expect(parked?.[3]).toEqual(["waiting", "running"]);
  });

  it("treats a not-ready error RESULT the same as a thrown one", async () => {
    const run = vi.fn()
      .mockResolvedValueOnce({ result: "", sessionId: "", error: NOT_REACHABLE })
      .mockResolvedValueOnce(answer);

    const outcome = await settle(handleRateLimit(opts(run)));

    expect(outcome.kind).toBe("resumed");
    expect(run).toHaveBeenCalledTimes(2);
  });

  it("does not spawn while the pre-retry gate says the host is down, and spawns once it is up", async () => {
    const run = vi.fn().mockResolvedValue(answer);
    const prepareRetry = vi.fn()
      .mockResolvedValueOnce({ ok: false, error: "Remote host unavailable: build-box did not wake" })
      .mockResolvedValueOnce({ ok: false, error: "Remote host unavailable: build-box did not wake" })
      .mockResolvedValue({ ok: true });
    const onRetryHostNotReady = vi.fn();

    const outcome = await settle(handleRateLimit(opts(run, { prepareRetry, onRetryHostNotReady })));

    expect(outcome.kind).toBe("resumed");
    expect(prepareRetry).toHaveBeenCalledTimes(3);
    expect(run).toHaveBeenCalledTimes(1);
    expect(onRetryHostNotReady.mock.calls.map(([info]) => info.failures)).toEqual([1, 2]);
  });

  it("keeps retrying past the limit's own deadline while the host is down", async () => {
    // Down for three hours: far past the reset plus its 30-minute grace.
    const upAt = Date.now() + RESET_IN_MS + 3 * 60 * 60_000;
    const prepareRetry = vi.fn(async () => (Date.now() >= upAt
      ? { ok: true as const }
      : { ok: false as const, error: "Remote host unavailable: build-box is asleep" }));
    const run = vi.fn().mockResolvedValue(answer);
    const onTimeout = vi.fn();

    const outcome = await settle(handleRateLimit(opts(run, { prepareRetry, onTimeout })));

    expect(outcome.kind).toBe("resumed");
    expect(onTimeout).not.toHaveBeenCalled();
    expect(run).toHaveBeenCalledTimes(1);
  });

  it("gives up at the bound and says so, instead of dropping the turn silently", async () => {
    const run = vi.fn().mockRejectedValue(new Error(NOT_REACHABLE));
    const onRetryHostUnreachable = vi.fn();
    const onTimeout = vi.fn();
    const startedAt = Date.now();

    const outcome = await settle(handleRateLimit(opts(run, { onRetryHostUnreachable, onTimeout })));

    expect(outcome.kind).toBe("unreachable");
    const error = (outcome as { error: string }).error;
    expect(error).toContain(NOT_REACHABLE);
    expect(error).toContain("12h after the usage limit reset");
    expect(onRetryHostUnreachable).toHaveBeenCalledWith({ error });
    expect(onTimeout).not.toHaveBeenCalled();
    // Bounded: it stopped at the window, not before it and not long after.
    const elapsed = Date.now() - startedAt;
    expect(elapsed).toBeGreaterThanOrEqual(RESET_IN_MS + HOST_RETRY_WINDOW_MS);
    expect(elapsed).toBeLessThan(RESET_IN_MS + HOST_RETRY_WINDOW_MS + 5 * 60_000);
    // Backed off: far fewer attempts than one a minute.
    expect(run.mock.calls.length).toBeGreaterThan(5);
    expect(run.mock.calls.length).toBeLessThan(40);
  });

  it("gives the limit a fresh grace once the host is back, so a still-limited answer past the old deadline is retried, not timed out", async () => {
    // Reset in 10 minutes: the limit's own deadline is 40 minutes out. The host is down for an hour.
    const startedAt = Date.now();
    const hostUpAt = startedAt + 60 * 60_000;
    const prepareRetry = vi.fn(async () => (Date.now() >= hostUpAt
      ? { ok: true as const }
      : { ok: false as const, error: "Remote host unavailable: build-box is asleep" }));
    const limited: EngineResult = { result: "", sessionId: "claude-thread-1", error: "limited" };
    let newReset = 0;
    limitedMock.mockImplementation((result) => (result.error === "limited" ? { limited: true, resetsAt: Math.floor(newReset / 1000) } : undefined));
    const run = vi.fn(async () => {
      if (newReset === 0) { newReset = Date.now() + 5 * 60_000; return limited; }
      return answer;
    });
    const onTimeout = vi.fn();

    const outcome = await settle(handleRateLimit(opts(run, { prepareRetry, onTimeout })));

    expect(outcome.kind).toBe("resumed");
    expect(onTimeout).not.toHaveBeenCalled();
    expect(run).toHaveBeenCalledTimes(2);
  });

  it("still fails the turn on a thrown error that is not about the host", async () => {
    const run = vi.fn().mockRejectedValue(new Error("spawn claude ENOENT"));

    await expect(settle(handleRateLimit(opts(run)))).rejects.toThrow("spawn claude ENOENT");
    expect(run).toHaveBeenCalledTimes(1);
  });

  it("stops retrying when the session is stopped during the host wait", async () => {
    const run = vi.fn().mockRejectedValue(new Error(NOT_REACHABLE));
    const onCancelled = vi.fn();
    let stopped = false;
    getSessionMock.mockImplementation(() => makeSession({ status: stopped ? "idle" : "waiting" }));
    const onRetryHostNotReady = vi.fn(() => { stopped = true; });

    const outcome = await settle(handleRateLimit(opts(run, { onRetryHostNotReady, onCancelled })));

    expect(outcome.kind).toBe("cancelled");
    expect(run).toHaveBeenCalledTimes(1);
    expect(onCancelled).toHaveBeenCalled();
  });

  it("reports a gate that saw the session stopped as cancelled, without retrying", async () => {
    const run = vi.fn();
    const prepareRetry = vi.fn().mockResolvedValue({ ok: false, error: "stopped", cancelled: true });

    const outcome = await settle(handleRateLimit(opts(run, { prepareRetry })));

    expect(outcome.kind).toBe("cancelled");
    expect(run).not.toHaveBeenCalled();
  });
});

describe("host retry backoff", () => {
  it("doubles from a minute and caps at half an hour", () => {
    expect([1, 2, 3, 4, 5, 6, 7, 20].map(hostRetryDelayMs)).toEqual([
      HOST_RETRY_BASE_DELAY_MS, 2 * HOST_RETRY_BASE_DELAY_MS, 4 * HOST_RETRY_BASE_DELAY_MS,
      8 * HOST_RETRY_BASE_DELAY_MS, 16 * HOST_RETRY_BASE_DELAY_MS, HOST_RETRY_MAX_DELAY_MS,
      HOST_RETRY_MAX_DELAY_MS, HOST_RETRY_MAX_DELAY_MS,
    ]);
  });

  it("lands the last try on the bound, then reports the window spent; a reset starts a fresh window", () => {
    let now = 0;
    const streak = new HostRetryStreak(() => now);
    let step = streak.fail();
    while (!step.exhausted) {
      expect(step.retryAt.getTime()).toBeLessThanOrEqual(HOST_RETRY_WINDOW_MS);
      now = step.retryAt.getTime();
      step = streak.fail();
    }
    expect(now).toBe(HOST_RETRY_WINDOW_MS);
    expect(streak.active()).toBe(true);

    streak.reset();
    expect(streak.active()).toBe(false);
    const fresh = streak.fail();
    expect(fresh).toMatchObject({ exhausted: false, failures: 1, delayMs: HOST_RETRY_BASE_DELAY_MS });
  });

  it("recognises both spellings of a host that is not ready, and nothing else", () => {
    expect(isHostNotReadyError("remote host not ready: box is not reachable")).toBe(true);
    expect(isHostNotReadyError("Remote host unavailable: box did not wake")).toBe(true);
    expect(isHostNotReadyError("Claude usage limit reached")).toBe(false);
    expect(isHostNotReadyError(undefined)).toBe(false);
    expect(hostNotReadyFromThrown(new Error("remote host not ready: x"))).toBe("remote host not ready: x");
    expect(hostNotReadyFromThrown(new Error("boom"))).toBeUndefined();
  });
});
