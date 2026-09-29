import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { EngineLimitEngineSnapshot } from "../types.js";
import {
  USAGE_HISTORY_COLLAPSE_MS,
  USAGE_HISTORY_MAX_SAMPLES,
  USAGE_HISTORY_RETENTION_MS,
  appendSample,
  readClaudeUsageHistory,
  recordClaudeUsageSample,
  sampleFromSnapshot,
  type UsageSample,
} from "../claude-usage-history.js";

const NOW = Date.parse("2026-09-21T12:00:00Z");
const resetsAt = Math.floor(NOW / 1000) + 3600;

function snapshot(over: Partial<EngineLimitEngineSnapshot> = {}): EngineLimitEngineSnapshot {
  return {
    name: "claude", available: true, status: "live", source: "test", refreshedAt: new Date(NOW).toISOString(), models: [],
    windows: [
      { name: "5h", usedPercent: 13, resetsAt },
      { name: "7d", usedPercent: 68, resetsAt: resetsAt + 86_400 },
      { name: "7d Fable", usedPercent: 0, resetsAt: resetsAt + 86_400 },
    ],
    ...over,
  };
}

const sample = (at: number): UsageSample => ({ at, windows: [{ name: "5h", usedPercent: 10, resetsAt }] });

describe("sampleFromSnapshot", () => {
  it("keeps the five-hour and every weekly window of a live reading", () => {
    expect(sampleFromSnapshot(snapshot(), NOW)).toEqual({
      at: NOW,
      windows: [
        { name: "5h", usedPercent: 13, resetsAt },
        { name: "7d", usedPercent: 68, resetsAt: resetsAt + 86_400 },
        { name: "7d Fable", usedPercent: 0, resetsAt: resetsAt + 86_400 },
      ],
    });
  });

  it("records nothing from a statusline snapshot, an error or a stale reading", () => {
    expect(sampleFromSnapshot(snapshot({ status: "snapshot" }), NOW)).toBeUndefined();
    expect(sampleFromSnapshot(snapshot({ status: "error" }), NOW)).toBeUndefined();
  });

  it("leaves out a window without a reset instant, and the sample when none remains", () => {
    const untouched = sampleFromSnapshot(snapshot({ windows: [{ name: "5h", usedPercent: 0 }, { name: "7d", usedPercent: 40, resetsAt }] }), NOW);
    expect(untouched?.windows.map((window) => window.name)).toEqual(["7d"]);
    expect(sampleFromSnapshot(snapshot({ windows: [{ name: "5h", usedPercent: 0 }] }), NOW)).toBeUndefined();
  });
});

describe("appendSample", () => {
  it("collapses a reading within the collapse window onto the last recorded one", () => {
    const history = [sample(NOW)];
    expect(appendSample(history, sample(NOW + USAGE_HISTORY_COLLAPSE_MS - 1))).toEqual(history);
    expect(appendSample(history, sample(NOW + USAGE_HISTORY_COLLAPSE_MS))).toHaveLength(2);
  });

  it("drops samples older than the retention and caps the count", () => {
    const old = sample(NOW - USAGE_HISTORY_RETENTION_MS - 1);
    const kept = sample(NOW - USAGE_HISTORY_RETENTION_MS + 1);
    expect(appendSample([old, kept], sample(NOW)).map((entry) => entry.at)).toEqual([kept.at, NOW]);

    // At the collapse cadence a week holds 2 016 samples, so the retention
    // bound bites first; the cap only matters for a denser file (an older
    // build, a hand edit), which is what this fixture is.
    const dense = Array.from({ length: USAGE_HISTORY_MAX_SAMPLES + 10 }, (_, i) => sample(NOW - (USAGE_HISTORY_MAX_SAMPLES + 10 - i) * 60_000));
    expect(appendSample(dense, sample(NOW))).toHaveLength(USAGE_HISTORY_MAX_SAMPLES);
    const week = Array.from({ length: 2_100 }, (_, i) => sample(NOW - (2_100 - i) * USAGE_HISTORY_COLLAPSE_MS));
    expect(appendSample(week, sample(NOW))).toHaveLength(Math.floor(USAGE_HISTORY_RETENTION_MS / USAGE_HISTORY_COLLAPSE_MS) + 1);
  });
});

describe("recordClaudeUsageSample / readClaudeUsageHistory", () => {
  let dir: string;
  let file: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "jinn-usage-history-"));
    file = path.join(dir, "nested", "claude-usage-history.json");
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  it("creates the file on first record, appends on the next, and reads since a floor", () => {
    recordClaudeUsageSample(snapshot(), NOW, file);
    recordClaudeUsageSample(snapshot(), NOW + 10 * 60_000, file);
    expect(readClaudeUsageHistory(0, file).map((entry) => entry.at)).toEqual([NOW, NOW + 10 * 60_000]);
    expect(readClaudeUsageHistory(NOW + 1, file).map((entry) => entry.at)).toEqual([NOW + 10 * 60_000]);
    expect(fs.readdirSync(path.dirname(file))).toEqual(["claude-usage-history.json"]);
  });

  it("treats an unreadable or malformed file as empty and writes over it", () => {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, "{not json");
    expect(readClaudeUsageHistory(0, file)).toEqual([]);
    recordClaudeUsageSample(snapshot(), NOW, file);
    expect(readClaudeUsageHistory(0, file)).toHaveLength(1);
    fs.writeFileSync(file, JSON.stringify({ not: "a list" }));
    expect(readClaudeUsageHistory(0, file)).toEqual([]);
  });

  it("never throws when the file cannot be written", () => {
    expect(() => recordClaudeUsageSample(snapshot(), NOW, path.join(dir, "no\0such"))).not.toThrow();
  });
});
