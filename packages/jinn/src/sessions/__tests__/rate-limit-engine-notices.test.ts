import { describe, it, expect, vi, beforeEach } from "vitest";
import type { RateLimitHandlerHooks } from "../rate-limit-handler.js";
import type { Engine } from "../../shared/types.js";

/**
 * A notice an engine asks for (`EngineResult.notices`) is posted wherever the turn takes the
 * engine's result: not only on the first attempt, but on a chain hop's substitute and on a
 * parked retry, which call the engine themselves.
 */

const capturedHooks = vi.fn<(hooks: RateLimitHandlerHooks) => void>();
vi.mock("../rate-limit-handler.js", () => ({
  handleRateLimit: (opts: { hooks: RateLimitHandlerHooks }) => {
    capturedHooks(opts.hooks);
    return Promise.resolve({ kind: "fallback" });
  },
}));
vi.mock("../callbacks.js", () => ({ notifyOperatorChannel: vi.fn(), notifyRateLimited: vi.fn(), notifyRateLimitResumed: vi.fn() }));
vi.mock("../registry.js", () => ({ getSession: vi.fn(() => undefined), insertMessage: vi.fn() }));
vi.mock("../turn/completion.js", () => ({ settleTurn: vi.fn(async () => undefined) }));

import { runRateLimitTurn, type RateLimitTurnArgs } from "../turn/rate-limit-turn.js";

const notice = vi.fn(async (_text: string) => {});
const NOTICE = "Answered by x/y through the host's opencode fallback plugin, not the gateway's chain. Run `jinn doctor` to remove it.";

function turnArgs(): RateLimitTurnArgs {
  return {
    input: {
      session: { id: "sess-1", engine: "opencode", employee: "a-worker" },
      engines: new Map<string, Engine>(),
      attemptToken: "attempt-1",
      prompt: "hello",
      attachments: [],
      config: {},
    },
    plan: { engine: {}, engineConfig: {}, engineName: "opencode" },
    surface: { notice, reply: vi.fn(async () => {}), delta: vi.fn(), waiting: vi.fn(async () => {}) },
    platformContextFingerprint: "fp",
    rateLimit: {},
    originalResult: { result: "", sessionId: "t1" },
    terminalFields: () => ({}),
  } as unknown as RateLimitTurnArgs;
}

async function hooks(): Promise<RateLimitHandlerHooks> {
  await runRateLimitTurn(turnArgs());
  return capturedHooks.mock.calls[0]![0];
}

beforeEach(() => vi.clearAllMocks());

describe("engine notices on the rate-limit paths", () => {
  it("are posted for a chain hop's substitute", async () => {
    const h = await hooks();
    await h.onFallbackComplete!({ result: "ok", sessionId: "s2", notices: [NOTICE] }, { engine: "opencode", model: "x/y" });
    expect(notice).toHaveBeenCalledWith(NOTICE);
  });

  it("are posted for a parked retry that succeeded", async () => {
    const h = await hooks();
    await h.onRetrySuccess!({ result: "ok", sessionId: "s2", notices: [NOTICE] });
    expect(notice).toHaveBeenCalledWith(NOTICE);
  });

  it("are not posted when the engine asked for none", async () => {
    const h = await hooks();
    await h.onRetrySuccess!({ result: "ok", sessionId: "s2" });
    expect(notice).not.toHaveBeenCalledWith(NOTICE);
  });
});
