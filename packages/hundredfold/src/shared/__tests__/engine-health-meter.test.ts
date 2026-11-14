import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const TEST_HOME = path.join(os.tmpdir(), "hundredfold-engine-health-meter-test");
vi.mock("../paths.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../paths.js")>()),
  HUNDREDFOLD_HOME: path.join(os.tmpdir(), "hundredfold-engine-health-meter-test"),
}));

import { readEngineHealth } from "../engine-health.js";
import { writeStore } from "../engine-health-store.js";
import { METERED_WINDOW_REASON, recordMeteredExhaustion } from "../engine-health-meter.js";
import { recordEngineServed } from "../engine-health-clear.js";
import type { EngineLimitBucket, EngineLimitWindow } from "../types.js";

const STATE_PATH = path.join(TEST_HOME, "tmp", "engine-health.json");
const NOW = new Date("2026-11-12T10:00:00.000Z");
const HOUR = 3_600_000;
const secondsIn = (hours: number) => (NOW.getTime() + hours * HOUR) / 1000;
const iso = (hours: number) => new Date(NOW.getTime() + hours * HOUR).toISOString();

function window(name: string, usedPercent: number, reopensInHours?: number): EngineLimitWindow {
  return { name, usedPercent, ...(reopensInHours === undefined ? {} : { resetsAt: secondsIn(reopensInHours) }) };
}
const bucket = (id: string, ...windows: EngineLimitWindow[]): EngineLimitBucket => ({ id, windows });

beforeEach(() => {
  fs.mkdirSync(path.dirname(STATE_PATH), { recursive: true });
  fs.rmSync(STATE_PATH, { force: true });
});
afterEach(() => fs.rmSync(TEST_HOME, { recursive: true, force: true }));

describe("recordMeteredExhaustion", () => {
  it("records the provider's key exhausted, stamped with the model and window, and never the engine's", () => {
    recordMeteredExhaustion([bucket("opencode-go/flash", window("5h", 100, 3), window("7d", 40))], NOW);
    const health = readEngineHealth(NOW);
    expect(health["opencode/opencode-go"]).toMatchObject({
      state: "exhausted", until: iso(3), window: "5h", model: "opencode-go/flash", reason: METERED_WINDOW_REASON,
    });
    expect(health.opencode).toBeUndefined();
  });

  it("holds until the latest reopening across every spent window of every model of the provider", () => {
    recordMeteredExhaustion([
      bucket("opencode-go/flash", window("5h", 100, 3), window("7d", 100, 50)),
      bucket("opencode-go/pro", window("5h", 100, 4), window("30d", 100, 20)),
    ], NOW);
    expect(readEngineHealth(NOW)["opencode/opencode-go"]).toMatchObject({ until: iso(50), window: "7d", model: "opencode-go/flash" });
  });

  it("keeps one provider's spent window off another's key", () => {
    recordMeteredExhaustion([
      bucket("opencode-go-b/flash", window("5h", 100, 2)),
      bucket("opencode-go/flash", window("5h", 60)),
    ], NOW);
    const health = readEngineHealth(NOW);
    expect(health["opencode/opencode-go-b"]?.state).toBe("exhausted");
    expect(health["opencode/opencode-go"]).toBeUndefined();
  });

  it("writes nothing for a window under its limit, one with no reopening, one already past, or a model with no provider", () => {
    recordMeteredExhaustion([
      bucket("opencode-go/a", window("5h", 99.9, 3)),
      bucket("opencode-go/b", window("5h", 100)),
      bucket("opencode-go/c", window("5h", 100, -1)),
      bucket("plain", window("5h", 100, 3)),
    ], NOW);
    expect(readEngineHealth(NOW)).toEqual({});
    recordMeteredExhaustion(undefined, NOW);
    expect(readEngineHealth(NOW)).toEqual({});
  });

  describe("a provider's own refusal outranks the meter", () => {
    const refusal = (over: Record<string, unknown>) => ({
      state: "exhausted", until: iso(10), recheckAt: iso(10), reason: "usage limit exceeded", observedAt: NOW.toISOString(), ...over,
    }) as never;
    const spent = [bucket("opencode-go/flash", window("5h", 100, 3))];

    it("does not shorten a refusal that lasts longer", () => {
      writeStore({ "opencode/opencode-go": refusal({ failureClass: "quota" }) });
      recordMeteredExhaustion(spent, NOW);
      expect(readEngineHealth(NOW)["opencode/opencode-go"]).toMatchObject({ reason: "usage limit exceeded", until: iso(10) });
    });

    it("does not replace a refusal that is not quota-derived, however briefly it lasts", () => {
      writeStore({ "opencode/opencode-go": refusal({ failureClass: "auth", until: iso(1), recheckAt: undefined }) });
      recordMeteredExhaustion(spent, NOW);
      expect(readEngineHealth(NOW)["opencode/opencode-go"]).toMatchObject({ failureClass: "auth", until: iso(1) });
    });

    it("keeps an exhausted record that says nothing of its class", () => {
      writeStore({ "opencode/opencode-go": refusal({ until: iso(1), recheckAt: undefined }) });
      recordMeteredExhaustion(spent, NOW);
      expect(readEngineHealth(NOW)["opencode/opencode-go"]?.reason).toBe("usage limit exceeded");
    });

    it("lets a longer meter reopening replace a shorter quota refusal", () => {
      writeStore({ "opencode/opencode-go": refusal({ failureClass: "quota", until: iso(1), recheckAt: iso(1) }) });
      recordMeteredExhaustion(spent, NOW);
      expect(readEngineHealth(NOW)["opencode/opencode-go"]).toMatchObject({ reason: METERED_WINDOW_REASON, until: iso(3) });
    });

    it("writes over a lapsed refusal and over a degraded record", () => {
      writeStore({ "opencode/opencode-go": refusal({ failureClass: "auth", until: iso(-1) }) });
      recordMeteredExhaustion(spent, NOW);
      expect(readEngineHealth(NOW)["opencode/opencode-go"]).toMatchObject({ reason: METERED_WINDOW_REASON });
      writeStore({ "opencode/opencode-go": { state: "degraded", until: iso(0.2), reason: "unreachable" } });
      recordMeteredExhaustion(spent, NOW);
      expect(readEngineHealth(NOW)["opencode/opencode-go"]).toMatchObject({ state: "exhausted", reason: METERED_WINDOW_REASON });
    });

    it("refreshes a record the meter wrote itself", () => {
      recordMeteredExhaustion([bucket("opencode-go/flash", window("5h", 100, 3))], NOW);
      recordMeteredExhaustion([bucket("opencode-go/pro", window("7d", 100, 30))], NOW);
      expect(readEngineHealth(NOW)["opencode/opencode-go"]).toMatchObject({ until: iso(30), model: "opencode-go/pro", window: "7d" });
    });

    it("leaves an engine-wide record alone", () => {
      writeStore({ opencode: refusal({ until: iso(10) }) });
      recordMeteredExhaustion(spent, NOW);
      expect(readEngineHealth(NOW).opencode).toMatchObject({ reason: "usage limit exceeded", until: iso(10) });
    });
  });
});

describe("a served turn and the meter's hold", () => {
  it("never clears the record the meter wrote, even for a turn on the model it names", () => {
    recordMeteredExhaustion([bucket("opencode-go/flash", window("5h", 100, 3))], NOW);
    const later = new Date(NOW.getTime() + 60_000);
    recordEngineServed("opencode/opencode-go", later.getTime(), "opencode-go/flash", later);
    expect(readEngineHealth(later)["opencode/opencode-go"]).toMatchObject({
      state: "exhausted", until: iso(3), window: "5h", model: "opencode-go/flash", reason: METERED_WINDOW_REASON,
    });
  });

  it("still clears a refusal the provider gave when a turn on its model is served", () => {
    writeStore({ "opencode/opencode-go": { state: "exhausted", reason: "usage limit reached", until: iso(3), observedAt: NOW.toISOString(), model: "opencode-go/flash" } });
    const later = new Date(NOW.getTime() + 60_000);
    recordEngineServed("opencode/opencode-go", later.getTime(), "opencode-go/flash", later);
    expect(readEngineHealth(later)["opencode/opencode-go"]?.state).toBe("ok");
  });
});
