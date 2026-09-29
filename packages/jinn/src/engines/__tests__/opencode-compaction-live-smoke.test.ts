import { describe, it, expect, afterAll } from "vitest";

/**
 * Live smoke of a `/compact` turn against a REAL opencode server and model. Skipped unless OPENCODE_LIVE_SMOKE=1, like opencode-live-smoke:
 * it spends model tokens and needs a signed-in opencode.
 *
 *   OPENCODE_LIVE_SMOKE=1 OPENCODE_BIN=~/.opencode/bin/opencode \
 *   OPENCODE_SMOKE_MODEL=opencode-go/deepseek-v4.1-flash \
 *   pnpm exec vitest run src/engines/__tests__/opencode-compaction-live-smoke.test.ts
 *
 * What only a real server and model can show: that summarize really replaces
 * the history, that the re-seeded system prompt really reaches the model after
 * it (the persona is ONLY in the first user message, so without the re-seed it
 * would be summarized away), and that a fact from before the compaction
 * survives into the next turn.
 */

const LIVE = process.env.OPENCODE_LIVE_SMOKE === "1";
const BIN = process.env.OPENCODE_BIN ?? "opencode";
const MODEL = process.env.OPENCODE_SMOKE_MODEL ?? "opencode-go/deepseek-v4.1-flash";

import { OpencodeEngine } from "../opencode.js";
import { OpencodeServerPool, basicAuthHeader } from "../opencode-server.js";
import { PtyLifecycleManager } from "../pty-lifecycle.js";
import { JINN_HOME } from "../../shared/paths.js";
import type { EngineRunOpts } from "../../shared/types.js";

const cleanups: Array<() => void> = [];
afterAll(() => { for (const c of cleanups) c(); });

describe.skipIf(!LIVE)("opencode /compact — live", { timeout: 300_000 }, () => {
  it("compacts, re-seeds the persona, and keeps what the session knew", async () => {
    const sessionId = `smoke-compact-${Date.now()}`;
    const lifecycle = new PtyLifecycleManager({ maxLivePtys: 4, enforceLocalCap: false });
    const pool = new OpencodeServerPool(lifecycle, { bin: () => BIN, limits: () => ({ startTimeoutMs: 60_000 }) });
    const engine = new OpencodeEngine({ mode: () => "server", servers: pool });
    cleanups.push(() => { engine.killAll(); void pool.stopAll(); });
    const persona = "You are Pirate Bob. End every reply with the word ARR.";
    const opts = (over: Partial<EngineRunOpts>): EngineRunOpts => ({
      prompt: "", cwd: JINN_HOME, sessionId, bin: BIN, model: MODEL, systemPrompt: persona, ...over,
    });

    const one = await engine.run(opts({ prompt: "Remember the codeword PLUM-42. Reply OK." }));
    expect(one.error).toBeUndefined();

    const compacted = await engine.run(opts({ prompt: "/compact keep the codeword", resumeSessionId: one.sessionId }));
    expect(compacted.error).toBeUndefined();
    expect(compacted.result).toBe("");
    // What the chat's "Context compacted (it was …)" reads.
    console.log(`live opencode compaction: ${JSON.stringify(compacted.compaction)}`);
    expect(compacted.compaction?.preTokens).toBeGreaterThan(0);

    const server = pool.get(sessionId)!;
    const stored = await (await fetch(`${server.apiUrl}/session/${one.sessionId}/message`, {
      headers: { authorization: basicAuthHeader(server.password) },
    })).json() as Array<{ info: { role: string; summary?: boolean }; parts: Array<{ type: string; text?: string; metadata?: { jinn?: string } }> }>;
    expect(stored.some((m) => m.info.summary === true)).toBe(true);
    expect(stored.at(-1)!.parts[0]!.metadata?.jinn).toBe("context-reseed");

    const three = await engine.run(opts({ prompt: "What was the codeword? One line.", resumeSessionId: one.sessionId }));
    expect(three.error).toBeUndefined();
    expect(three.result).toContain("PLUM-42");
    expect(three.result).toMatch(/ARR/);
  });
});
