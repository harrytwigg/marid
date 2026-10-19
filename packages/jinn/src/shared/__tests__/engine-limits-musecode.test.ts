import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { JinnConfig } from "../types.js";

// The usage snapshot and the health store both freeze their path from JINN_HOME at import.
const TEST_HOME = path.join(os.tmpdir(), "jinn-engine-limits-musecode-test");
vi.mock("../paths.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../paths.js")>()),
  JINN_HOME: path.join(os.tmpdir(), "jinn-engine-limits-musecode-test"),
}));

import { collectEngineLimits } from "../engine-limits.js";
import { collectMusecodeLimits, MUSECODE_NO_USAGE_REASON } from "../engine-limits-musecode.js";
import { invalidateModelRegistry } from "../models.js";
import { readEngineHealth } from "../engine-health.js";
import { rerouteAtCreation } from "../../sessions/fallback-reroute.js";
import type { ModelRegistry } from "../types.js";
import { writeMusecodeUsage, musecodeUsageFile } from "../musecode-usage.js";

const FAKE = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "engines", "__tests__", "fixtures", "fake-muse.mjs");
const NOW = Date.now();
const HOUR = 3_600_000;

const config = (over: Record<string, unknown> = {}) =>
  ({ engines: { default: "claude", claude: {}, musecode: { bin: FAKE, ...over } } }) as unknown as JinnConfig;

const usage = (over: { observedAtMs?: number; used?: number; weekly?: number; resetsInMs?: number } = {}) => {
  const observedAtMs = over.observedAtMs ?? NOW - 60_000;
  return {
    observedAtMs,
    tier: "everyday",
    window: { usedPercent: over.used ?? 42, windowDurationMins: 300, resetsAtMs: NOW + (over.resetsInMs ?? HOUR) },
    weekly: { usedPercent: over.weekly ?? 17, resetsAtMs: NOW + 72 * HOUR },
  };
};

beforeEach(() => {
  invalidateModelRegistry();
  fs.rmSync(TEST_HOME, { recursive: true, force: true });
  vi.stubEnv("FAKE_MUSE_STATE_DIR", path.join(TEST_HOME, "fake-state"));
});
afterEach(() => {
  vi.unstubAllEnvs();
  fs.rmSync(TEST_HOME, { recursive: true, force: true });
});

describe("collectMusecodeLimits", () => {
  it("reports the snapshot file a turn left, with windows in seconds and ISO", async () => {
    const kept = usage({ used: 42 });
    writeMusecodeUsage(kept);
    const snap = collectMusecodeLimits(config());
    expect(snap.status).toBe("snapshot");
    expect(snap.stale).toBe(false);
    expect(snap.accountPlan).toBe("everyday");
    expect(snap.windows).toEqual([
      { name: "5h", usedPercent: 42, windowDurationMins: 300, resetsAt: Math.floor(kept.window.resetsAtMs / 1000), resetsAtIso: new Date(Math.floor(kept.window.resetsAtMs / 1000) * 1000).toISOString() },
      { name: "weekly", usedPercent: 17, resetsAt: Math.floor(kept.weekly.resetsAtMs / 1000), resetsAtIso: new Date(Math.floor(kept.weekly.resetsAtMs / 1000) * 1000).toISOString() },
    ]);
    expect(snap.models.length).toBeGreaterThan(0);
  });

  it("marks a snapshot stale once its window has reset, and once it is older than six hours", async () => {
    writeMusecodeUsage(usage({ resetsInMs: -HOUR, observedAtMs: NOW - 2 * HOUR }));
    expect((collectMusecodeLimits(config())).stale).toBe(true);
    fs.rmSync(musecodeUsageFile());
    writeMusecodeUsage(usage({ observedAtMs: NOW - 7 * HOUR, resetsInMs: 20 * HOUR }));
    expect((collectMusecodeLimits(config())).stale).toBe(true);
  });

  it("says usage appears after the first Muse Code turn when there is no data at all", async () => {
    const snap = collectMusecodeLimits(config());
    expect(snap.status).toBe("unavailable");
    expect(snap.windows).toBeUndefined();
    expect(snap.unsupportedReason).toBe(MUSECODE_NO_USAGE_REASON);
    expect(snap.unsupportedReason).toMatch(/after the first Muse Code turn/);
  });

  it("reports a missing binary the way the other engines do", async () => {
    invalidateModelRegistry();
    const snap = collectMusecodeLimits(config({ bin: path.join(TEST_HOME, "no-such-muse") }));
    expect(snap).toMatchObject({ status: "unavailable", available: false, unsupportedReason: "Muse Code CLI is not installed." });
  });
});

describe("collectEngineLimits for Muse Code", () => {
  it("is in the collector chain, and never starts the binary to ask for usage", async () => {
    writeMusecodeUsage(usage());
    const logFile = path.join(TEST_HOME, "requests.jsonl");
    vi.stubEnv("FAKE_MUSE_LOG", logFile);
    const { engines } = await collectEngineLimits(config(), { engine: "musecode" });
    expect(engines.musecode!.status).toBe("snapshot");
    expect(engines.musecode!.windows).toHaveLength(2);
    expect(fs.existsSync(logFile)).toBe(false);
  });

  it("records a window at 100% as exhausted until its reset, and new sessions move to the configured fallback", async () => {
    const resetsInMs = 90 * 60_000;
    writeMusecodeUsage(usage({ used: 100, resetsInMs }));
    await collectEngineLimits(config({ fallback: ["claude"] }), { engine: "musecode" });

    const health = readEngineHealth();
    expect(health.musecode).toMatchObject({ state: "exhausted", window: "5h" });
    expect(Date.parse(health.musecode!.until!)).toBe(Math.floor((NOW + resetsInMs) / 1000) * 1000);

    const cfg = config({ fallback: ["claude"] });
    const registry = {
      musecode: { available: true, defaultModel: "m", models: [] },
      claude: { available: true, defaultModel: "opus", models: [] },
    } as unknown as ModelRegistry;
    const scope = { scoped: false, remote: false };
    // A new session on the spent engine starts on its chain's first healthy link; one on a healthy target stays.
    expect(rerouteAtCreation({ config: cfg, engine: "musecode", registry, health, scope })?.engine).toBe("claude");
    expect(rerouteAtCreation({ config: cfg, engine: "claude", registry, health, scope })).toBeUndefined();
  });

  it("an exceeded weekly block counts, and a window that has already reset does not", async () => {
    writeMusecodeUsage(usage({ used: 10, weekly: 130 }));
    await collectEngineLimits(config(), { engine: "musecode" });
    expect(readEngineHealth().musecode).toMatchObject({ state: "exhausted", window: "weekly" });

    fs.rmSync(path.join(TEST_HOME, "tmp", "engine-health.json"), { force: true });
    fs.rmSync(musecodeUsageFile());
    writeMusecodeUsage({ ...usage({ used: 100 }), window: { usedPercent: 100, windowDurationMins: 300, resetsAtMs: NOW - HOUR } });
    await collectEngineLimits(config(), { engine: "musecode" });
    expect(readEngineHealth().musecode).toBeUndefined();
  });
});
