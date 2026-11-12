import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * A wait on a stand-in's usage limit, with a hand-back pending, ends when the
 * session's own target is cleared: on entry, within a minute while it sleeps, and
 * after each wake. Before this it slept to the stand-in's reset or to the
 * override's window, whichever came first, although its own target could serve.
 */

const tmp = vi.hoisted(() => `${process.env.TMPDIR ?? "/tmp"}/jinn-own-target-cleared-${process.pid}`);
vi.mock("../../shared/paths.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../shared/paths.js")>()),
  JINN_HOME: tmp,
}));

const readingMock = vi.fn<(account: string) => UsageSample | undefined>(() => undefined);
vi.mock("../../shared/fallback-chain-limits.js", () => ({
  latestAccountReading: (account: string) => readingMock(account),
}));

const limitedMock = vi.fn<(result: EngineResult) => { limited: boolean; resetsAt?: number } | undefined>(() => undefined);
vi.mock("../../shared/rateLimit.js", async (importOriginal) => {
  const real = await importOriginal<typeof import("../../shared/rateLimit.js")>();
  return { ...real, detectRateLimit: (result: EngineResult) => limitedMock(result) ?? real.detectRateLimit(result) };
});

// The chain is not under test: it ran out, which is what leaves the session waiting on its stand-in.
vi.mock("../fallback-walk.js", () => ({
  walkFallbackChain: async () => ({ kind: "unserved", walked: true, reason: "nothing else can serve it" }),
}));

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
vi.mock("../../shared/logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { makeSession } from "./helpers/session-fixture.js";
import { handleRateLimit, type RateLimitHandlerOpts } from "../rate-limit-handler.js";
import { handBackDue, withOwnClearWake } from "../rate-limit-own-clear.js";
import { logger } from "../../shared/logger.js";
import { readEngineHealth, recordEngineServed, recordEngineUnavailable } from "../../shared/engine-health.js";
import type { UsageSample } from "../../shared/claude-usage-history.js";
import type { EngineResult, Session } from "../../shared/types.js";

const MIN = 60_000;
const STATE_PATH = path.join(tmp, "tmp", "engine-health.json");
const FRIEND = "claude:friend01";
const secs = (ms: number) => Math.floor(ms / 1000);
const answer: EngineResult = { result: "done", sessionId: "claude-thread-1" };

/** A session standing on the friend account (or on codex), its own target `claude`. */
function standingIn(kind: "account" | "engine", untilMs: number, syncSinceMs: number): Session {
  const override = kind === "account"
    ? { originalEngine: "claude", originalAccount: "claude", substituteAccount: FRIEND, substituteConfigDir: "/tmp/friend" }
    : { originalEngine: "claude", originalModel: "opus" };
  return makeSession({
    engine: kind === "account" ? "claude" : "codex",
    status: "waiting",
    transportMeta: { engineOverride: { ...override, originalEngineSessionId: null, until: new Date(untilMs).toISOString(), syncSince: new Date(syncSinceMs).toISOString() } } as never,
  });
}

function opts(session: Session, run: ReturnType<typeof vi.fn>): RateLimitHandlerOpts {
  const engine = session.engine;
  return {
    session,
    attemptToken: "attempt-1",
    prompt: "carry on",
    engineConfig: { bin: engine, model: "opus" },
    config: { engines: { default: "claude", claude: { bin: "claude", model: "opus" }, codex: { bin: "codex", model: "gpt" } }, sessions: {} } as unknown as RateLimitHandlerOpts["config"],
    engines: new Map(),
    engine: { run } as unknown as RateLimitHandlerOpts["engine"],
    // The stand-in's own weekly reset: days away.
    rateLimit: { resetsAt: secs(Date.now() + 5 * 24 * 60 * MIN) },
    originalResult: { result: "", sessionId: "claude-thread-1" } as EngineResult,
    hooks: {},
  };
}

/** Run the handler under fake time; `at` maps minutes from the start to something to do then. */
async function drive<T>(pending: Promise<T>, at: Record<number, () => void> = {}): Promise<{ value: T; minutes: number }> {
  const startedAt = Date.now();
  let done = false;
  const observed = pending.finally(() => { done = true; });
  observed.catch(() => {});
  for (let minute = 0; !done && minute < 4 * 60; minute++) {
    at[minute]?.();
    await vi.advanceTimersByTimeAsync(MIN);
  }
  if (!done) throw new Error("handler did not settle");
  return { value: await observed, minutes: Math.round((Date.now() - startedAt) / MIN) };
}

/** The own target was recorded spent `agoMinutes` ago, until days from now. */
const ownSpentAgo = (agoMinutes: number) =>
  recordEngineUnavailable("claude", "usage limit", secs(Date.now() + 4 * 24 * 60 * MIN), new Date(Date.now() - agoMinutes * MIN), { window: "7d" });
/** A turn on the own target, begun a minute ago, was served `agoMinutes` ago. */
const ownServedAgo = (agoMinutes: number) =>
  recordEngineServed("claude", Date.now() - (agoMinutes + 1) * MIN, undefined, new Date(Date.now() - agoMinutes * MIN));

beforeEach(() => {
  vi.clearAllMocks();
  fs.mkdirSync(path.dirname(STATE_PATH), { recursive: true });
  fs.rmSync(STATE_PATH, { force: true });
  vi.useFakeTimers({ now: new Date("2026-11-12T10:00:00Z") });
  readingMock.mockReturnValue(undefined);
  limitedMock.mockReturnValue(undefined);
});
afterEach(() => {
  vi.useRealTimers();
  fs.rmSync(STATE_PATH, { force: true });
});

describe.each(["account", "engine"] as const)("handleRateLimit — a wait on a %s stand-in", (kind) => {
  const standing = () => standingIn(kind, Date.now() + 3 * 60 * MIN, Date.now() - 5 * MIN);
  const live = (session: Session) => getSessionMock.mockImplementation(() => ({ ...session, status: "waiting" }));

  it("hands back at once, without waiting, when its own target was cleared before the wait began", async () => {
    ownSpentAgo(10);
    ownServedAgo(2);
    const session = standing();
    live(session);
    const run = vi.fn().mockResolvedValue(answer);

    // No time passes: a wait that began would not settle without the clock moving.
    const startedAt = Date.now();
    const pending = handleRateLimit(opts(session, run));
    await vi.advanceTimersByTimeAsync(0);
    const value = await pending;

    expect(value).toMatchObject({ kind: "handback", waited: false });
    expect(Date.now()).toBe(startedAt);
    expect(run).not.toHaveBeenCalled();
    expect(updateSessionForAttemptMock.mock.calls.some(([, , fields]) => fields.status === "waiting")).toBe(false);
    expect(vi.mocked(logger.info).mock.calls.some(([line]) => String(line).includes("own target's limit was cleared"))).toBe(true);
  });

  it("hands back within a minute of the own target clearing mid-wait, hours before the window", async () => {
    ownSpentAgo(10);
    const session = standing();
    live(session);
    const run = vi.fn().mockResolvedValue(answer);

    const { value, minutes } = await drive(handleRateLimit(opts(session, run)), { 30: () => ownServedAgo(0) });

    expect(value).toMatchObject({ kind: "handback", waited: true });
    expect(minutes).toBeGreaterThanOrEqual(30);
    expect(minutes).toBeLessThanOrEqual(32);
    expect(run).not.toHaveBeenCalled();
  });

  it("keeps waiting to the window when the own target never clears", async () => {
    ownSpentAgo(10);
    const session = standing();
    live(session);
    const run = vi.fn().mockResolvedValue(answer);

    const { value, minutes } = await drive(handleRateLimit(opts(session, run)));

    expect(value).toMatchObject({ kind: "handback", waited: true });
    expect(minutes).toBeGreaterThanOrEqual(180);
  });

  it("keeps waiting when the own record merely lapsed: only a positive clear counts", async () => {
    // A reset already behind us reads back ok with no clearedAt.
    recordEngineUnavailable("claude", "usage limit", secs(Date.now() - MIN), new Date(Date.now() - 60 * MIN));
    const session = standing();
    live(session);
    const run = vi.fn().mockResolvedValue(answer);

    const { minutes } = await drive(handleRateLimit(opts(session, run)));

    expect(minutes).toBeGreaterThanOrEqual(180);
  });

  it("keeps waiting when a clear is older than the swap", async () => {
    ownSpentAgo(30);
    ownServedAgo(20);
    const session = standingIn(kind, Date.now() + 3 * 60 * MIN, Date.now() - 5 * MIN);
    live(session);
    const run = vi.fn().mockResolvedValue(answer);

    const { minutes } = await drive(handleRateLimit(opts(session, run)));

    expect(minutes).toBeGreaterThanOrEqual(180);
  });
});

describe("handleRateLimit — the own-target check reads the live row", () => {
  it("judges the override the row carries now, as the hand-back's revert will", async () => {
    ownSpentAgo(10);
    ownServedAgo(2);
    // The turn's snapshot carries a swap older than the clear; the row now carries a newer swap, made after it.
    const snapshot = standingIn("account", Date.now() + 3 * 60 * MIN, Date.now() - 5 * MIN);
    const row = standingIn("account", Date.now() + 3 * 60 * MIN, Date.now() + MIN);
    getSessionMock.mockImplementation(() => ({ ...row, status: "waiting" }));
    const run = vi.fn().mockResolvedValue(answer);

    const { value, minutes } = await drive(handleRateLimit(opts(snapshot, run)));

    expect(value).toMatchObject({ kind: "handback", waited: true });
    expect(minutes).toBeGreaterThanOrEqual(180);
  });
});

describe("handleRateLimit — the own-target check beside the usage-reading watch", () => {
  it("the earliest wake wins: a reading that lifts the stand-in's limit before the own target clears", async () => {
    ownSpentAgo(10);
    const session = standingIn("account", Date.now() + 3 * 60 * MIN, Date.now() - 5 * MIN);
    getSessionMock.mockImplementation(() => ({ ...session, status: "waiting" }));
    const run = vi.fn().mockResolvedValue(answer);

    const { value, minutes } = await drive(handleRateLimit(opts(session, run)), {
      10: () => readingMock.mockReturnValue({ at: Date.now(), windows: [{ name: "5h", usedPercent: 2, resetsAt: secs(Date.now() + 60 * MIN) }] }),
      30: () => ownServedAgo(0),
    });

    expect(value.kind).toBe("resumed");
    expect(minutes).toBeGreaterThanOrEqual(10);
    expect(minutes).toBeLessThanOrEqual(12);
    expect(readingMock).toHaveBeenCalledWith(FRIEND);
  });

  it("the stand-in's own reset still ends the wait when it comes first", async () => {
    ownSpentAgo(10);
    const session = standingIn("account", Date.now() + 5 * 60 * MIN, Date.now() - 5 * MIN);
    getSessionMock.mockImplementation(() => ({ ...session, status: "waiting" }));
    const run = vi.fn().mockResolvedValue(answer);
    const opt = opts(session, run);
    opt.rateLimit = { resetsAt: secs(Date.now() + 20 * MIN) };

    const { value, minutes } = await drive(handleRateLimit(opt));

    expect(value.kind).toBe("resumed");
    expect(minutes).toBeGreaterThanOrEqual(20);
    expect(minutes).toBeLessThanOrEqual(21);
  });
});

describe("a wait with no hand-back pending", () => {
  it("never consults the own target", () => {
    const ownCleared = vi.fn(() => true);
    expect(handBackDue(undefined, ownCleared)).toBeUndefined();
    expect(withOwnClearWake(undefined, ownCleared, undefined)).toBeUndefined();
    const watch = () => 5;
    expect(withOwnClearWake(watch, ownCleared, undefined)).toBe(watch);
    expect(ownCleared).not.toHaveBeenCalled();
  });

  it("wakes now on a clear, and at the earlier of that and the watch otherwise", () => {
    const later = new Date(Date.now() + MIN);
    expect(handBackDue(later, () => true)).toBe("own-target-cleared");
    expect(handBackDue(new Date(Date.now() - 1), () => false)).toBe("window");
    expect(withOwnClearWake(undefined, () => true, later, () => 100)!(500)).toBe(100);
    expect(withOwnClearWake(() => 50, () => true, later, () => 100)!(500)).toBe(50);
    expect(withOwnClearWake(() => 150, () => true, later, () => 100)!(500)).toBe(100);
    expect(withOwnClearWake(() => 150, () => false, later, () => 100)!(500)).toBe(150);
    expect(withOwnClearWake(undefined, () => false, later, () => 100)!(500)).toBeUndefined();
  });
});

describe("handleRateLimit — a usage-limit retry that is served", () => {
  const plain = () => makeSession({ status: "waiting" });
  // The retry comes early, on a reading showing the limit lifted: at the stated reset the record has lapsed anyway, and a lapse is not a clear.
  const liftedAt = (minute: number) => ({ [minute]: () => readingMock.mockReturnValue({ at: Date.now(), windows: [{ name: "5h", usedPercent: 2, resetsAt: secs(Date.now() + 60 * MIN) }] }) });

  it("clears the record the limit wrote: the retry began after it", async () => {
    const session = plain();
    getSessionMock.mockImplementation(() => ({ ...session }));
    const run = vi.fn().mockResolvedValue(answer);
    const opt = opts(session, run);
    opt.rateLimit = { resetsAt: secs(Date.now() + 30 * MIN) };

    const { value } = await drive(handleRateLimit(opt), liftedAt(10));

    expect(value.kind).toBe("resumed");
    expect(readEngineHealth().claude).toMatchObject({ state: "ok", clearedAt: expect.any(String), reason: "a turn was served" });
  });

  it("stamps the record with the model that ran, and keeps it through a retry that is limited again", async () => {
    const session = makeSession({ status: "waiting", model: "opus" });
    getSessionMock.mockImplementation(() => ({ ...session }));
    let afterFirst: { model?: string } | undefined;
    const run = vi.fn()
      .mockResolvedValueOnce({ result: "", sessionId: "t", error: "limit" })
      .mockImplementationOnce(async () => { afterFirst = readEngineHealth().claude; return answer; });
    limitedMock.mockReturnValueOnce({ limited: true, resetsAt: secs(Date.now() + 60 * MIN) });
    limitedMock.mockReturnValue({ limited: false });
    const opt = opts(session, run);
    opt.rateLimit = { resetsAt: secs(Date.now() + 30 * MIN) };
    let atStart: string | undefined;
    await drive(handleRateLimit(opt), { 0: () => { atStart = readEngineHealth().claude?.model; }, ...liftedAt(10), ...liftedAt(30) });

    expect(atStart).toBe("opus");
    expect(afterFirst?.model).toBe("opus");
  });

  it("leaves it while the retry is limited again, and clears it once a later retry is served", async () => {
    const session = plain();
    getSessionMock.mockImplementation(() => ({ ...session }));
    // The first retry is limited again; what the record reads as the second one starts is what the first left.
    let beforeSecond: { state?: string; clearedAt?: string } | undefined;
    const run = vi.fn()
      .mockResolvedValueOnce({ result: "", sessionId: "t", error: "limit" })
      .mockImplementationOnce(async () => {
        beforeSecond = readEngineHealth().claude;
        return answer;
      });
    limitedMock.mockReturnValueOnce({ limited: true, resetsAt: secs(Date.now() + 60 * MIN) });
    limitedMock.mockReturnValue({ limited: false });
    const opt = opts(session, run);
    opt.rateLimit = { resetsAt: secs(Date.now() + 30 * MIN) };

    // A new reading lifts the limit the first retry found still up.
    const { value } = await drive(handleRateLimit(opt), { ...liftedAt(10), ...liftedAt(30) });

    expect(value.kind).toBe("resumed");
    expect(run).toHaveBeenCalledTimes(2);
    expect(beforeSecond).toMatchObject({ state: "exhausted" });
    expect(beforeSecond?.clearedAt).toBeUndefined();
    expect(readEngineHealth().claude?.clearedAt).toBeDefined();
  });

  it("does not clear on a retry that ended in an error that is not a limit", async () => {
    const session = plain();
    getSessionMock.mockImplementation(() => ({ ...session }));
    const run = vi.fn().mockResolvedValue({ result: "", sessionId: "t", error: "boom" });
    const opt = opts(session, run);
    opt.rateLimit = { resetsAt: secs(Date.now() + 30 * MIN) };

    const { value } = await drive(handleRateLimit(opt), liftedAt(10));

    expect(value.kind).toBe("resumed");
    expect(readEngineHealth().claude?.state).toBe("exhausted");
  });
});

describe("handleRateLimit — an opencode model's retry", () => {
  it("holds a repeat limit under the provider key, never the engine-wide one", async () => {
    const session = makeSession({ engine: "opencode", model: "x-provider/model-x", status: "waiting" });
    getSessionMock.mockImplementation(() => ({ ...session, status: "waiting" }));
    const resetIn = (minutes: number) => secs(Date.now() + minutes * MIN);
    // Limited again at the first retry, reopening three minutes after it.
    limitedMock.mockImplementationOnce(() => ({ limited: true, resetsAt: resetIn(3) }));
    const run = vi.fn().mockResolvedValue(answer);
    const pending = handleRateLimit({ ...opts(session, run), engineConfig: { bin: "opencode" }, rateLimit: { resetsAt: resetIn(2) } });

    let afterRepeat: ReturnType<typeof readEngineHealth> | undefined;
    const { value } = await drive(pending, { 4: () => { afterRepeat = readEngineHealth(); } });

    expect(value.kind).toBe("resumed");
    expect(run).toHaveBeenCalledTimes(2);
    // The repeat limit was held where the first one was, not on the engine as a whole.
    expect(afterRepeat?.["opencode/x-provider"]?.state).toBe("exhausted");
    expect(afterRepeat?.opencode).toBeUndefined();
    // Nothing engine-wide was left behind to hold every opencode provider out once this one served.
    expect(readEngineHealth().opencode).toBeUndefined();
  });
});
