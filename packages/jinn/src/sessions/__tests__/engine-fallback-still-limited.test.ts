import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HOUR, START, answer, fallbackExpiryHarness, limitedUntil, runs } from "./helpers/fallback-expiry-harness.js";

/**
 * A primary still limited when a session's window on the fallback ends: the
 * probe turn falls back again with the new reset, the primary is still owed
 * everything it missed, and sessions that learn of the new reset from the
 * record do not each spend a turn finding it out.
 */

const { registry, reset, harness, turn, override } = await fallbackExpiryHarness("jinn-fallback-still-limited-");

beforeEach(reset);
afterEach(() => vi.useRealTimers());

describe("a session that went back to a primary still limited", () => {
  it("stays on the fallback when the primary is still limited at the reset, and re-checks at the new one", async () => {
    const firstReset = new Date(START.getTime() + HOUR);
    const secondReset = new Date(START.getTime() + 3 * HOUR);
    const { manager, claude, codex } = harness(
      [limitedUntil(firstReset), limitedUntil(secondReset), answer("claude is back", "claude-thread-2")],
      [answer("codex 1", "codex-thread"), answer("codex 2", "codex-thread"), answer("codex 3", "codex-thread")],
    );
    const key = "stub:expiry-still-limited";

    const id = await turn(manager, key, "first");
    expect(registry.getSession(id)!.engine).toBe("codex");

    // Past the first reset the primary is tried again — and is still limited, so the turn falls back once more.
    vi.setSystemTime(new Date(START.getTime() + 2 * HOUR));
    await turn(manager, key, "second");
    expect(runs(claude)).toBe(2);
    expect(runs(codex)).toBe(2);
    expect(registry.getSession(id)!.engine).toBe("codex");
    expect(Date.parse(String(override(id)!.until))).toBe(secondReset.getTime());

    // Before the second reset: no probe of the primary.
    vi.setSystemTime(new Date(START.getTime() + 2.5 * HOUR));
    await turn(manager, key, "third");
    expect(runs(claude)).toBe(2);
    expect(runs(codex)).toBe(3);

    // After it: back on the primary.
    vi.setSystemTime(new Date(START.getTime() + 4 * HOUR));
    await turn(manager, key, "fourth");
    expect(runs(claude)).toBe(3);
    expect(registry.getSession(id)!.engine).toBe("claude");
    expect(override(id)).toBeUndefined();
  }, 30_000);

});

describe("a primary still limited when a session first goes back to it", () => {
  it("still owes the primary everything since the session began, not only since the failed probe", async () => {
    const firstReset = new Date(START.getTime() + HOUR);
    const secondReset = new Date(START.getTime() + 4 * HOUR);
    const { manager, claude } = harness(
      [limitedUntil(firstReset), limitedUntil(secondReset), answer("claude is back", "claude-thread")],
      [answer("codex a", "codex-thread"), answer("codex b", "codex-thread"), answer("codex c", "codex-thread"), answer("codex d", "codex-thread")],
    );
    // An earlier session's limit puts the primary's allowance on record.
    await turn(manager, "stub:still-limited-earlier", "earlier");

    const key = "stub:still-limited-born";
    const id = await turn(manager, key, "BRIEF-MARKER");
    await turn(manager, key, "SECOND-MARKER");
    expect(registry.getSession(id)!.engine).toBe("codex");

    // The first probe back finds the primary still limited, and the turn falls back again.
    vi.setSystemTime(new Date(START.getTime() + 2 * HOUR));
    await turn(manager, key, "THIRD-MARKER");
    expect(registry.getSession(id)!.engine).toBe("codex");

    vi.setSystemTime(new Date(START.getTime() + 5 * HOUR));
    await turn(manager, key, "FOURTH-MARKER");
    expect(registry.getSession(id)!.engine).toBe("claude");
    const finalPrompt = claude.prompts.at(-1)!;
    for (const marker of ["BRIEF-MARKER", "SECOND-MARKER", "THIRD-MARKER", "FOURTH-MARKER"]) {
      expect(finalPrompt).toContain(marker);
    }
  }, 30_000);

  it("keeps other sessions on the fallback, without a probe each, once one probe has found it still limited", async () => {
    const firstReset = new Date(START.getTime() + HOUR);
    const secondReset = new Date(START.getTime() + 4 * HOUR);
    const { manager, claude, codex } = harness(
      [limitedUntil(firstReset), limitedUntil(secondReset), answer("claude is back", "claude-thread")],
      [answer("codex", "codex-thread")],
    );
    // A falls back mid-turn; B is created after that and starts on the fallback outright.
    const a = await turn(manager, "stub:probe-a", "a1");
    const b = await turn(manager, "stub:probe-b", "b1");
    expect(registry.getSession(a)!.engine).toBe("codex");
    expect(registry.getSession(b)!.engine).toBe("codex");
    expect(runs(claude)).toBe(1);

    // Past the first reset, A probes the primary and finds it limited until the second.
    vi.setSystemTime(new Date(START.getTime() + 2 * HOUR));
    await turn(manager, "stub:probe-a", "a2");
    expect(runs(claude)).toBe(2);
    expect(registry.getSession(a)!.engine).toBe("codex");

    // B's window has passed too, but the record A's probe left says the primary is spent: no second probe.
    const codexBefore = runs(codex);
    await turn(manager, "stub:probe-b", "b2");
    expect(runs(claude)).toBe(2);
    expect(runs(codex)).toBe(codexBefore + 1);
    expect(registry.getSession(b)!.engine).toBe("codex");
    expect(Date.parse(String(override(b)!.until))).toBe(secondReset.getTime());

    vi.setSystemTime(new Date(START.getTime() + 5 * HOUR));
    await turn(manager, "stub:probe-b", "b3");
    expect(runs(claude)).toBe(3);
    expect(registry.getSession(b)!.engine).toBe("claude");
  }, 30_000);
});

