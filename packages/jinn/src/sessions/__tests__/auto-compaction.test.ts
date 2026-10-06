import { describe, expect, it } from "vitest";
import type { JinnConfig, Session } from "../../shared/types.js";
import { AUTO_COMPACT_BUDGET_HOLD_KEY } from "../../shared/auto-compact-config.js";
import {
  autoCompactDoneNotice,
  autoCompactFailedNotice,
  autoCompactStatus,
  budgetRearmTokens,
  buildAutoCompactCommand,
  decideAutoCompaction,
  holdAfterCompaction,
  lastEngineActivityMs,
  readBudgetHold,
  type AutoCompactInput,
} from "../auto-compaction.js";

/** Auto-compaction: the pure decision — when a turn compacts its session first. */

const NOW = Date.parse("2026-09-29T12:00:00Z");
const MINUTE = 60_000;
const iso = (ms: number) => new Date(ms).toISOString();

function config(engine: "claude" | "opencode", autoCompact: Record<string, unknown> | undefined, opencodeMode = "server"): JinnConfig {
  return {
    engines: {
      default: "claude",
      claude: engine === "claude" ? { autoCompact } : {},
      opencode: { mode: opencodeMode, ...(engine === "opencode" ? { autoCompact } : {}) },
    },
  } as unknown as JinnConfig;
}

function session(engine: string, over: Partial<Session> = {}, idleMs = 30 * MINUTE): Session {
  return {
    id: "s1", engine, status: "running", lastContextTokens: 150_000, transportMeta: null,
    engineSessions: { [engine]: { id: `${engine}-1`, lastSyncedAt: iso(NOW - idleMs) } },
    ...over,
  } as unknown as Session;
}

const ON = { enabled: true, cacheWindowSeconds: 300, minContextTokens: 100_000 };

function input(over: Partial<AutoCompactInput> = {}): AutoCompactInput {
  return {
    config: config("claude", ON), session: session("claude"), engine: "claude", opencodeMode: "server",
    prompt: "carry on", compactionTurn: false, syncRequested: false, now: NOW, ...over,
  };
}

describe("decideAutoCompaction", () => {
  it("compacts a long session idle past its cache window", () => {
    expect(decideAutoCompaction(input())).toEqual({ compact: true, trigger: "cold", contextTokens: 150_000, idleMs: 30 * MINUTE, policy: ON });
  });

  it("compacts at exactly the thresholds", () => {
    const decision = decideAutoCompaction(input({ session: session("claude", { lastContextTokens: 100_000 }, 5 * MINUTE) }));
    expect(decision.compact).toBe(true);
  });

  it.each([
    ["disabled by default", { config: config("claude", undefined) }, "disabled"],
    ["explicitly disabled", { config: config("claude", { ...ON, enabled: false }) }, "disabled"],
    ["an engine with no compaction", { engine: "codex", session: session("codex") }, "disabled"],
    ["opencode in run mode", { config: config("opencode", ON), engine: "opencode", session: session("opencode"), opencodeMode: "run" }, "opencode-run-mode"],
    ["a compaction turn", { compactionTurn: true }, "compaction-turn"],
    ["another native command", { prompt: "/clear" }, "raw-command"],
    ["an engine-switch turn", { syncRequested: true }, "engine-switch"],
    ["no conversation yet", { session: session("claude", { engineSessions: {} }) }, "no-engine-session"],
    ["an unread meter", { session: session("claude", { lastContextTokens: null }) }, "context-unknown"],
    ["a short session", { session: session("claude", { lastContextTokens: 99_999 }) }, "context-small"],
    ["no record of activity", { session: session("claude", { engineSessions: { claude: { id: "c-1" } } }) }, "activity-unknown"],
    ["a warm cache", { session: session("claude", {}, 5 * MINUTE - 1) }, "cache-warm"],
  ])("leaves %s alone", (_label, over, skip) => {
    expect(decideAutoCompaction(input(over as Partial<AutoCompactInput>))).toEqual({ compact: false, skip });
  });

  it("decides opencode on opencode's own policy", () => {
    const cfg = config("opencode", { enabled: true, cacheWindowSeconds: 3600 });
    const cold = decideAutoCompaction(input({ config: cfg, engine: "opencode", session: session("opencode", {}, 61 * MINUTE) }));
    const warm = decideAutoCompaction(input({ config: cfg, engine: "opencode", session: session("opencode", {}, 30 * MINUTE) }));
    expect(cold.compact).toBe(true);
    expect(warm).toEqual({ compact: false, skip: "cache-warm" });
  });
});

describe("decideAutoCompaction — the context budget", () => {
  const BUDGET = { ...ON, maxContextTokens: 300_000 };
  const held = (floor: number | null, engine = "opencode") => ({ transportMeta: { [AUTO_COMPACT_BUDGET_HOLD_KEY]: { floor, engine } } as never });
  const opencode = (over: Partial<Session>, idleMs = MINUTE, policy: Record<string, unknown> = BUDGET) => input({
    config: config("opencode", policy), engine: "opencode", session: session("opencode", over, idleMs),
  });

  it("compacts a warm session whose context has reached the budget", () => {
    expect(decideAutoCompaction(opencode({ lastContextTokens: 300_000 })))
      .toEqual({ compact: true, trigger: "budget", contextTokens: 300_000, budgetTokens: 300_000, policy: BUDGET });
  });

  it("leaves a warm session under the budget to the cache", () => {
    expect(decideAutoCompaction(opencode({ lastContextTokens: 299_999 }))).toEqual({ compact: false, skip: "cache-warm" });
  });

  it("leaves a warm session alone without a budget, however long", () => {
    expect(decideAutoCompaction(opencode({ lastContextTokens: 900_000 }, MINUTE, ON))).toEqual({ compact: false, skip: "cache-warm" });
  });

  it("compacts a cold session as cold, budget or not", () => {
    expect(decideAutoCompaction(opencode({ lastContextTokens: 400_000 }, 30 * MINUTE))).toMatchObject({ compact: true, trigger: "cold" });
  });

  it("does not need a record of activity, nor the cold-cache floor", () => {
    expect(decideAutoCompaction(opencode({ lastContextTokens: 400_000, engineSessions: { opencode: { id: "o-1" } } as never })))
      .toMatchObject({ compact: true, trigger: "budget" });
    expect(decideAutoCompaction(opencode({ lastContextTokens: 60_000 }, MINUTE, { ...ON, maxContextTokens: 50_000 })))
      .toMatchObject({ compact: true, trigger: "budget", budgetTokens: 50_000 });
  });

  it("still needs auto-compaction enabled, an engine that can compact, and a read meter", () => {
    expect(decideAutoCompaction(opencode({ lastContextTokens: 400_000 }, MINUTE, { ...BUDGET, enabled: false }))).toEqual({ compact: false, skip: "disabled" });
    expect(decideAutoCompaction({ ...opencode({ lastContextTokens: 400_000 }), opencodeMode: "run" })).toEqual({ compact: false, skip: "opencode-run-mode" });
    expect(decideAutoCompaction(opencode({ lastContextTokens: null }))).toEqual({ compact: false, skip: "context-unknown" });
  });

  it("holds the budget at a floor until the context grows a quarter of the budget past it", () => {
    // Landed at 310k against a 300k budget: re-arms at 310k + 75k.
    expect(budgetRearmTokens(300_000, 310_000)).toBe(385_000);
    expect(decideAutoCompaction(opencode({ lastContextTokens: 384_999, ...held(310_000) }))).toEqual({ compact: false, skip: "budget-held" });
    expect(decideAutoCompaction(opencode({ lastContextTokens: 385_000, ...held(310_000) })))
      .toEqual({ compact: true, trigger: "budget", contextTokens: 385_000, budgetTokens: 300_000, policy: BUDGET, holdUpdate: null });
    // A floor under the budget re-arms from the budget.
    expect(budgetRearmTokens(300_000, 60_000)).toBe(375_000);
  });

  it("fills a pending floor from the first reading after the compaction", () => {
    expect(decideAutoCompaction(opencode({ lastContextTokens: 310_000, ...held(null) })))
      .toEqual({ compact: false, skip: "budget-held", holdUpdate: { floor: 310_000, engine: "opencode" } });
  });

  it("lowers the floor to a lower reading still over the budget, and re-arms from there", () => {
    // A manual or the engine's own compaction took a session held at 600k down to 320k.
    expect(decideAutoCompaction(opencode({ lastContextTokens: 320_000, ...held(600_000) })))
      .toEqual({ compact: false, skip: "budget-held", holdUpdate: { floor: 320_000, engine: "opencode" } });
    expect(decideAutoCompaction(opencode({ lastContextTokens: 400_000, ...held(320_000) })))
      .toMatchObject({ compact: true, trigger: "budget", holdUpdate: null });
  });

  it("ignores, and lifts, a hold another engine's compaction left", () => {
    expect(decideAutoCompaction(opencode({ lastContextTokens: 320_000, ...held(310_000, "claude") })))
      .toMatchObject({ compact: true, trigger: "budget", holdUpdate: null });
  });

  it("lifts the hold on a reading under the budget, or when there is no budget", () => {
    expect(decideAutoCompaction(opencode({ lastContextTokens: 290_000, ...held(310_000) }))).toEqual({ compact: false, skip: "cache-warm", holdUpdate: null });
    expect(decideAutoCompaction(opencode({ lastContextTokens: 290_000, ...held(null) }))).toEqual({ compact: false, skip: "cache-warm", holdUpdate: null });
    expect(decideAutoCompaction(opencode({ lastContextTokens: 900_000, ...held(310_000) }, MINUTE, ON))).toEqual({ compact: false, skip: "cache-warm", holdUpdate: null });
  });

  it("leaves the hold alone on a turn it does not decide, and to a cold compaction", () => {
    expect(decideAutoCompaction({ ...opencode({ lastContextTokens: 290_000, ...held(310_000) }), compactionTurn: true }))
      .toEqual({ compact: false, skip: "compaction-turn" });
    expect(decideAutoCompaction({ ...opencode({ lastContextTokens: 290_000, ...held(310_000) }), syncRequested: true }))
      .toEqual({ compact: false, skip: "engine-switch" });
    expect(decideAutoCompaction(opencode({ lastContextTokens: 320_000, ...held(310_000) }, 30 * MINUTE))).not.toHaveProperty("holdUpdate");
  });
});

describe("the budget hold", () => {
  const policy = { ...ON, maxContextTokens: 300_000 };

  it("is left only by a compaction that did not get under the budget", () => {
    expect(holdAfterCompaction(policy, "claude", 60_000)).toBeNull();
    expect(holdAfterCompaction(policy, "claude", 310_000)).toEqual({ floor: 310_000, engine: "claude" });
    expect(holdAfterCompaction(policy, "opencode", undefined)).toEqual({ floor: null, engine: "opencode" });
    expect(holdAfterCompaction({ ...ON }, "claude", 310_000)).toBeNull();
  });

  it("reads a floor, a pending floor, or nothing", () => {
    const meta = (value: unknown) => ({ transportMeta: { [AUTO_COMPACT_BUDGET_HOLD_KEY]: value } }) as never;
    expect(readBudgetHold(meta({ floor: 310_000, engine: "claude" }))).toEqual({ floor: 310_000, engine: "claude" });
    expect(readBudgetHold(meta({ floor: null, engine: "opencode" }))).toEqual({ floor: null, engine: "opencode" });
    expect(readBudgetHold(meta(true))).toBeUndefined();
    expect(readBudgetHold({ transportMeta: null } as never)).toBeUndefined();
  });
});

describe("lastEngineActivityMs", () => {
  it("counts a turn typed into Claude's terminal as activity", () => {
    const s = session("claude", { transportMeta: { transcriptActivityAt: iso(NOW - MINUTE) } as never });
    expect(lastEngineActivityMs(s, "claude")).toBe(NOW - MINUTE);
  });

  it("does not count the transcript sync anchor, which a failed turn moves too", () => {
    const s = session("claude", { transportMeta: { transcriptSyncedThrough: iso(NOW - MINUTE) } as never });
    expect(lastEngineActivityMs(s, "claude")).toBe(NOW - 30 * MINUTE);
  });

  it("reads only the engine asked about", () => {
    const s = session("claude", { engineSessions: { opencode: { id: "o", lastSyncedAt: iso(NOW - MINUTE) } } as never });
    expect(lastEngineActivityMs(s, "claude")).toBeUndefined();
  });
});

describe("the words", () => {
  it("builds a one-line /compact naming in-flight children", () => {
    const command = buildAutoCompactCommand([{ id: "child-1", employee: "junior-developer" }, { id: "child-2", employee: null }]);
    expect(command).toMatch(/^\/compact Automatic compaction: /);
    expect(command).not.toMatch(/\n/);
    expect(command).toContain("still in flight, whose results will arrive after this: child-1 (junior-developer), child-2.");
  });

  it("caps the child list", () => {
    const children = Array.from({ length: 11 }, (_, i) => ({ id: `c${i}`, employee: null }));
    expect(buildAutoCompactCommand(children)).toContain("c7 and 3 more.");
  });

  it("says what the compaction did", () => {
    const decision = { compact: true as const, trigger: "cold" as const, contextTokens: 150_000, idleMs: 125 * MINUTE, policy: ON };
    expect(autoCompactDoneNotice(decision, { preTokens: 151_000, postTokens: 8_000 }))
      .toBe("🗜️ Auto-compacted this cold session before the next message (151k tokens → 8.0k tokens; idle 2h 5m, past the 5m cache window).");
    expect(autoCompactDoneNotice(decision, {})).toContain("(it was 150k tokens;");
    expect(autoCompactFailedNotice("x".repeat(500)).length).toBeLessThan(320);
  });

  it("says when the budget, not the cache, was the reason", () => {
    const decision = { compact: true as const, trigger: "budget" as const, contextTokens: 320_000, budgetTokens: 300_000, policy: ON };
    expect(buildAutoCompactCommand([], "budget")).toMatch(/^\/compact Automatic compaction: this session's context has passed its budget and a new message is waiting/);
    expect(autoCompactStatus(decision)).toBe("🗜️ Session at 320k tokens of context (past its budget of 300k tokens) — compacting it before the next message…");
    expect(autoCompactDoneNotice(decision, { preTokens: 321_000 }))
      .toBe("🗜️ Auto-compacted this session before the next message (it was 321k tokens; past its context budget of 300k tokens).");
    expect(autoCompactFailedNotice("boom", "budget")).toBe("⚠️ Auto-compaction of this session didn't complete (boom), so the next message runs on the full context.");
  });
});
