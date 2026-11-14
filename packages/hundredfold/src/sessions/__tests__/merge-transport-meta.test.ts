import { describe, it, expect, vi } from "vitest";

/**
 * Regression test for mergeTransportMeta() in ../manager.ts.
 *
 * The rate-limit onRetrySuccess path used to write `transportMeta:
 * msg.transportMeta ?? null` — a raw overwrite that destroyed internal
 * bookkeeping (engineOverride), so a session that fell back to another engine
 * during a rate limit could never revert. Every update path now goes through
 * mergeTransportMeta; this locks in its semantics.
 *
 * Engine thread ids are deliberately absent: they live in the typed
 * engineSessions column, which no connector merge can reach.
 */

vi.mock("../../shared/logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { mergeTransportMeta } from "../manager.js";

describe("mergeTransportMeta", () => {
  it("keeps existing meta when incoming is undefined (no wipe)", () => {
    const existing = { channelName: "general", claudeSyncSince: "2026-06-10T00:00:00Z" } as any;
    expect(mergeTransportMeta(existing, undefined)).toEqual(existing);
  });

  it("merges incoming transport keys over existing ones", () => {
    const merged = mergeTransportMeta(
      { channelName: "old", threadTs: "1" } as any,
      { channelName: "new" } as any,
    ) as Record<string, unknown>;
    expect(merged.channelName).toBe("new");
    expect(merged.threadTs).toBe("1");
  });

  it("preserves internal bookkeeping keys against incoming overwrites", () => {
    const existing = {
      engineOverride: { originalEngine: "claude", until: "2099-01-01T00:00:00Z" },
      claudeSyncSince: "2026-06-10T00:00:00Z",
      delegationCompletionTracked: true,
      delegationCompletionContract: { workItemId: "wi-live", state: "nudged" },
      autoCompactBudgetHold: { floor: 310_000 },
    } as any;
    const incoming = {
      autoCompactBudgetHold: null,
      engineOverride: null,
      claudeSyncSince: "stomped",
      delegationCompletionTracked: false,
      delegationCompletionContract: null,
      channelName: "general",
    } as any;

    const merged = mergeTransportMeta(existing, incoming) as Record<string, unknown>;
    expect(merged.engineOverride).toEqual(existing.engineOverride);
    expect(merged.claudeSyncSince).toBe("2026-06-10T00:00:00Z");
    expect(merged.delegationCompletionTracked).toBe(true);
    expect(merged.delegationCompletionContract).toEqual(existing.delegationCompletionContract);
    expect(merged.autoCompactBudgetHold).toEqual({ floor: 310_000 });
    expect(merged.channelName).toBe("general");
  });

  it("handles both sides empty", () => {
    expect(mergeTransportMeta(null, undefined)).toEqual({});
  });
});
