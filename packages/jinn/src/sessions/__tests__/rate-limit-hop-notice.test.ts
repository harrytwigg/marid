import { beforeEach, describe, expect, it, vi } from "vitest";
import type { RateLimitHandlerHooks } from "../rate-limit-handler.js";
import type { Engine } from "../../shared/types.js";
import type { FallbackHop } from "../../shared/fallback-chain-wire.js";

/**
 * Each hop along a fallback chain is announced once: a notification in the
 * transcript that carries the hop (`meta.fallbackHop`) and reads as plain text
 * for the connectors; the operator channel hears what it always heard.
 */

const capturedHooks = vi.fn<(hooks: RateLimitHandlerHooks) => void>();
vi.mock("../rate-limit-handler.js", () => ({
  handleRateLimit: (opts: { hooks: RateLimitHandlerHooks }) => {
    capturedHooks(opts.hooks);
    return Promise.resolve({ kind: "fallback" });
  },
}));

const notifyOperatorChannel = vi.fn();
vi.mock("../callbacks.js", () => ({
  notifyOperatorChannel: (...args: unknown[]) => notifyOperatorChannel(...args),
  notifyRateLimited: vi.fn(),
  notifyRateLimitResumed: vi.fn(),
}));
vi.mock("../registry.js", () => ({ getSession: vi.fn(() => undefined), insertMessage: vi.fn() }));
vi.mock("../turn/completion.js", () => ({ settleTurn: vi.fn(async () => undefined) }));

import { runRateLimitTurn, type RateLimitTurnArgs } from "../turn/rate-limit-turn.js";

const notice = vi.fn(async (_text: string, _meta?: unknown) => {});

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

beforeEach(() => vi.clearAllMocks());

describe("a chain hop's announcement", () => {
  it("is a notification naming both targets in full, carrying the hop", async () => {
    await (await hooks()).onFallbackStart!({ resumeAt: null, until: new Date(), substitute: "claude", model: "sonnet", hop });

    expect(notice).toHaveBeenCalledTimes(1);
    expect(notice).toHaveBeenCalledWith("⚠️ claude · work · opus hit its usage limit. Moving to claude · spare · sonnet.", { fallbackHop: hop });
  });

  it("leaves the operator channel's line as it was", async () => {
    await (await hooks()).onFallbackStart!({ resumeAt: null, until: new Date(), substitute: "claude", model: "sonnet", hop });

    expect(notifyOperatorChannel).toHaveBeenCalledWith("⚠️ Claude usage limit reached. Session sess-1 (a-worker) switching to Claude (sonnet).");
  });

  it("is the engine swap's own wording, with no hop on the notice, when the swap is not a chain hop", async () => {
    await (await hooks()).onFallbackStart!({ resumeAt: null, until: new Date(), substitute: "codex" });

    expect(notice).toHaveBeenCalledWith("⚠️ Claude usage limit reached. Switching to Codex for now.");
  });
});

describe("a hop that did not serve the turn", () => {
  it("still posts the notices its engine asked for, once each", async () => {
    await (await hooks()).onFallbackFailed!({ sessionId: "", result: "", error: "429", notices: ["from a plugin host"] });

    expect(notice).toHaveBeenCalledTimes(1);
    expect(notice).toHaveBeenCalledWith("from a plugin host");
  });
});

describe("the chain running out", () => {
  const ran = { ...hop, to: null, toLabel: null };

  it("says what was tried and carries the hop that records it", async () => {
    await (await hooks()).onWaitingStart!({
      resumeAt: null, rateLimit: {}, reason: "every target in its fallback chain was tried (a, b); waiting for claude · work · opus to reset", hop: ran,
    });

    expect(notice).toHaveBeenCalledTimes(1);
    const [text, meta] = notice.mock.calls[0]!;
    expect(text).toContain("Not switching: every target in its fallback chain was tried (a, b); waiting for claude · work · opus to reset.");
    expect(meta).toEqual({ fallbackHop: ran });
  });

  it("keeps the plain wait notice free of a hop", async () => {
    await (await hooks()).onWaitingStart!({ resumeAt: null, rateLimit: {} });

    expect(notice).toHaveBeenCalledWith("⏳ Claude usage limit reached — I'll continue automatically.");
  });
});
