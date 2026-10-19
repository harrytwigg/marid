import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { apiContext, eventually } from "./helpers/turn-parity-harness.js";
import {
  HOUR, MINUTE, START, answer, fallbackConfig as config, fallbackExpiryHarness, limitedUntil, runs,
} from "./helpers/fallback-expiry-harness.js";

/**
 * A fallback taken because the primary engine ran out of allowance is temporary.
 * Every session moved onto a stand-in — mid-turn, or at creation because the
 * primary was already known to be spent — carries the moment its primary
 * reopens, and the first turn after that moment runs on the primary again.
 * The primary still being limited then is covered in engine-fallback-still-limited.
 */

const { healthPath: HEALTH_PATH, registry, reset, harness, settled, turn, override } = await fallbackExpiryHarness("jinn-fallback-expiry-");

let dispatchWebSessionRun: typeof import("../../gateway/web-session-dispatch.js").dispatchWebSessionRun;
let readEngineHealth: typeof import("../../shared/engine-health.js").readEngineHealth;
let validateNewSessionSelection: typeof import("../session-patch.js").validateNewSessionSelection;
let reroutedSessionMeta: typeof import("../engine-override-window.js").reroutedSessionMeta;

beforeAll(async () => {
  [{ dispatchWebSessionRun }, { readEngineHealth }, { validateNewSessionSelection }, { reroutedSessionMeta }] = await Promise.all([
    import("../../gateway/web-session-dispatch.js"),
    import("../../shared/engine-health.js"),
    import("../session-patch.js"),
    import("../engine-override-window.js"),
  ]);
});

beforeEach(reset);
afterEach(() => vi.useRealTimers());

describe("a session the primary's usage limit moved onto the fallback mid-turn", () => {
  it("answers on the fallback, then on the primary again at the first turn after the reset", async () => {
    const reset = new Date(START.getTime() + HOUR);
    const { manager, claude, codex } = harness([limitedUntil(reset), answer("claude is back", "claude-thread-2")]);
    const key = "stub:expiry-mid-turn";

    const id = await turn(manager, key, "first");
    expect(runs(claude)).toBe(1);
    expect(runs(codex)).toBe(1);
    expect(registry.getSession(id)!.engine).toBe("codex");
    expect(override(id)).toMatchObject({ originalEngine: "claude", originalModel: "opus" });
    expect(Date.parse(String(override(id)!.until))).toBe(reset.getTime());

    // Before the reset: the next turn stays on the fallback.
    vi.setSystemTime(new Date(START.getTime() + 30 * MINUTE));
    await turn(manager, key, "second");
    expect(runs(codex)).toBe(2);
    expect(runs(claude)).toBe(1);
    expect(registry.getSession(id)!.engine).toBe("codex");

    // After the reset: the primary answers, on its own pin, with nothing left over.
    vi.setSystemTime(new Date(START.getTime() + 2 * HOUR));
    await turn(manager, key, "third");
    expect(runs(claude)).toBe(2);
    expect(runs(codex)).toBe(2);
    const back = registry.getSession(id)!;
    expect(back.engine).toBe("claude");
    expect(back.model).toBe("opus");
    expect(override(id)).toBeUndefined();
  }, 30_000);


  it("goes back to the primary on a web-dispatched turn too, whatever engine the dispatcher resolved", async () => {
    const reset = new Date(START.getTime() + HOUR);
    const { manager, claude, codex, cfg } = harness([limitedUntil(reset), answer("claude is back", "claude-thread-2")]);
    const id = await turn(manager, "stub:expiry-web", "first");
    expect(registry.getSession(id)!.engine).toBe("codex");

    vi.setSystemTime(new Date(START.getTime() + 2 * HOUR));
    // A Todo wake, a delegation into a live session or a send_to_session resolve
    // the engine from the row as it stood — still codex — and dispatch with it.
    const stale = registry.getSession(id)!;
    registry.insertMessage(id, "user", "second");
    dispatchWebSessionRun(stale, "second", codex as never, apiContext(manager, cfg) as never);
    await eventually(() => runs(claude) === 2 && settled(id));
    expect(runs(codex)).toBe(1);
    expect(registry.getSession(id)!.engine).toBe("claude");
    expect(override(id)).toBeUndefined();
  }, 30_000);
});

describe("a new session started while the primary is out of allowance", () => {
  it("starts on the fallback with the primary's reopening recorded, and goes back to the primary after it", async () => {
    const reset = new Date(START.getTime() + HOUR);
    // An earlier session's limit is what put the primary's allowance on record.
    const { manager, claude, codex } = harness([limitedUntil(reset), answer("claude answer", "claude-thread")]);
    await turn(manager, "stub:expiry-earlier", "earlier");
    expect(readEngineHealth().claude?.state).toBe("exhausted");
    const claudeRunsBefore = runs(claude);

    const key = "stub:expiry-born-on-fallback";
    const id = await turn(manager, key, "first");
    expect(runs(claude)).toBe(claudeRunsBefore);
    expect(registry.getSession(id)!.engine).toBe("codex");
    expect(override(id)).toMatchObject({ originalEngine: "claude", originalModel: "opus", originalEngineSessionId: null });
    expect(Date.parse(String(override(id)!.until))).toBe(reset.getTime());

    vi.setSystemTime(new Date(START.getTime() + 2 * HOUR));
    await turn(manager, key, "second");
    expect(runs(claude)).toBe(claudeRunsBefore + 1);
    const back = registry.getSession(id)!;
    expect(back.engine).toBe("claude");
    expect(back.model).toBe("opus");
    expect(override(id)).toBeUndefined();
    expect(runs(codex)).toBe(2);
  }, 30_000);

  it("starts on the primary when it is created after the reset", async () => {
    const reset = new Date(START.getTime() + HOUR);
    const { manager, claude } = harness([limitedUntil(reset), answer("claude answer", "claude-thread")]);
    await turn(manager, "stub:expiry-earlier-2", "earlier");
    expect(readEngineHealth().claude?.state).toBe("exhausted");

    vi.setSystemTime(new Date(START.getTime() + 2 * HOUR));
    const id = await turn(manager, "stub:expiry-after-reset", "first");
    expect(registry.getSession(id)!.engine).toBe("claude");
    expect(registry.getSession(id)!.model).toBe("opus");
    expect(override(id)).toBeUndefined();
    expect(runs(claude)).toBe(2);
  }, 30_000);

  it("reports the reroute from validateNewSessionSelection, and reroutedSessionMeta turns it into an expiring override", () => {
    const reset = new Date(START.getTime() + HOUR);
    fs.mkdirSync(path.dirname(HEALTH_PATH), { recursive: true });
    fs.writeFileSync(HEALTH_PATH, JSON.stringify({
      claude: { state: "exhausted", until: reset.toISOString(), recheckAt: reset.toISOString(), reason: "quota window spent" },
    }));

    const selection = validateNewSessionSelection(config(), {}, { engine: "claude", model: "opus" });
    expect(selection).toMatchObject({ ok: true, engine: "codex", reroute: { from: "claude", model: "opus" } });
    expect(selection.reroute!.until.getTime()).toBe(reset.getTime());

    const meta = reroutedSessionMeta(selection.reroute, { kept: true })!;
    expect(meta).toEqual({
      kept: true,
      engineOverride: {
        originalEngine: "claude",
        originalEngineSessionId: null,
        originalModel: "opus",
        until: reset.toISOString(),
        syncSince: START.toISOString(),
        // The chain link the session started on, as a mid-turn swap records it.
        substituteTarget: { engine: "codex" },
      },
      // The run starts at that link: the next limit moves on from it, never back to the target it left.
      fallbackRun: { source: "engine", position: 1, tried: ["claude||opus"], startedAt: START.toISOString() },
    });
  });

  it("is not rerouted, and carries no expiry, while the primary is healthy", () => {
    const selection = validateNewSessionSelection(config(), {}, { engine: "claude", model: "opus" });
    expect(selection).toEqual({ ok: true, engine: "claude", model: "opus", effortLevel: undefined });
    expect(reroutedSessionMeta(selection.reroute)).toBeUndefined();
  });
});

