import { describe, expect, it } from "vitest";
import type { EngineLimitEngineSnapshot } from "../types.js";
import { evaluateIdleCapacity, formatMinutes, resolveIdleCapacityPolicy, type IdleCapacityVerdict } from "../idle-capacity.js";
import { formatStartNote, parseMinutes, parseStartNote } from "../idle-capacity-record.js";

// The round trip is built from a REAL verdict, never a hand-typed sentence: the
// window grammar the parser inverts lives in shared/idle-capacity.ts, and a
// reword there is exactly what these tests exist to catch (FR-006).

const NOW = Date.parse("2026-09-20T10:00:00Z");
const minutes = (n: number): number => Math.floor((NOW + n * 60_000) / 1000);
const policy = resolveIdleCapacityPolicy({ enabled: true });

function snapshot(windows: Array<{ name: string; usedPercent: number; resetsAt: number }>): EngineLimitEngineSnapshot {
  return { name: "claude", available: true, status: "live", source: "test", refreshedAt: new Date(NOW).toISOString(), models: [], windows };
}

function actVerdict(
  windows: Array<{ name: string; usedPercent: number; resetsAt: number }>,
  tier: "overnight" | "daytime" | "interactive" = "overnight",
): Extract<IdleCapacityVerdict, { act: true }> {
  const verdict = evaluateIdleCapacity(snapshot(windows), tier, policy, NOW);
  if (!verdict.act) throw new Error(`expected an act verdict, got: ${verdict.reason}`);
  return verdict;
}

describe("formatStartNote / parseStartNote", () => {
  it("round-trips a five-hour start with a per-model weekly bucket", () => {
    const verdict = actVerdict([
      { name: "5h", usedPercent: 13, resetsAt: minutes(40) },
      { name: "7d", usedPercent: 68, resetsAt: minutes(2 * 24 * 60 + 3 * 60) },
      { name: "7d Fable", usedPercent: 0, resetsAt: minutes(2 * 24 * 60 + 3 * 60) },
    ]);
    const body = formatStartNote({ verdict, sessionId: "sess-1", charged: 1, cap: 3 });
    expect(body).toBe(
      "Idle-capacity auto-start: overnight tier, five-hour window about to lapse: 5h 13% used, resets in 40 min; " +
      "7d 68% used, resets in 2 d 3 h; 7d Fable 0% used, resets in 2 d 3 h. " +
      "Started the Todo Dispatcher (session sess-1) to use capacity that would otherwise lapse; 1 of 3 for this five-hour window.",
    );
    expect(parseStartNote(body)).toEqual({
      partial: false,
      tier: "overnight",
      trigger: "5h",
      fiveHour: { name: "5h", usedPercent: 13, minutesToReset: 40 },
      weekly: [
        { name: "7d", usedPercent: 68, minutesToReset: 2 * 24 * 60 + 3 * 60 },
        { name: "7d Fable", usedPercent: 0, minutesToReset: 2 * 24 * 60 + 3 * 60 },
      ],
      sessionId: "sess-1",
      charged: 1,
      cap: 3,
    });
  });

  it("round-trips a weekly-trigger start, with hours-and-minutes readings", () => {
    const verdict = actVerdict([
      { name: "5h", usedPercent: 20, resetsAt: minutes(4 * 60 + 5) },
      { name: "7d", usedPercent: 40, resetsAt: minutes(23 * 60) },
    ], "daytime");
    expect(verdict.trigger).toBe("7d");
    const parsed = parseStartNote(formatStartNote({ verdict, sessionId: "s", charged: 2, cap: 2 }));
    expect(parsed).toMatchObject({ partial: false, tier: "daytime", trigger: "7d", charged: 2, cap: 2 });
    expect(parsed.fiveHour).toEqual({ name: "5h", usedPercent: 20, minutesToReset: 4 * 60 + 5 });
    expect(parsed.weekly).toEqual([{ name: "7d", usedPercent: 40, minutesToReset: 23 * 60 }]);
  });

  it("recovers what it can from a hand-edited comment and says so", () => {
    const parsed = parseStartNote("Edited: overnight tier fired here. 5h 13% used, resets in 40 min (session abc) — 1 of 3 for this five-hour window.");
    expect(parsed.partial).toBe(true);
    expect(parsed).toMatchObject({ tier: "overnight", sessionId: "abc", charged: 1, cap: 3 });
    expect(parsed.fiveHour).toEqual({ name: "5h", usedPercent: 13, minutesToReset: 40 });
    expect(parsed.trigger).toBeUndefined();
  });

  it("marks a body from another author or an unknown build as partial with nothing recovered", () => {
    expect(parseStartNote("Looks fine to me.")).toEqual({ partial: true, weekly: [] });
  });
});

describe("parseMinutes inverts formatMinutes", () => {
  it.each([-3, 0, 40, 59, 60, 61, 125, 24 * 60, 24 * 60 + 60, 2 * 24 * 60 + 3 * 60])("for %i minutes", (value) => {
    // A day or more drops the minutes; everything under keeps them exactly.
    const expected = value >= 24 * 60 ? value - (value % 60) : value;
    expect(parseMinutes(formatMinutes(value))).toBe(expected);
  });

  it("refuses shapes formatMinutes never produces", () => {
    expect(parseMinutes("soon")).toBeUndefined();
    expect(parseMinutes("2 h 3")).toBeUndefined();
  });
});
