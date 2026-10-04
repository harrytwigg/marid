import { describe, expect, it } from "vitest";
import type { JinnConfig, Session } from "../../shared/types.js";
import {
  autoCompactDoneNotice,
  autoCompactFailedNotice,
  buildAutoCompactCommand,
  decideAutoCompaction,
  lastEngineActivityMs,
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
    expect(decideAutoCompaction(input())).toEqual({ compact: true, contextTokens: 150_000, idleMs: 30 * MINUTE, policy: ON });
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
    const decision = { compact: true as const, contextTokens: 150_000, idleMs: 125 * MINUTE, policy: ON };
    expect(autoCompactDoneNotice(decision, { preTokens: 151_000, postTokens: 8_000 }))
      .toBe("🗜️ Auto-compacted this cold session before the next message (151k tokens → 8.0k tokens; idle 2h 5m, past the 5m cache window).");
    expect(autoCompactDoneNotice(decision, {})).toContain("(it was 150k tokens;");
    expect(autoCompactFailedNotice("x".repeat(500)).length).toBeLessThan(320);
  });
});
