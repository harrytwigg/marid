import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

/**
 * opencode server mode when the provider fails: what the turn waits for and
 * what it says. Real processes, as in opencode-server-mode.test.ts: the fake
 * `opencode` (fixtures/fake-opencode.mjs) plays the event orders real 1.18.35
 * and 1.19.0 emit for a provider answering 429 "Go usage limit exceeded", and
 * the fallback shapes where opencode takes the turn up again after a reply
 * that wrote nothing.
 */

vi.mock("../../shared/logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { OpencodeEngine } from "../opencode.js";
import { OpencodeServerPool, basicAuthHeader } from "../opencode-server.js";
import { SERVER_TURN_TIMING } from "../opencode-server-turn.js";
import { abandonedRetryError, providerRetryOf, SettleWait } from "../opencode-server-settle.js";
import { PtyLifecycleManager } from "../pty-lifecycle.js";
import { JINN_HOME } from "../../shared/paths.js";
import type { EngineRunOpts } from "../../shared/types.js";

const FAKE = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures", "fake-opencode.mjs");
const DEFAULT_TIMING = { ...SERVER_TURN_TIMING };

let pools: OpencodeServerPool[] = [];
let engines: OpencodeEngine[] = [];

function harness(): { pool: OpencodeServerPool; engine: OpencodeEngine } {
  const lifecycle = new PtyLifecycleManager({ maxLivePtys: 8, enforceLocalCap: false });
  const pool = new OpencodeServerPool(lifecycle, { limits: () => ({}), bin: () => FAKE });
  const engine = new OpencodeEngine({ mode: () => "server", servers: pool });
  pools.push(pool);
  engines.push(engine);
  return { pool, engine };
}

function runOpts(prompt: string): EngineRunOpts {
  return { prompt, cwd: JINN_HOME, sessionId: "sess-1", bin: FAKE, model: "opencode-go/deepseek-v4.1-flash" };
}

async function serverLog(pool: OpencodeServerPool): Promise<Array<{ method: string; url: string }>> {
  const server = pool.get("sess-1")!;
  const res = await fetch(`${server.apiUrl}/test/log`, { headers: { authorization: basicAuthHeader(server.password) } });
  return await res.json() as Array<{ method: string; url: string }>;
}

beforeEach(() => {
  Object.assign(SERVER_TURN_TIMING, DEFAULT_TIMING);
});

afterEach(async () => {
  for (const engine of engines) engine.killAll();
  await Promise.all(pools.map((pool) => pool.stopAll()));
  pools = [];
  engines = [];
  Object.assign(SERVER_TURN_TIMING, DEFAULT_TIMING);
});

describe("a provider error in a server turn", { timeout: 20_000 }, () => {
  it("waits while opencode retries the provider, and takes the retried step's answer", async () => {
    const { engine } = harness();
    const result = await engine.run(runOpts("PROVIDERRETRY build it"));
    expect(result.error).toBeUndefined();
    expect(result.result).toContain("answer:PROVIDERRETRY build it");
  });

  it("when opencode gives up, the provider's error is the turn's error, and reads as a usage limit", async () => {
    const { engine } = harness();
    const result = await engine.run(runOpts("PROVIDERGIVEUP build it"));
    expect(result.error).toBe("APIError: Go usage limit exceeded");
    expect(result.rateLimit).toEqual({ status: "rejected" });
    expect(result.numTurns).toBe(1); // the conversation exists; its resume id is kept
  });

  it("a reply that ends with nothing written after a retry names the provider's error, not only the empty reply", async () => {
    const { engine } = harness();
    const result = await engine.run(runOpts("PROVIDERDROP build it"));
    expect(result.error).toBe(
      "opencode's provider failed: Go usage limit exceeded; the opencode server ended the turn without a final assistant response (its reply never finished with 0 output tokens)",
    );
    expect(result.rateLimit).toEqual({ status: "rejected" });
  });

  it("does not end the turn at an idle that opencode follows with a fallback reply", async () => {
    const { engine } = harness();
    const result = await engine.run(runOpts("FALLBACKIDLE build it"));
    expect(result.error).toBeUndefined();
    expect(result.result).toContain("answer:FALLBACKIDLE build it");
  });

  it("does not end the turn at a reply that finished with nothing written when a newer reply follows", async () => {
    const { engine } = harness();
    const result = await engine.run(runOpts("FALLBACKREPLY build it"));
    expect(result.error).toBeUndefined();
    expect(result.result).toContain("answer:FALLBACKREPLY build it");
  });

  it("ends a turn whose provider retry is too far off, with the provider's words and when it resets, and stops the retry on the server", async () => {
    SERVER_TURN_TIMING.retryWaitCapMs = 60_000;
    SERVER_TURN_TIMING.retryGraceMs = 300;
    const { pool, engine } = harness();
    const before = Date.now();
    const result = await engine.run(runOpts("PROVIDERWAIT build it"));
    expect(result.error).toBe("ProviderError: Go usage limit exceeded; opencode would not retry it for 60 min");
    expect(result.rateLimit?.status).toBe("rejected");
    expect(result.rateLimit?.resetsAt).toBeGreaterThanOrEqual(Math.floor((before + 3_600_000) / 1000));
    expect(result.numTurns).toBe(1);
    expect((await serverLog(pool)).some((e) => /^\/session\/[^/]+\/abort$/.test(e.url))).toBe(true);
  });

  it("waits out a provider retry that is due within the cap", async () => {
    SERVER_TURN_TIMING.retryWaitCapMs = 2 * 3_600_000; // the fake's retry is an hour off
    SERVER_TURN_TIMING.retryGraceMs = 300;
    const { engine } = harness();
    const turn = engine.run(runOpts("PROVIDERWAIT build it"));
    await new Promise((r) => setTimeout(r, 1_000));
    expect(engine.isAlive("sess-1")).toBe(true);
    engine.kill("sess-1", "Interrupted: operator");
    expect((await turn).error).toBe("Interrupted: operator");
  });
});

describe("opencode-server-settle", () => {
  it("reads a retry status, and nothing else", () => {
    expect(providerRetryOf({ type: "retry", attempt: 1, message: "Go usage limit exceeded", next: 5 })).toEqual({ message: "Go usage limit exceeded", next: 5 });
    expect(providerRetryOf({ type: "retry" })).toEqual({ message: "the provider failed and opencode is retrying it" });
    expect(providerRetryOf({ type: "busy" })).toBeUndefined();
    expect(providerRetryOf(undefined)).toBeUndefined();
  });

  it("says how far off an abandoned retry was", () => {
    expect(abandonedRetryError({ message: "Usage limit reached", next: 3 * 3_600_000 }, 0).data.message).toBe("Usage limit reached; opencode would not retry it for 180 min");
    expect(abandonedRetryError({ message: "Usage limit reached" }).data.message).toBe("Usage limit reached");
  });

  it("keeps one pending end: a repeat does not push it back, another reason replaces it, and a cancel names what it stops", () => {
    vi.useFakeTimers();
    try {
      const ended: string[] = [];
      const wait = new SettleWait((kind) => ended.push(kind));
      wait.arm("idle", 100);
      vi.advanceTimersByTime(60);
      wait.arm("idle", 100);
      vi.advanceTimersByTime(40);
      expect(ended).toEqual(["idle"]);

      wait.arm("done", 100);
      wait.cancel("idle", "retry");
      expect(wait.pending).toBe("done");
      wait.arm("retry", 100);
      wait.cancel("retry");
      expect(wait.pending).toBeUndefined();
      vi.advanceTimersByTime(200);
      expect(ended).toEqual(["idle"]);
    } finally {
      vi.useRealTimers();
    }
  });
});
