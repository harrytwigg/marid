import { describe, it, expect } from "vitest";
import os from "node:os";
import path from "node:path";
import type { JinnConfig } from "../types.js";
import type { EngineSpendRow } from "../../sessions/engine-spend.js";

// The collector's default reader opens the gateway DB; every test here injects
// its own, but the module still resolves JINN_HOME on import.
process.env.JINN_HOME = path.join(os.tmpdir(), `jinn-oc-limits-${process.pid}`);
const { collectOpencodeLimits, meterWindow, monthlyLimitFor, modelWindows } = await import("../engine-limits-opencode.js");
const { opencodeUsageLimitsProblems } = await import("../opencode-usage-limits-config.js");
const { validateConfigShape } = await import("../config.js");

const HOUR = 60 * 60_000;
const NOW = Date.parse("2026-09-24T12:00:00Z");
const FLASH = "opencode-go/deepseek-v4.1-flash";
const PRO = "opencode-go/deepseek-v4-pro";

function cfg(usageLimits?: unknown, model = FLASH): JinnConfig {
  return {
    gateway: { port: 7799, host: "127.0.0.1" },
    engines: { default: "claude", claude: { bin: "claude", model: "opus" }, codex: { bin: "codex", model: "x" }, opencode: { bin: process.execPath, model, ...(usageLimits ? { usageLimits } : {}) } },
    connectors: {},
  } as unknown as JinnConfig;
}

const row = (model: string | null, cost: number, hoursAgo: number): EngineSpendRow => ({ model, cost, atMs: NOW - hoursAgo * HOUR });

describe("monthlyLimitFor", () => {
  const limits = { monthlyUsd: { "opencode-go/*": 60, [PRO]: 15, "bad/*": -1, "nan/x": Number.NaN } };

  it("prefers an exact model key over its provider wildcard", () => {
    expect(monthlyLimitFor(PRO, limits)).toBe(15);
    expect(monthlyLimitFor(FLASH, limits)).toBe(60);
  });

  it("meters nothing for an unmatched, non-positive or non-numeric entry", () => {
    expect(monthlyLimitFor("openrouter/some-model", limits)).toBeUndefined();
    expect(monthlyLimitFor("bad/model", limits)).toBeUndefined();
    expect(monthlyLimitFor("nan/x", limits)).toBeUndefined();
    expect(monthlyLimitFor(FLASH, undefined)).toBeUndefined();
    expect(monthlyLimitFor(FLASH, { monthlyUsd: "60" as never })).toBeUndefined();
  });
});

describe("meterWindow", () => {
  it("sums only the trailing window", () => {
    const m = meterWindow([row(null, 5, 6), row(null, 3, 4), row(null, 2, 1)], 5 * HOUR, 12, NOW);
    expect(m.usedUsd).toBe(5);
    expect(m.usedPercent).toBeCloseTo(41.666, 2);
    expect(m.reopensAtMs).toBeUndefined();
  });

  it("reopens when enough of the oldest spend ages out — not merely the oldest row", () => {
    // $13 in the window against $12: dropping the $1 row still leaves $12, which
    // is not under the limit, so it reopens when the $4 row ages out.
    const rows = [row(null, 1, 4.5), row(null, 4, 3), row(null, 8, 1)];
    const m = meterWindow(rows, 5 * HOUR, 12, NOW);
    expect(m.usedUsd).toBe(13);
    expect(m.reopensAtMs).toBe(NOW - 3 * HOUR + 5 * HOUR);
  });

  it("treats spend exactly at the limit as spent", () => {
    const m = meterWindow([row(null, 12, 2)], 5 * HOUR, 12, NOW);
    expect(m.usedPercent).toBe(100);
    expect(m.reopensAtMs).toBe(NOW + 3 * HOUR);
  });
});

describe("modelWindows", () => {
  it("meters Go's three windows as 20% / 50% / 100% of the monthly limit", () => {
    const windows = modelWindows([row(null, 6, 1), row(null, 9, 48)], 60, NOW);
    expect(windows.map((w) => [w.name, w.windowDurationMins, w.usedPercent])).toEqual([
      ["5h", 300, 50], // $6 of $12
      ["7d", 10_080, 50], // $15 of $30
      ["30d", 43_200, 25], // $15 of $60
    ]);
    expect(windows.every((w) => w.resetsAt === undefined)).toBe(true);
  });

  it("floors the percentage so a window short of its limit never reads 100", () => {
    const [fiveHour] = modelWindows([row(null, 11.9999, 1)], 60, NOW);
    expect(fiveHour.usedPercent).toBe(99.9);
    expect(fiveHour.resetsAt).toBeUndefined();
  });

  it("names the reopening in unix seconds once a window is spent", () => {
    const [fiveHour] = modelWindows([row(null, 12.5, 2)], 60, NOW);
    expect(fiveHour.usedPercent).toBe(104.1);
    expect(fiveHour.resetsAt).toBe(Math.ceil((NOW + 3 * HOUR) / 1000));
    expect(fiveHour.resetsAtIso).toBe(new Date(fiveHour.resetsAt! * 1000).toISOString());
  });
});

describe("collectOpencodeLimits", () => {
  const read = (rows: EngineSpendRow[]) => (sinceMs: number) => rows.filter((r) => r.atMs > sinceMs);

  it("answers nothing when no allowance is configured, so the caller keeps 'unsupported'", () => {
    expect(collectOpencodeLimits(cfg(), { readSpend: () => { throw new Error("must not read"); } })).toBeUndefined();
    expect(collectOpencodeLimits(cfg({ monthlyUsd: {} }), { readSpend: () => { throw new Error("must not read"); } })).toBeUndefined();
  });

  it("reports the default model's windows, charging unpinned turns to it", () => {
    const snap = collectOpencodeLimits(cfg({ monthlyUsd: { "opencode-go/*": 60 } }), {
      now: () => NOW,
      readSpend: read([row(FLASH, 3, 1), row(null, 3, 2), row(FLASH, 100, 24 * 40)]),
    })!;
    expect(snap.status).toBe("snapshot");
    expect(snap.windows?.map((w) => [w.name, w.usedPercent])).toEqual([["5h", 50], ["7d", 20], ["30d", 10]]);
    expect(snap.accountPlan).toBe(`${FLASH} · $60/month`);
    expect(snap.costUsd).toBe(6); // the 40-day-old row is outside every window
  });

  it("meters each model in its own bucket, and only the default's windows speak for the engine", () => {
    const snap = collectOpencodeLimits(cfg({ monthlyUsd: { "opencode-go/*": 60, [PRO]: 15 } }), {
      now: () => NOW,
      readSpend: read([row(PRO, 3, 1), row(FLASH, 1.2, 1), row("openrouter/x", 50, 1)]),
    })!;
    expect(snap.buckets?.map((b) => [b.id, b.planType, b.windows?.[0].usedPercent])).toEqual([
      [PRO, "$15/month", 100], // spent: $3 of a $3 five-hour window
      [FLASH, "$60/month", 10],
    ]);
    expect(snap.windows?.[0]).toMatchObject({ name: "5h", usedPercent: 10 });
    expect(snap.windows?.some((w) => w.resetsAt !== undefined)).toBe(false);
    expect(snap.costUsd).toBe(54.2); // unmetered spend still counts towards what was spent
  });

  it("shows an empty default bucket before anything has been spent", () => {
    const snap = collectOpencodeLimits(cfg({ monthlyUsd: { [FLASH]: 60 } }), { now: () => NOW, readSpend: () => [] })!;
    expect(snap.windows?.map((w) => w.usedPercent)).toEqual([0, 0, 0]);
    expect(snap.buckets).toHaveLength(1);
  });

  it("says so when the default model is unmetered, rather than silently reading healthy", () => {
    const snap = collectOpencodeLimits(cfg({ monthlyUsd: { [PRO]: 15 } }), { now: () => NOW, readSpend: read([row(PRO, 1, 1)]) })!;
    expect(snap.windows).toEqual([]);
    expect(snap.buckets?.map((b) => b.id)).toEqual([PRO]);
    expect(snap.unsupportedReason).toMatch(/default model .* matches no/);
  });
});

describe("opencodeUsageLimitsProblems", () => {
  const check = (usageLimits: unknown) => opencodeUsageLimitsProblems({ opencode: { model: FLASH, usageLimits } });

  it("accepts an absent block and a table of positive numbers", () => {
    expect(opencodeUsageLimitsProblems({ claude: {} })).toEqual([]);
    expect(check(undefined)).toEqual([]);
    expect(check({ monthlyUsd: { "opencode-go/*": 60, [PRO]: 15 } })).toEqual([]);
  });

  it("names every entry the meter would silently skip", () => {
    expect(check({ monthlyUsd: { "opencode-go/*": "60", [PRO]: -1, ok: 5 } })).toEqual([
      'engines.opencode.usageLimits.monthlyUsd["opencode-go/*"] must be a positive number (got "60")',
      `engines.opencode.usageLimits.monthlyUsd["${PRO}"] must be a positive number (got -1)`,
    ]);
    expect(check([60])).toEqual(["engines.opencode.usageLimits must be a mapping"]);
    expect(check({ monthlyUsd: 60 })).toEqual([expect.stringContaining("monthlyUsd must be a mapping")]);
  });

  it("is part of the config shape check", () => {
    const problems = validateConfigShape({ engines: { claude: {}, opencode: { usageLimits: { monthlyUsd: { x: 0 } } } } });
    expect(problems).toContain('engines.opencode.usageLimits.monthlyUsd["x"] must be a positive number (got 0)');
  });
});
