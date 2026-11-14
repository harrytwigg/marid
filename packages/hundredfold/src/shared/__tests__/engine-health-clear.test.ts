import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const TEST_HOME = path.join(os.tmpdir(), "hundredfold-engine-health-clear-test");
vi.mock("../paths.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../paths.js")>()),
  HUNDREDFOLD_HOME: path.join(os.tmpdir(), "hundredfold-engine-health-clear-test"),
}));

import {
  clearContradictedHealth,
  clearEngineHealthByOperator,
  isEngineExhausted,
  noteLimitReading,
  readEngineHealth,
  recordEngineServed,
  recordEngineUnavailable,
} from "../engine-health.js";
import type { EngineLimitWindow } from "../types.js";

const STATE_PATH = path.join(TEST_HOME, "tmp", "engine-health.json");
const NOW = new Date("2026-11-12T10:00:00.000Z");
const at = (minutes: number) => new Date(NOW.getTime() + minutes * 60_000);
const secondsAt = (minutes: number) => at(minutes).getTime() / 1000;
const win = (name: string, usedPercent: number | undefined): EngineLimitWindow => ({ name, usedPercent });

/** An account recorded spent on its 7d window, observed at NOW. */
function recordSpent(key = "claude:overflow", about: { host?: string; window?: string } = { window: "7d" }): void {
  recordEngineUnavailable(key, "usage limit", secondsAt(4 * 24 * 60), NOW, about);
}

beforeEach(() => {
  fs.mkdirSync(path.dirname(STATE_PATH), { recursive: true });
  fs.rmSync(STATE_PATH, { force: true });
});

afterEach(() => {
  fs.rmSync(TEST_HOME, { recursive: true, force: true });
});

const stored = () => JSON.parse(fs.readFileSync(STATE_PATH, "utf-8")) as Record<string, Record<string, unknown>>;

describe("clearContradictedHealth", () => {
  it("clears an exhausted record on a reading taken after it that shows every window under 100%", () => {
    recordSpent();
    const readAt = at(30).getTime();

    clearContradictedHealth("claude:overflow", [win("5h", 0), win("7d", 0)], readAt, at(31));

    const record = readEngineHealth(at(31))["claude:overflow"];
    expect(record).toEqual({ state: "ok", clearedAt: at(31).toISOString(), observedAt: at(31).toISOString(), reason: "usage reading shows headroom" });
    expect(isEngineExhausted(readEngineHealth(at(31)), "claude:overflow", at(31))).toBe(false);
  });

  it("does not clear on a reading no newer than the record", () => {
    recordSpent();

    clearContradictedHealth("claude:overflow", [win("7d", 0)], NOW.getTime() - 1, at(5));
    clearContradictedHealth("claude:overflow", [win("7d", 0)], NOW.getTime(), at(5));

    expect(isEngineExhausted(readEngineHealth(at(5)), "claude:overflow", at(5))).toBe(true);
  });

  it("does not clear when any window is still spent", () => {
    recordSpent();

    clearContradictedHealth("claude:overflow", [win("5h", 100), win("7d", 0)], at(30).getTime(), at(31));

    expect(isEngineExhausted(readEngineHealth(at(31)), "claude:overflow", at(31))).toBe(true);
  });

  it("does not clear on a reading with no window, or a window with no number", () => {
    recordSpent();

    clearContradictedHealth("claude:overflow", [], at(30).getTime(), at(31));
    clearContradictedHealth("claude:overflow", undefined, at(30).getTime(), at(31));
    clearContradictedHealth("claude:overflow", [win("7d", undefined)], at(30).getTime(), at(31));

    expect(isEngineExhausted(readEngineHealth(at(31)), "claude:overflow", at(31))).toBe(true);
  });

  it("does not clear a record that names the 7d window on a reading without a 7d window", () => {
    recordSpent();

    clearContradictedHealth("claude:overflow", [win("5h", 0)], at(30).getTime(), at(31));

    expect(isEngineExhausted(readEngineHealth(at(31)), "claude:overflow", at(31))).toBe(true);
  });

  it("does not clear a record that names no window on a reading with no window either: nothing was read", () => {
    recordSpent("claude:overflow", {});

    clearContradictedHealth("claude:overflow", [], at(30).getTime(), at(31));
    clearContradictedHealth("claude:overflow", undefined, at(30).getTime(), at(31));

    expect(isEngineExhausted(readEngineHealth(at(31)), "claude:overflow", at(31))).toBe(true);
  });

  it("clears a record that names no window on any complete reading", () => {
    recordSpent("claude:overflow", {});

    clearContradictedHealth("claude:overflow", [win("5h", 10)], at(30).getTime(), at(31));

    expect(readEngineHealth(at(31))["claude:overflow"]?.clearedAt).toBe(at(31).toISOString());
  });

  it.each([["another machine", "gateway-box"], ["this machine", os.hostname()]])("leaves a record about %s alone: a login is not an allowance", (_which, host) => {
    recordSpent("claude", { host, window: "7d" });
    const before = fs.readFileSync(STATE_PATH, "utf-8");

    clearContradictedHealth("claude", [win("7d", 0)], at(30).getTime(), at(31));

    expect(fs.readFileSync(STATE_PATH, "utf-8")).toBe(before);
  });

  it("clears a degraded record too", () => {
    recordEngineUnavailable("claude:overflow", "unreachable", undefined, NOW);

    clearContradictedHealth("claude:overflow", [win("7d", 0)], at(5).getTime(), at(6));

    expect(readEngineHealth(at(6))["claude:overflow"]?.clearedAt).toBe(at(6).toISOString());
  });

  it("writes nothing when there is nothing to clear (no record, a lapsed one, an ok one)", () => {
    clearContradictedHealth("claude", [win("7d", 0)], at(30).getTime(), at(31));
    expect(fs.existsSync(STATE_PATH)).toBe(false);

    recordSpent("claude:overflow", {});
    const before = fs.readFileSync(STATE_PATH, "utf-8");
    // Past its stated reset the record is spent already: nothing is left to contradict.
    clearContradictedHealth("claude:overflow", [win("7d", 0)], at(6 * 24 * 60).getTime(), at(6 * 24 * 60 + 1));
    expect(fs.readFileSync(STATE_PATH, "utf-8")).toBe(before);

    clearContradictedHealth("claude:overflow", [win("7d", 0)], at(30).getTime(), at(31));
    const cleared = fs.readFileSync(STATE_PATH, "utf-8");
    clearContradictedHealth("claude:overflow", [win("7d", 0)], at(60).getTime(), at(61));
    expect(fs.readFileSync(STATE_PATH, "utf-8")).toBe(cleared);
  });
});

describe("recordEngineServed", () => {
  it("clears an exhausted record on a turn that began after it was observed", () => {
    recordSpent();

    recordEngineServed("claude:overflow", at(10).getTime(), undefined, at(12));

    expect(readEngineHealth(at(12))["claude:overflow"]).toEqual({ state: "ok", clearedAt: at(12).toISOString(), observedAt: at(12).toISOString(), reason: "a turn was served" });
  });

  it("does not clear on a turn that began before someone else observed the limit", () => {
    recordSpent();

    recordEngineServed("claude:overflow", NOW.getTime() - 60_000, undefined, at(12));
    recordEngineServed("claude:overflow", NOW.getTime(), undefined, at(12));

    expect(isEngineExhausted(readEngineHealth(at(12)), "claude:overflow", at(12))).toBe(true);
  });

  describe("a limit a turn hit on one model", () => {
    const spentOn = (model: string | undefined) =>
      recordEngineUnavailable("claude:overflow", "usage limit", secondsAt(4 * 24 * 60), NOW, model === undefined ? {} : { model });
    const exhausted = () => isEngineExhausted(readEngineHealth(at(12)), "claude:overflow", at(12));

    it("is cleared by a turn served on that model", () => {
      spentOn("opus");
      recordEngineServed("claude:overflow", at(10).getTime(), "opus", at(12));
      expect(exhausted()).toBe(false);
    });

    it("is not cleared by a turn served on another model: the limit may be that model's own bucket", () => {
      spentOn("opus");
      recordEngineServed("claude:overflow", at(10).getTime(), "sonnet", at(12));
      expect(exhausted()).toBe(true);
    });

    it("is not cleared by a turn that names no model", () => {
      spentOn("opus");
      recordEngineServed("claude:overflow", at(10).getTime(), undefined, at(12));
      expect(exhausted()).toBe(true);
    });

    it("on the CLI default (no model) is cleared only by a turn on the default: an unnamed default may not be the model served", () => {
      spentOn(undefined);
      recordEngineServed("claude:overflow", at(10).getTime(), "sonnet", at(12));
      expect(exhausted()).toBe(true);
      recordEngineServed("claude:overflow", at(10).getTime(), undefined, at(12));
      expect(exhausted()).toBe(false);
    });

    it("is still cleared by a live reading showing headroom, whatever model it names", () => {
      spentOn("opus");
      clearContradictedHealth("claude:overflow", [win("5h", 0), win("7d", 0)], at(10).getTime(), at(12));
      expect(exhausted()).toBe(false);
    });

    it("keeps the model on the record, and a re-probe that names none does not keep a stale one", () => {
      spentOn("opus");
      expect(readEngineHealth(NOW)["claude:overflow"]?.model).toBe("opus");

      // The stated reset stands, the probe failed in an ordinary way: a re-probe, observing no model.
      recordEngineUnavailable("claude:overflow", "unreachable", undefined, at(5));
      expect(readEngineHealth(at(5))["claude:overflow"]?.state).toBe("exhausted");
      expect(readEngineHealth(at(5))["claude:overflow"]?.model).toBeUndefined();

      recordEngineUnavailable("claude:overflow", "usage limit", undefined, at(6), { model: "sonnet" });
      expect(readEngineHealth(at(6))["claude:overflow"]?.model).toBe("sonnet");
    });
  });

  describe("a spent window a reading recorded", () => {
    const exhausted = () => isEngineExhausted(readEngineHealth(at(12)), "claude:overflow", at(12));

    it.each(["5h", "7d"])("an account-wide %s window is cleared by a turn served on any model", (window) => {
      recordSpent("claude:overflow", { window });
      recordEngineServed("claude:overflow", at(10).getTime(), "sonnet", at(12));
      expect(exhausted()).toBe(false);
    });

    it("another engine's 5h/7d is left to readings: which windows its models share is not known", () => {
      recordSpent("codex", { window: "7d" });
      recordEngineServed("codex", at(10).getTime(), "gpt-5.5", at(12));
      expect(isEngineExhausted(readEngineHealth(at(12)), "codex", at(12))).toBe(true);
    });

    it("a 7d window a turn on one model then re-probed keeps that model's rule: another model's turn does not clear it", () => {
      recordSpent("claude:overflow", { window: "7d" });
      // The turn's limit stated no reset: a re-probe that keeps the window and stamps the model.
      recordEngineUnavailable("claude:overflow", "usage limit", undefined, at(5), { model: "opus" });
      recordEngineServed("claude:overflow", at(10).getTime(), "sonnet", at(12));
      expect(exhausted()).toBe(true);
      recordEngineServed("claude:overflow", at(10).getTime(), "opus", at(12));
      expect(exhausted()).toBe(false);
    });

    it("a window scoped to one model is never cleared by a served turn, even on a model that sounds like it: only a reading clears it", () => {
      recordSpent("claude:overflow", { window: "7d Opus" });
      recordEngineServed("claude:overflow", at(10).getTime(), "sonnet", at(12));
      recordEngineServed("claude:overflow", at(10).getTime(), "opus", at(12));
      recordEngineServed("claude:overflow", at(10).getTime(), undefined, at(12));
      expect(exhausted()).toBe(true);

      clearContradictedHealth("claude:overflow", [win("5h", 0), win("7d", 0), win("7d Opus", 10)], at(10).getTime(), at(12));
      expect(exhausted()).toBe(false);
    });
  });

  it.each([["another machine", "gateway-box"], ["this machine", os.hostname()]])("leaves a login record about %s alone and writes nothing", (_which, host) => {
    recordSpent("claude", { host });
    const before = fs.readFileSync(STATE_PATH, "utf-8");

    recordEngineServed("claude", at(10).getTime(), undefined, at(12));

    expect(fs.readFileSync(STATE_PATH, "utf-8")).toBe(before);
  });

  it("writes nothing for a key with no record", () => {
    recordEngineServed("claude", at(10).getTime(), undefined, at(12));

    expect(fs.existsSync(STATE_PATH)).toBe(false);
  });
});

describe("a clear versus a lapse", () => {
  it("reads a lapsed record back as ok with no clearedAt", () => {
    recordSpent();

    const lapsed = readEngineHealth(at(5 * 24 * 60))["claude:overflow"];

    expect(lapsed).toEqual({ state: "ok", observedAt: NOW.toISOString() });
    expect(lapsed?.clearedAt).toBeUndefined();
  });

  it("keeps clearedAt and the reason on a cleared record, long after the stated reset", () => {
    recordSpent();
    recordEngineServed("claude:overflow", at(10).getTime(), undefined, at(12));

    const later = readEngineHealth(at(10 * 24 * 60))["claude:overflow"];

    expect(later?.clearedAt).toBe(at(12).toISOString());
    expect(later?.reason).toBe("a turn was served");
    expect(stored()["claude:overflow"]?.state).toBe("ok");
  });

  it("is replaced by a fresh limit like any other record", () => {
    recordSpent();
    recordEngineServed("claude:overflow", at(10).getTime(), undefined, at(12));

    recordEngineUnavailable("claude:overflow", "usage limit", secondsAt(5 * 60), at(20), { window: "5h" });

    const record = readEngineHealth(at(21))["claude:overflow"];
    expect(record?.state).toBe("exhausted");
    expect(record?.clearedAt).toBeUndefined();
  });
});

describe("noteLimitReading", () => {
  const snapshot = (over: Partial<Parameters<typeof noteLimitReading>[1]>) => ({
    status: "live" as const, refreshedAt: at(30).toISOString(), windows: [win("5h", 0), win("7d", 0)], ...over,
  });

  it("clears on a live reading", () => {
    recordSpent();
    noteLimitReading("claude:overflow", snapshot({}));
    expect(readEngineHealth()["claude:overflow"]?.clearedAt).toBeDefined();
  });

  it("does not clear on a snapshot, fresh or not: the status line never sees per-model buckets", () => {
    recordSpent();
    noteLimitReading("claude:overflow", snapshot({ status: "snapshot" }));
    noteLimitReading("claude:overflow", snapshot({ status: "snapshot", stale: false } as never));
    expect(isEngineExhausted(readEngineHealth(at(31)), "claude:overflow", at(31))).toBe(true);
  });

  it("does not clear on a source that is not a reading", () => {
    recordSpent();
    for (const status of ["snapshot", "static", "unsupported", "unavailable", "error"] as const) noteLimitReading("claude:overflow", snapshot({ status }));
    expect(isEngineExhausted(readEngineHealth(at(31)), "claude:overflow", at(31))).toBe(true);
  });

  it("still records a window the provider reports as spent", () => {
    noteLimitReading("claude:overflow", snapshot({ refreshedAt: NOW.toISOString(), windows: [{ name: "5h", usedPercent: 100, resetsAt: Date.now() / 1000 + 3600 }] }));
    expect(readEngineHealth()["claude:overflow"]?.state).toBe("exhausted");
  });
});

describe("clearEngineHealthByOperator", () => {
  it("replaces any record, a host-scoped one included, and returns what it replaced", () => {
    recordSpent("claude", { host: "gateway-box" });

    const replaced = clearEngineHealthByOperator("claude", at(5));

    expect(replaced?.state).toBe("exhausted");
    expect(readEngineHealth(at(5)).claude).toEqual({ state: "ok", clearedAt: at(5).toISOString(), observedAt: at(5).toISOString(), reason: "cleared by the operator" });
  });

  it("says there was nothing when the key has no record, and writes nothing: a mistyped key leaves no stray record", () => {
    expect(clearEngineHealthByOperator("claude:none", at(5))).toBeUndefined();
    expect(fs.existsSync(STATE_PATH)).toBe(false);
  });
});
