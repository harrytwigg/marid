import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The turn-level wiring of a usage-limit retry whose host is not ready. The
 * handler only calls hooks; these are what make the fix real: the retry wakes
 * the host first (without it a host that needs waking is never woken and the
 * loop spins to its bound), a streak says so once without leaving a connector
 * showing "thinking", and the bound fails the turn where people see it.
 */

const handleRateLimit = vi.fn(async (_opts: RateLimitHandlerOpts) => ({ kind: "cancelled" }) as RateLimitOutcome);
vi.mock("../rate-limit-handler.js", () => ({ handleRateLimit: (opts: RateLimitHandlerOpts) => handleRateLimit(opts) }));

const awaitRemoteHostForRetry = vi.fn(async (..._args: unknown[]) => ({ ok: true }) as const);
vi.mock("../turn/remote-ready.js", () => ({ awaitRemoteHostForRetry: (...args: unknown[]) => awaitRemoteHostForRetry(...args) }));

const settleTurn = vi.fn(async (_input: Record<string, unknown>) => undefined);
vi.mock("../turn/completion.js", () => ({ settleTurn: (input: Record<string, unknown>) => settleTurn(input) }));

const operator: string[] = [];
vi.mock("../callbacks.js", () => ({
  notifyOperatorChannel: (message: string) => { operator.push(message); },
  notifyRateLimited: vi.fn(),
  notifyRateLimitResumed: vi.fn(),
}));

import { runRateLimitTurn, type RateLimitTurnArgs } from "../turn/rate-limit-turn.js";
import type { RateLimitHandlerHooks, RateLimitHandlerOpts, RateLimitOutcome } from "../rate-limit-contract.js";
import { makeSession } from "./helpers/session-fixture.js";

function surface() {
  return {
    notice: vi.fn(async () => {}),
    reply: vi.fn(async () => {}),
    waiting: vi.fn(async () => {}),
    delta: vi.fn(),
    started: vi.fn(async () => {}),
  };
}

function turnArgs(s = surface()): RateLimitTurnArgs {
  return {
    input: { session: makeSession({ status: "waiting" }), employee: undefined, attachments: [], attemptToken: "attempt-1", prompt: "carry on", config: {}, engines: new Map() },
    plan: { engineName: "claude", engineConfig: {}, engine: {}, model: "opus" },
    surface: s,
    systemPrompt: "",
    platformContextFingerprint: "fp",
    rateLimit: {},
    originalResult: { result: "", sessionId: "x" },
    terminalFields: () => ({}),
  } as unknown as RateLimitTurnArgs;
}

/** The hooks the turn hands the handler. */
async function hooksFor(args: RateLimitTurnArgs): Promise<RateLimitHandlerHooks> {
  await runRateLimitTurn(args);
  return handleRateLimit.mock.calls.at(-1)![0].hooks;
}

beforeEach(() => {
  vi.clearAllMocks();
  operator.length = 0;
});

describe("runRateLimitTurn — a retry whose host is not ready", () => {
  it("wakes and waits for this turn's host before each retry, on the engine the turn ran", async () => {
    const args = turnArgs();
    const hooks = await hooksFor(args);
    awaitRemoteHostForRetry.mockResolvedValueOnce({ ok: false, error: "Remote host unavailable: build-box is asleep" } as never);

    expect(hooks.prepareRetry).toBeTypeOf("function");
    await expect(hooks.prepareRetry!()).resolves.toEqual({ ok: false, error: "Remote host unavailable: build-box is asleep" });
    expect(awaitRemoteHostForRetry).toHaveBeenCalledWith(args.input, "claude");
  });

  it("announces a streak once, in the chat and to the operator, and puts the transport back to waiting on every failure", async () => {
    const s = surface();
    const hooks = await hooksFor(turnArgs(s));
    const error = "remote host not ready: build-box is not reachable";

    await hooks.onRetryHostNotReady!({ error, failures: 1, retryAt: new Date() });
    await hooks.onRetryHostNotReady!({ error, failures: 2, retryAt: new Date() });
    await hooks.onRetryHostNotReady!({ error, failures: 3, retryAt: new Date() });

    expect(s.notice).toHaveBeenCalledTimes(1);
    expect(String((s.notice.mock.calls[0] as unknown[])[0])).toContain(error);
    expect(operator).toHaveLength(1);
    expect(operator[0]).toContain(error);
    // The retry attempt set the transport to thinking; each failure sets it back.
    expect(s.waiting.mock.calls).toEqual([[true], [true], [true]]);
  });

  it("fails the turn at the bound, out of waiting or running, and tells the operator and the chat", async () => {
    const s = surface();
    const hooks = await hooksFor(turnArgs(s));
    const error = "remote host not ready: build-box is not reachable (still not ready 12h after the usage limit reset, 30 attempts)";

    await hooks.onRetryHostUnreachable!({ error });

    expect(settleTurn).toHaveBeenCalledWith(expect.objectContaining({
      sessionId: "sess-1", attemptToken: "attempt-1", outcome: "failed", error, expectedStatuses: ["waiting", "running"],
    }));
    expect(operator.some((message) => message.includes(error))).toBe(true);
    expect(s.reply).toHaveBeenCalledTimes(1);
    expect(String((s.reply.mock.calls[0] as unknown[])[0])).toContain(error);
  });
});
