import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { JinnConfig } from "../types.js";

// The usage snapshot freezes its path from JINN_HOME at import.
const TEST_HOME = path.join(os.tmpdir(), "jinn-engine-limits-freebuff-test");
vi.mock("../paths.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../paths.js")>()),
  JINN_HOME: path.join(os.tmpdir(), "jinn-engine-limits-freebuff-test"),
}));

import { collectEngineLimits } from "../engine-limits.js";
import { collectFreebuffLimits, FREEBUFF_NO_USAGE_REASON, FREEBUFF_SNAPSHOT_MAX_AGE_MS } from "../engine-limits-freebuff.js";
import { invalidateModelRegistry } from "../models.js";
import { freebuffUsageFile, readFreebuffUsage, writeFreebuffUsage } from "../freebuff-usage.js";

const NOW = Date.now();
// `node` is on PATH wherever these tests run, so the engine reads as installed.
const config = () => ({ engines: { default: "claude", claude: {}, freebuff: { bin: process.execPath } } }) as unknown as JinnConfig;

beforeEach(() => {
  invalidateModelRegistry();
  fs.rmSync(TEST_HOME, { recursive: true, force: true });
});
afterEach(() => {
  fs.rmSync(TEST_HOME, { recursive: true, force: true });
});

describe("collectFreebuffLimits", () => {
  it("says there is nothing to show until a turn has read the screen", () => {
    const snap = collectFreebuffLimits(config(), NOW);
    expect(snap.status).toBe("unavailable");
    expect(snap.unsupportedReason).toBe(FREEBUFF_NO_USAGE_REASON);
  });

  it("shows the day's hours and the running session as two windows", () => {
    writeFreebuffUsage({ observedAtMs: NOW - 60_000, hoursRemaining: 15, hoursTotal: 21, sessionLeftMinutes: 45, modelLabel: "MiMo v2.6 Flash Slow" });
    const snap = collectFreebuffLimits(config(), NOW);
    expect(snap.status).toBe("snapshot");
    expect(snap.accountPlan).toBe("15/21 hours left today");
    expect(snap.windows?.map((w) => [w.name, Math.round(w.usedPercent ?? -1)])).toEqual([["daily hours", 29], ["session", 25]]);
    expect(snap.stale).toBe(false);
  });

  it("shows only the windows the screen gave, and a day-old reading as stale", () => {
    writeFreebuffUsage({ observedAtMs: NOW - FREEBUFF_SNAPSHOT_MAX_AGE_MS - 1, sessionLeftMinutes: 60 });
    const snap = collectFreebuffLimits(config(), NOW);
    // A session reading that old describes a session that is over.
    expect(snap.windows).toEqual([]);
    expect(snap.accountPlan).toBeUndefined();
    expect(snap.stale).toBe(true);
  });

  it("is reached through the Limits collector for the freebuff engine", async () => {
    writeFreebuffUsage({ observedAtMs: NOW, hoursRemaining: 0, hoursTotal: 21 });
    const all = await collectEngineLimits(config(), { engine: "freebuff" });
    expect(all.engines.freebuff.windows?.[0]).toMatchObject({ name: "daily hours", usedPercent: 100 });
  });
});

describe("the usage snapshot file", () => {
  it("keeps the day's hours through later readings that carry only the session clock", () => {
    // The panel is on screen before a session's first message only; every later screen has the clock alone.
    writeFreebuffUsage({ observedAtMs: NOW - 120_000, hoursRemaining: 17, hoursTotal: 21 });
    writeFreebuffUsage({ observedAtMs: NOW - 60_000, sessionLeftMinutes: 53 });
    expect(readFreebuffUsage()).toMatchObject({ observedAtMs: NOW - 60_000, hoursRemaining: 17, hoursTotal: 21, hoursObservedAtMs: NOW - 120_000, sessionLeftMinutes: 53 });
    const snap = collectFreebuffLimits(config(), NOW);
    expect(snap.windows?.map((w) => w.name)).toEqual(["daily hours", "session"]);
    expect(snap.accountPlan).toBe("17/21 hours left today");
  });

  it("goes stale by the age of the hours, not of the latest clock reading", () => {
    writeFreebuffUsage({ observedAtMs: NOW - FREEBUFF_SNAPSHOT_MAX_AGE_MS - 5_000, hoursRemaining: 17, hoursTotal: 21 });
    writeFreebuffUsage({ observedAtMs: NOW - 1_000, sessionLeftMinutes: 40 });
    expect(collectFreebuffLimits(config(), NOW).stale).toBe(true);
  });

  it("keeps the newer of two readings", () => {
    writeFreebuffUsage({ observedAtMs: 2_000, hoursRemaining: 10 });
    writeFreebuffUsage({ observedAtMs: 1_000, hoursRemaining: 20 });
    expect(readFreebuffUsage()?.hoursRemaining).toBe(10);
  });

  it("reads nothing from a file that is not a snapshot", () => {
    fs.mkdirSync(path.dirname(freebuffUsageFile()), { recursive: true });
    fs.writeFileSync(freebuffUsageFile(), "not json");
    expect(readFreebuffUsage()).toBeUndefined();
  });
});
