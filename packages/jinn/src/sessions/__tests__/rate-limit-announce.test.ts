import { describe, it, expect, vi, beforeEach } from "vitest";
import type { RateLimitHandlerHooks } from "../rate-limit-handler.js";
import type { Engine } from "../../shared/types.js";

/**
 * The fallback announcement used to be written for one engine: it said
 * Claude was limited and GPT was taking over, and it killed the Claude PTY, no
 * matter which engine had actually run out. A codex limit therefore told the
 * operator the wrong thing and left the codex PTY warm — exactly the abandoned
 * turn the kill exists to prevent.
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

vi.mock("../registry.js", () => ({
  getSession: vi.fn(() => undefined),
  insertMessage: vi.fn(),
}));

vi.mock("../turn/completion.js", () => ({ settleTurn: vi.fn(async () => undefined) }));

import { runRateLimitTurn, type RateLimitTurnArgs } from "../turn/rate-limit-turn.js";

/** A PTY-backed engine: `isInterruptibleEngine` wants all three of these. */
function interruptibleEngine() {
  return { run: vi.fn(), kill: vi.fn(), isAlive: vi.fn(() => true), killAll: vi.fn() };
}

const codex = interruptibleEngine();
const claude = interruptibleEngine();
const notice = vi.fn(async () => {});

/** A codex-primary turn whose chain hands the work to claude. */
function codexTurnArgs(): RateLimitTurnArgs {
  return {
    input: {
      session: { id: "sess-1", engine: "codex", employee: "a-worker" },
      engines: new Map<string, Engine>([
        ["codex", codex as unknown as Engine],
        ["claude", claude as unknown as Engine],
      ]),
      attemptToken: "attempt-1",
      prompt: "hello",
      attachments: [],
      config: {},
    },
    plan: { engine: {}, engineConfig: {}, engineName: "codex" },
    surface: { notice, reply: vi.fn(async () => {}), delta: vi.fn(), waiting: vi.fn(async () => {}) },
    platformContextFingerprint: "fp",
    rateLimit: {},
    originalResult: { result: "", sessionId: "codex-thread-1" },
    terminalFields: () => ({}),
  } as unknown as RateLimitTurnArgs;
}

/** Run the turn and hand back the hooks the handler was given. */
async function fallbackHooks(): Promise<RateLimitHandlerHooks> {
  await runRateLimitTurn(codexTurnArgs());
  return capturedHooks.mock.calls[0]![0];
}

beforeEach(() => vi.clearAllMocks());

describe("the fallback announcement", () => {
  it("names the engine that was limited and the one taking over", async () => {
    const hooks = await fallbackHooks();

    await hooks.onFallbackStart!({ resumeAt: null, until: new Date(), substitute: "claude" });

    expect(notifyOperatorChannel).toHaveBeenCalledWith(
      "⚠️ Codex usage limit reached. Session sess-1 (a-worker) switching to Claude.",
    );
    expect(notice).toHaveBeenCalledWith("⚠️ Codex usage limit reached. Switching to Claude for now.");
  });

  it("kills the limited engine's PTY and leaves the substitute's alone", async () => {
    const hooks = await fallbackHooks();

    await hooks.onFallbackStart!({ resumeAt: null, until: new Date(), substitute: "claude" });

    expect(codex.kill).toHaveBeenCalledWith("sess-1", "Interrupted: engine switched");
    expect(claude.kill).not.toHaveBeenCalled();
  });
});
