import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RateLimitHandlerHooks } from "../rate-limit-handler.js";
import type { Engine } from "../../shared/types.js";
import type { FallbackHop } from "../../shared/fallback-chain-wire.js";
import type { RateLimitInfo } from "../rate-limit-contract.js";

/**
 * `notifications.events.<category>: false` silences one kind of operator alert
 * and nothing else. The real gate runs here: only the config, the connector
 * send and the rate-limit handler are stood in for, so a hook that forgot to
 * name its category would send when it should not (or the reverse).
 */

const hoisted = vi.hoisted(() => ({ config: {} as Record<string, unknown> }));

vi.mock("../callback-connection.js", () => ({
  internalGatewayConnection: () => ({ baseUrl: "http://gateway.test", token: "tok" }),
  internalGatewayHeaders: () => ({ "Content-Type": "application/json" }),
}));
vi.mock("../../shared/config.js", () => ({ loadConfig: vi.fn(() => hoisted.config) }));
vi.mock("../../shared/logger.js", () => ({
  logger: { warn: vi.fn(), debug: vi.fn(), info: vi.fn(), error: vi.fn() },
}));

const capturedHooks = vi.fn<(hooks: RateLimitHandlerHooks) => void>();
vi.mock("../rate-limit-handler.js", () => ({
  handleRateLimit: (opts: { hooks: RateLimitHandlerHooks }) => {
    capturedHooks(opts.hooks);
    return Promise.resolve({ kind: "fallback" });
  },
}));
vi.mock("../callbacks.js", async () => ({
  notifyOperatorChannel: (await import("../operator-notification.js")).notifyOperatorChannel,
  notifyRateLimited: vi.fn(),
  notifyRateLimitResumed: vi.fn(),
}));
vi.mock("../registry.js", () => ({ getSession: vi.fn(() => undefined), insertMessage: vi.fn() }));
vi.mock("../turn/completion.js", () => ({ settleTurn: vi.fn(async () => undefined) }));

import { runRateLimitTurn, type RateLimitTurnArgs } from "../turn/rate-limit-turn.js";

const notice = vi.fn(async (_text: string, _meta?: unknown) => {});
const originalFetch = globalThis.fetch;
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));
let fetchSpy: ReturnType<typeof vi.fn>;

function turnArgs(): RateLimitTurnArgs {
  return {
    input: {
      session: { id: "sess-1", engine: "claude", employee: "a-worker" },
      engines: new Map<string, Engine>(),
      attemptToken: "attempt-1", prompt: "hello", attachments: [], config: {},
    },
    plan: { engine: {}, engineConfig: {}, engineName: "claude" },
    surface: { notice, reply: vi.fn(async () => {}), delta: vi.fn(), waiting: vi.fn(async () => {}) },
    platformContextFingerprint: "fp", rateLimit: {}, originalResult: { result: "", sessionId: "t" }, terminalFields: () => ({}),
  } as unknown as RateLimitTurnArgs;
}

async function hooks(): Promise<RateLimitHandlerHooks> {
  await runRateLimitTurn(turnArgs());
  return capturedHooks.mock.calls[0]![0];
}

const hop: FallbackHop = {
  at: "2026-10-19T10:00:00.000Z", from: "claude|work|opus", to: "claude|spare|sonnet", fromLabel: "claude · work · opus", toLabel: "claude · spare · sonnet", reason: "rate-limit",
};

const target = { connector: "telegram", channel: "1" };

beforeEach(() => {
  vi.clearAllMocks();
  hoisted.config = { notifications: target };
  fetchSpy = vi.fn(async () => ({ ok: true }));
  globalThis.fetch = fetchSpy as unknown as typeof fetch;
});
afterEach(() => { globalThis.fetch = originalFetch; });

const sent = () => fetchSpy.mock.calls.map((call) => JSON.parse((call[1] as { body: string }).body).text as string);

describe("the fallback alert", () => {
  it("is sent when notifications.events is unset", async () => {
    await (await hooks()).onFallbackStart!({ resumeAt: null, until: new Date(), substitute: "claude", model: "sonnet", hop });
    await flush();

    expect(sent()).toEqual(["⚠️ Claude usage limit reached. Session sess-1 (a-worker) switching to Claude (sonnet)."]);
  });

  it("is not sent when notifications.events.fallback is false, yet the transcript notice and hop record are still written", async () => {
    hoisted.config = { notifications: { ...target, events: { fallback: false } } };

    await (await hooks()).onFallbackStart!({ resumeAt: null, until: new Date(), substitute: "claude", model: "sonnet", hop });
    await flush();

    expect(fetchSpy).not.toHaveBeenCalled();
    expect(notice).toHaveBeenCalledWith("⚠️ claude · work · opus hit its usage limit. Moving to claude · spare · sonnet.", { fallbackHop: hop });
  });

  it("still writes the engine swap's own transcript notice when it is off", async () => {
    hoisted.config = { notifications: { ...target, events: { fallback: false } } };

    await (await hooks()).onFallbackStart!({ resumeAt: null, until: new Date(), substitute: "codex" });
    await flush();

    expect(fetchSpy).not.toHaveBeenCalled();
    expect(notice).toHaveBeenCalledWith("⚠️ Claude usage limit reached. Switching to Codex for now.");
  });
});

describe("the other usage-limit alerts", () => {
  it("are unaffected by the fallback switch", async () => {
    hoisted.config = { notifications: { ...target, events: { fallback: false } } };
    const h = await hooks();

    await h.onWaitingStart!({ resumeAt: null, rateLimit: {} as RateLimitInfo });
    await h.onTimeout!();
    await h.onBillingFailure!();
    await h.onRetryHostUnreachable!({ error: "boom" });
    await h.onRetryHostNotReady!({ error: "no ssh", failures: 1, retryAt: new Date() });
    await flush();

    expect(sent()).toHaveLength(5);
    expect(sent().join("\n")).toMatch(/paused/);
    expect(sent().join("\n")).toMatch(/did not clear in time/);
  });

  it("each go quiet under their own category", async () => {
    hoisted.config = { notifications: { ...target, events: { paused: false, stopped: false } } };
    const h = await hooks();

    await h.onWaitingStart!({ resumeAt: null, rateLimit: {} as RateLimitInfo });
    await h.onRetryHostNotReady!({ error: "no ssh", failures: 1, retryAt: new Date() });
    await h.onTimeout!();
    await h.onBillingFailure!();
    await h.onRetryHostUnreachable!({ error: "boom" });
    await flush();

    expect(fetchSpy).not.toHaveBeenCalled();
    // their transcript lines are untouched
    expect(notice).toHaveBeenCalledTimes(2);
  });
});
