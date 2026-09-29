import { describe, expect, it } from "vitest";
import type { EngineLimitEngineSnapshot } from "../types.js";
import {
  IDLE_CAPACITY_DEFAULTS,
  evaluateIdleCapacity,
  fiveHourReading,
  isQuietHour,
  idleCapacityProblems,
  resolveIdleCapacityPolicy,
  selectTier,
} from "../idle-capacity.js";

// 10:00 UTC on a September Sunday is 11:00 in Europe/London (BST).
const NOW = Date.parse("2026-09-20T10:00:00Z");
const minutes = (n: number): number => Math.floor((NOW + n * 60_000) / 1000);
const at = (iso: string): number => Date.parse(iso);

function snapshot(
  windows: Array<{ name: string; usedPercent?: number; resetsAt?: number }>,
  extra: Partial<EngineLimitEngineSnapshot> = {},
): EngineLimitEngineSnapshot {
  return {
    name: "claude",
    available: true,
    status: "live",
    source: "claude oauth usage api",
    refreshedAt: new Date(NOW).toISOString(),
    models: [],
    windows,
    ...extra,
  };
}

const policy = resolveIdleCapacityPolicy({ enabled: true });
const evaluate = (
  windows: Parameters<typeof snapshot>[0],
  tier: "overnight" | "daytime" | "interactive" = "daytime",
  extra: Partial<EngineLimitEngineSnapshot> = {},
) => evaluateIdleCapacity(snapshot(windows, extra), tier, policy, NOW);

describe("resolveIdleCapacityPolicy", () => {
  it("is off by default and fills every knob from the defaults", () => {
    expect(resolveIdleCapacityPolicy(undefined)).toEqual(IDLE_CAPACITY_DEFAULTS);
  });

  it("merges partial tiers and windows over the defaults, tier by tier", () => {
    const resolved = resolveIdleCapacityPolicy({
      enabled: true,
      quietHours: { start: "23:00" },
      tiers: { overnight: { fiveHour: { maxUsedPercent: 90 }, maxDispatchesPerWindow: 5 }, interactive: { enabled: false } },
      requireLabel: "idle-ok",
    });
    expect(resolved.quietHours).toEqual({ start: "23:00", end: IDLE_CAPACITY_DEFAULTS.quietHours.end });
    expect(resolved.tiers.overnight).toEqual({
      ...IDLE_CAPACITY_DEFAULTS.tiers.overnight,
      fiveHour: { ...IDLE_CAPACITY_DEFAULTS.tiers.overnight.fiveHour, maxUsedPercent: 90 },
      maxDispatchesPerWindow: 5,
    });
    expect(resolved.tiers.daytime).toEqual(IDLE_CAPACITY_DEFAULTS.tiers.daytime);
    expect(resolved.tiers.interactive).toEqual({ ...IDLE_CAPACITY_DEFAULTS.tiers.interactive, enabled: false });
    expect(resolved.requireLabel).toBe("idle-ok");
    // An explicit null clears the label requirement rather than falling back.
    expect(resolveIdleCapacityPolicy({ requireLabel: null }).requireLabel).toBeNull();
  });
});

describe("idleCapacityProblems", () => {
  it("accepts unset and a well-formed mapping", () => {
    expect(idleCapacityProblems(undefined)).toEqual([]);
    expect(idleCapacityProblems({
      enabled: true, intervalMinutes: 5, timezone: "Europe/London",
      quietHours: { start: "22:30", end: "06:00" }, operatorActivity: { idleMinutes: 20, usageDeltaPercent: 1 },
      tiers: { overnight: { enabled: true, fiveHour: { maxUsedPercent: 90, lookaheadMinutes: 300 }, maxDispatchesPerWindow: 4, maxActiveSessions: 2 } },
      requireLabel: "idle-ok",
    })).toEqual([]);
  });

  it("names every malformed key", () => {
    expect(idleCapacityProblems({
      enabled: "yes", intervalMinutes: 0, timezone: "Mars/Olympus", requireLabel: "*",
      quietHours: { start: "1am", end: "06:00" }, operatorActivity: { idleMinutes: 1.5, usageDeltaPercent: 0 },
      tiers: { evening: {}, daytime: { fiveHour: { maxUsedPercent: 140 }, sevenDay: [] }, interactive: { enabled: 1 } },
    })).toEqual([
      "gateway.idleCapacity.enabled must be a boolean (got string)",
      "gateway.idleCapacity.intervalMinutes must be a whole number of at least 1 (got 0)",
      'gateway.idleCapacity.timezone is not a time zone this runtime knows (got "Mars/Olympus")',
      "gateway.idleCapacity.requireLabel must be a label name with at least one letter or digit, or null",
      'gateway.idleCapacity.quietHours.start must be a time of day as HH:MM (got "1am")',
      "gateway.idleCapacity.operatorActivity.idleMinutes must be a whole number of at least 1 (got 1.5)",
      "gateway.idleCapacity.operatorActivity.usageDeltaPercent must be a number between 1 and 100 (got 0)",
      "gateway.idleCapacity.tiers has unknown tier evening (tiers are overnight, daytime, interactive)",
      "gateway.idleCapacity.tiers.daytime.fiveHour.maxUsedPercent must be a number between 0 and 100 (got 140)",
      "gateway.idleCapacity.tiers.daytime.sevenDay must be a mapping",
      "gateway.idleCapacity.tiers.interactive.enabled must be a boolean (got number)",
    ]);
    expect(idleCapacityProblems([])).toEqual(["gateway.idleCapacity must be a mapping"]);
  });
});

describe("tier selection", () => {
  it("reads the quiet hours in the configured zone, wrapping midnight when asked", () => {
    expect(isQuietHour(at("2026-09-20T02:30:00+01:00"), policy)).toBe(true);
    expect(isQuietHour(at("2026-09-20T06:00:00+01:00"), policy)).toBe(false); // end is exclusive
    expect(isQuietHour(at("2026-09-20T00:59:00+01:00"), policy)).toBe(false);
    // 01:00 London is 00:00 UTC — the zone, not the host clock, decides.
    expect(isQuietHour(at("2026-09-20T00:00:00Z"), policy)).toBe(true);
    const wrapped = resolveIdleCapacityPolicy({ quietHours: { start: "22:00", end: "06:00" } });
    expect(isQuietHour(at("2026-09-20T23:00:00+01:00"), wrapped)).toBe(true);
    expect(isQuietHour(at("2026-09-20T05:00:00+01:00"), wrapped)).toBe(true);
    expect(isQuietHour(at("2026-09-20T12:00:00+01:00"), wrapped)).toBe(false);
    expect(isQuietHour(NOW, resolveIdleCapacityPolicy({ quietHours: { start: "03:00", end: "03:00" } }))).toBe(false);
  });

  it("puts the operator being live above the clock", () => {
    const night = at("2026-09-20T03:00:00+01:00");
    expect(selectTier({ nowMs: night, operatorActive: false }, policy)).toBe("overnight");
    expect(selectTier({ nowMs: night, operatorActive: true }, policy)).toBe("interactive");
    expect(selectTier({ nowMs: NOW, operatorActive: false }, policy)).toBe("daytime");
    expect(selectTier({ nowMs: NOW, operatorActive: true }, policy)).toBe("interactive");
  });
});

describe("evaluateIdleCapacity", () => {
  const healthyWeek = { name: "7d", usedPercent: 40, resetsAt: minutes(3 * 24 * 60) };

  it("acts when the five-hour window is about to lapse under the tier's ceiling", () => {
    const verdict = evaluate([{ name: "5h", usedPercent: 20, resetsAt: minutes(45) }, healthyWeek]);
    expect(verdict.act).toBe(true);
    if (!verdict.act) return;
    expect(verdict.trigger).toBe("5h");
    expect(verdict.tier).toBe("daytime");
    expect(verdict.fiveHour).toEqual({ name: "5h", usedPercent: 20, resetsAt: minutes(45), minutesToReset: 45 });
    expect(verdict.reason).toBe("daytime tier, five-hour window about to lapse: 5h 20% used, resets in 45 min; 7d 40% used, resets in 3 d");
  });

  it("applies each tier's own ceiling and lookahead to the same reading", () => {
    // 4 h to reset at 60% used: overnight looks the whole window ahead and
    // tolerates 85%; daytime neither; interactive holds on the ceiling alone.
    const reading = [{ name: "5h", usedPercent: 60, resetsAt: minutes(240) }, healthyWeek];
    expect(evaluate(reading, "overnight").act).toBe(true);
    expect(evaluate(reading, "daytime").reason).toBe("5h 60% used, resets in 4 h — above the 50% five-hour ceiling");
    expect(evaluate(reading, "interactive").reason).toBe("5h 60% used, resets in 4 h — above the 20% five-hour ceiling");
    // Overnight keeps its hard floor: 86% used is over even there.
    expect(evaluate([{ name: "5h", usedPercent: 86, resetsAt: minutes(240) }, healthyWeek], "overnight").reason)
      .toBe("5h 86% used, resets in 4 h — above the 85% five-hour ceiling");
  });

  it("holds while the five-hour reset is beyond the tier's lookahead", () => {
    const verdict = evaluate([{ name: "5h", usedPercent: 20, resetsAt: minutes(200) }, healthyWeek]);
    expect(verdict.act).toBe(false);
    expect(verdict.reason).toMatch(/^daytime tier, no window within its lookahead \(5h: 120 min, 7d: 1440 min\)/);
  });

  it("holds when any weekly bucket, scoped ones included, is above the weekly ceiling", () => {
    const verdict = evaluate([
      { name: "5h", usedPercent: 10, resetsAt: minutes(10) },
      { name: "7d", usedPercent: 30, resetsAt: minutes(24 * 60) },
      { name: "7d Opus", usedPercent: 80, resetsAt: minutes(24 * 60) },
    ]);
    expect(verdict.reason).toBe("7d Opus 80% used, resets in 1 d — above the 75% weekly ceiling");
  });

  it("acts on the weekly reset when the five-hour window is not lapsing but is under its ceiling", () => {
    const verdict = evaluate([{ name: "5h", usedPercent: 30, resetsAt: minutes(240) }, { name: "7d", usedPercent: 35, resetsAt: minutes(6 * 60) }]);
    expect(verdict.act).toBe(true);
    if (verdict.act) expect(verdict.trigger).toBe("7d");
  });

  it("holds without a usable reading: unsupported, stale, a tier switched off", () => {
    expect(evaluate([], "daytime", { status: "static" }).reason).toBe("no usable Claude limits reading (status static)");
    expect(evaluate([{ name: "5h", usedPercent: 0, resetsAt: minutes(5) }, healthyWeek], "daytime", { status: "snapshot", stale: true }).reason)
      .toBe("the Claude limits reading is stale");
    const off = resolveIdleCapacityPolicy({ enabled: true, tiers: { interactive: { enabled: false } } });
    expect(evaluateIdleCapacity(snapshot([{ name: "5h", usedPercent: 0, resetsAt: minutes(5) }, healthyWeek]), "interactive", off, NOW).reason)
      .toBe("the interactive tier is switched off");
  });

  it("holds when either window is missing, has no percentage, or names no reset", () => {
    expect(evaluate([healthyWeek]).reason).toBe("the reading carries no five-hour window with a reset still ahead");
    expect(evaluate([{ name: "5h", resetsAt: minutes(5) }, healthyWeek]).reason).toBe("the reading carries no five-hour window with a reset still ahead");
    expect(evaluate([{ name: "5h", usedPercent: 0 }, healthyWeek]).reason).toBe("the reading carries no five-hour window with a reset still ahead");
    expect(evaluate([{ name: "5h", usedPercent: 5, resetsAt: minutes(5) }]).reason).toBe("the reading carries no weekly window with a reset still ahead");
    expect(evaluate([{ name: "5h", usedPercent: 5, resetsAt: minutes(5) }, { name: "7d", resetsAt: minutes(60) }]).reason)
      .toBe("the reading carries no weekly window with a reset still ahead");
  });

  it("treats a reset in the past as no reading, not as zero minutes to go", () => {
    // The CLI statusline snapshot is non-stale for 30 min after its last
    // write and can still name the window that has since rolled.
    const verdict = evaluate([{ name: "5h", usedPercent: 15, resetsAt: minutes(-60) }, healthyWeek], "daytime", { status: "snapshot", source: "claude-statusline" });
    expect(verdict.act).toBe(false);
    expect(verdict.reason).toBe("the reading carries no five-hour window with a reset still ahead");
    expect(evaluate([{ name: "5h", usedPercent: 15, resetsAt: minutes(10) }, { name: "7d", usedPercent: 10, resetsAt: minutes(-1) }]).reason)
      .toBe("the reading carries no weekly window with a reset still ahead");
  });

  it("accepts a CLI statusline snapshot that is not stale and carries both windows", () => {
    const verdict = evaluate(
      [{ name: "5h", usedPercent: 5, resetsAt: minutes(30) }, healthyWeek],
      "daytime",
      { status: "snapshot", source: "claude-statusline", stale: false },
    );
    expect(verdict.act).toBe(true);
  });

  it("exposes the five-hour reading on its own, undefined when unusable", () => {
    expect(fiveHourReading(snapshot([{ name: "5h", usedPercent: 12, resetsAt: minutes(90) }]), NOW))
      .toEqual({ name: "5h", usedPercent: 12, resetsAt: minutes(90), minutesToReset: 90 });
    expect(fiveHourReading(snapshot([{ name: "5h", usedPercent: 12, resetsAt: minutes(-1) }]), NOW)).toBeUndefined();
    expect(fiveHourReading(snapshot([], { status: "error" }), NOW)).toBeUndefined();
  });
});
