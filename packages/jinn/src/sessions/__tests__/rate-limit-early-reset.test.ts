import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * A usage limit can lift before the reset it named (an early or offered reset),
 * or its reset can move. The wait used to sleep to the stated time regardless.
 * It now looks at the account's newest usage reading about once a minute and
 * retries early when a reading taken after the limit says the limit is gone or
 * reopens sooner.
 */

const readingMock = vi.fn<(account: string) => UsageSample | undefined>(() => undefined);
vi.mock("../../shared/fallback-chain-limits.js", () => ({
  latestAccountReading: (account: string) => readingMock(account),
}));

const limitedMock = vi.fn<(result: EngineResult) => { limited: boolean; resetsAt?: number } | undefined>(() => undefined);
vi.mock("../../shared/rateLimit.js", async (importOriginal) => {
  const real = await importOriginal<typeof import("../../shared/rateLimit.js")>();
  return { ...real, detectRateLimit: (result: EngineResult) => limitedMock(result) ?? real.detectRateLimit(result) };
});

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
import { earlyResetFrom, earlyResetWatch } from "../rate-limit-early-reset.js";
import type { UsageSample } from "../../shared/claude-usage-history.js";
import type { EngineResult, Session } from "../../shared/types.js";

const MIN = 60_000;
const STATED_RESET_IN_MS = 4 * 60 * MIN;
const answer: EngineResult = { result: "done", sessionId: "claude-thread-1" };
const secs = (ms: number) => Math.floor(ms / 1000);

function opts(run: ReturnType<typeof vi.fn>, engine = "claude"): RateLimitHandlerOpts {
  return {
    session: makeSession({ engine }),
    attemptToken: "attempt-1",
    prompt: "carry on",
    engineConfig: { bin: engine, model: "opus" },
    config: { engines: { [engine]: { bin: engine, model: "opus" } } } as unknown as RateLimitHandlerOpts["config"],
    engines: new Map(),
    engine: { run } as unknown as RateLimitHandlerOpts["engine"],
    rateLimit: { resetsAt: secs(Date.now() + STATED_RESET_IN_MS) },
    originalResult: { result: "", sessionId: "claude-thread-1" } as EngineResult,
    hooks: {},
  };
}

/** Run the handler under fake time; `at` maps minutes from the start to a reading to publish then. */
async function drive<T>(pending: Promise<T>, at: Record<number, () => void> = {}): Promise<{ value: T; minutes: number }> {
  const startedAt = Date.now();
  let done = false;
  const observed = pending.finally(() => { done = true; });
  observed.catch(() => {});
  for (let minute = 0; !done && minute < 6 * 60; minute++) {
    at[minute]?.();
    await vi.advanceTimersByTimeAsync(MIN);
  }
  if (!done) throw new Error("handler did not settle");
  return { value: await observed, minutes: Math.round((Date.now() - startedAt) / MIN) };
}

const reading = (usedPercent: number, resetsAtMs: number): UsageSample => ({
  at: Date.now(),
  windows: [{ name: "5h", usedPercent, resetsAt: secs(resetsAtMs) }],
});

describe("handleRateLimit — a limit that lifts before its stated reset", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers({ now: new Date("2026-03-02T19:30:00Z") });
    getSessionMock.mockImplementation(() => makeSession({ status: "waiting" }));
    readingMock.mockReturnValue(undefined);
    limitedMock.mockReturnValue(undefined);
  });
  afterEach(() => { vi.useRealTimers(); });

  it("retries within about a minute of a reading that shows the limit lifted, not at the stated reset", async () => {
    const run = vi.fn().mockResolvedValue(answer);
    const resetAt = Date.now() + STATED_RESET_IN_MS;

    const { value, minutes } = await drive(handleRateLimit(opts(run)), {
      30: () => readingMock.mockReturnValue(reading(3, resetAt + 5 * 60 * MIN)),
    });

    expect(value.kind).toBe("resumed");
    expect(run).toHaveBeenCalledTimes(1);
    expect(minutes).toBeGreaterThanOrEqual(30);
    expect(minutes).toBeLessThanOrEqual(33);
  });

  it("asks the limited session's own account", async () => {
    const run = vi.fn().mockResolvedValue(answer);
    await drive(handleRateLimit(opts(run)), { 5: () => readingMock.mockReturnValue(reading(0, Date.now() + MIN)) });
    expect(readingMock).toHaveBeenCalledWith("claude");
  });

  it("ignores a reading taken before the limit hit, however clear it looks", async () => {
    const run = vi.fn().mockResolvedValue(answer);
    const before: UsageSample = { at: Date.now() - MIN, windows: [{ name: "5h", usedPercent: 10, resetsAt: secs(Date.now() + MIN) }] };
    readingMock.mockReturnValue(before);

    const { minutes } = await drive(handleRateLimit(opts(run)));

    expect(minutes).toBeGreaterThanOrEqual(STATED_RESET_IN_MS / MIN);
  });

  it("moves the retry to a reset the readings bring forward, and says so on the session", async () => {
    const run = vi.fn().mockResolvedValue(answer);
    let sooner = 0;

    const { minutes } = await drive(handleRateLimit(opts(run)), {
      20: () => { sooner = Date.now() + 40 * MIN; readingMock.mockReturnValue(reading(100, sooner)); },
    });

    expect(minutes).toBeGreaterThanOrEqual(60);
    expect(minutes).toBeLessThanOrEqual(62);
    expect(updateSessionForAttemptMock).toHaveBeenCalledWith(
      "sess-1", "attempt-1", { lastError: `Claude usage limit — resumes ${new Date(sooner).toISOString()}` }, ["waiting"],
    );
  });

  it("probes at most once per reading when a reading says lifted but the engine still answers limited", async () => {
    const statedReset = Date.now() + STATED_RESET_IN_MS;
    const run = vi.fn().mockResolvedValue({ result: "", sessionId: "claude-thread-1", error: "limited" } as EngineResult);
    limitedMock.mockImplementation((result) => (result.error === "limited" ? { limited: true, resetsAt: secs(statedReset) } : undefined));
    run.mockImplementation(async () => (Date.now() >= statedReset ? answer : { result: "", sessionId: "claude-thread-1", error: "limited" }));

    // One misleading reading early on, never refreshed.
    const { value } = await drive(handleRateLimit(opts(run)), {
      10: () => readingMock.mockReturnValue(reading(50, statedReset + 60 * MIN)),
    });

    expect(value.kind).toBe("resumed");
    // The early probe, then the retry at the stated reset: not one a minute.
    expect(run).toHaveBeenCalledTimes(2);
  });

  it("leaves engines without usage readings to sleep to the stated reset", async () => {
    const run = vi.fn().mockResolvedValue(answer);
    readingMock.mockReturnValue(reading(0, Date.now() + MIN));

    const { minutes } = await drive(handleRateLimit(opts(run, "codex")));

    expect(readingMock).not.toHaveBeenCalled();
    expect(minutes).toBeGreaterThanOrEqual(STATED_RESET_IN_MS / MIN);
  });
});

describe("earlyResetFrom", () => {
  const now = 1_000_000_000_000;
  const sample = (at: number, windows: UsageSample["windows"]): UsageSample => ({ at, windows });

  it("reads a later sample with nothing spent as lifted", () => {
    expect(earlyResetFrom(sample(now, [{ name: "5h", usedPercent: 99, resetsAt: secs(now + MIN) }]), now - 1, now + 60 * MIN, now))
      .toEqual({ kind: "lifted", readAt: new Date(now) });
  });

  it("treats a spent window whose reset already passed as reopened", () => {
    expect(earlyResetFrom(sample(now, [{ name: "5h", usedPercent: 100, resetsAt: secs(now - MIN) }]), now - 1, now + 60 * MIN, now)?.kind)
      .toBe("lifted");
  });

  it("takes the latest of several spent windows, and only when it is meaningfully sooner", () => {
    const windows = [
      { name: "5h", usedPercent: 100, resetsAt: secs(now + 10 * MIN) },
      { name: "7d", usedPercent: 100, resetsAt: secs(now + 30 * MIN) },
    ];
    expect(earlyResetFrom(sample(now, windows), now - 1, now + 60 * MIN, now))
      .toEqual({ kind: "moved", readAt: new Date(now), reopensAt: new Date(secs(now + 30 * MIN) * 1000) });
    expect(earlyResetFrom(sample(now, windows), now - 1, now + 30 * MIN + 30_000, now)).toBeUndefined();
    expect(earlyResetFrom(sample(now, windows), now - 1, now + 10 * MIN, now)).toBeUndefined();
  });

  it("says nothing about a sample at or before the limit", () => {
    expect(earlyResetFrom(sample(now, []), now, now + MIN, now)).toBeUndefined();
    expect(earlyResetFrom(undefined, now, now + MIN, now)).toBeUndefined();
  });
});

describe("earlyResetWatch", () => {
  it("reports each reading once, and none from before the latest limited answer", () => {
    let now = 100 * MIN;
    let latest: UsageSample | undefined;
    const watch = earlyResetWatch("claude", "claude", () => now, () => latest)!;

    latest = { at: now + MIN, windows: [] };
    now += 2 * MIN;
    expect(watch.wakeAt(now + 60 * MIN)).toMatchObject({ atMs: now, reset: { kind: "lifted" } });
    expect(watch.wakeAt(now + 60 * MIN)).toBeUndefined();

    watch.limitedAgain();
    latest = { at: now - 1, windows: [] };
    expect(watch.wakeAt(now + 60 * MIN)).toBeUndefined();
    latest = { at: now + MIN, windows: [] };
    expect(watch.wakeAt(now + 60 * MIN)?.reset.kind).toBe("lifted");
  });

  it("is off for engines the gateway reads no usage for", () => {
    expect(earlyResetWatch("codex", "codex")).toBeUndefined();
  });
});
