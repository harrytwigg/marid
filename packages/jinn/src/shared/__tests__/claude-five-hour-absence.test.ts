import { describe, it, expect, beforeEach, afterAll } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  nextFiveHourAbsence,
  settleFiveHourAbsence,
  STATUSLINE_EVIDENCE_MAX_AGE_MS,
  withoutZeroFiveHour,
  type ClaudeStatuslineEvidence,
  type FiveHourEvidence,
} from "../claude-five-hour-absence.js";
import type { EngineLimitWindow } from "../types.js";

const NOW = Date.parse("2026-11-06T13:00:00.000Z");
const HOUR = 60 * 60_000;
const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "jinn-five-hour-absence-"));
const FILE = path.join(ROOT, "claude-five-hour-absent.claude.json");

const win = (name: string, usedPercent: number): EngineLimitWindow => ({ name, usedPercent });
const weeklyOnly = (ageMs: number): ClaudeStatuslineEvidence => ({ windows: [win("7d", 37)], capturedAtMs: NOW - ageMs });
const withFiveHour = (ageMs: number): ClaudeStatuslineEvidence => ({ windows: [win("5h", 0), win("7d", 37)], capturedAtMs: NOW - ageMs });
const zeroSession = [win("5h", 0), win("7d", 37)];

function evidence(over: Partial<FiveHourEvidence>): FiveHourEvidence {
  return { statusline: null, usageWindows: zeroSession, nowMs: NOW, ...over };
}

beforeEach(() => fs.rmSync(FILE, { force: true }));
afterAll(() => fs.rmSync(ROOT, { recursive: true, force: true }));

describe("nextFiveHourAbsence", () => {
  it("is established by a recent weekly-only snapshot, with the plan it was seen on", () => {
    expect(nextFiveHourAbsence(undefined, evidence({ statusline: weeklyOnly(10 * 60_000), accountPlan: "team" })))
      .toEqual({ since: new Date(NOW).toISOString(), accountPlan: "team" });
  });

  it("is not established by a weekly-only snapshot older than five hours, or by no snapshot", () => {
    expect(nextFiveHourAbsence(undefined, evidence({ statusline: weeklyOnly(STATUSLINE_EVIDENCE_MAX_AGE_MS + 1) }))).toBeUndefined();
    expect(nextFiveHourAbsence(undefined, evidence({}))).toBeUndefined();
  });

  it("is never established while the snapshot carries a five-hour window", () => {
    expect(nextFiveHourAbsence(undefined, evidence({ statusline: withFiveHour(0) }))).toBeUndefined();
  });

  it("outlives the snapshot that proved it: idle for days, or the snapshot gone", () => {
    const stored = { since: "2026-11-01T09:00:00.000Z", accountPlan: "team" };
    expect(nextFiveHourAbsence(stored, evidence({ statusline: weeklyOnly(3 * 24 * HOUR), accountPlan: "team" }))).toBe(stored);
    expect(nextFiveHourAbsence(stored, evidence({ statusline: null, accountPlan: "team" }))).toBe(stored);
  });

  it("is cleared by any snapshot that carries a five-hour window, however old", () => {
    const stored = { since: "2026-11-01T09:00:00.000Z" };
    expect(nextFiveHourAbsence(stored, evidence({ statusline: withFiveHour(2 * 24 * HOUR) }))).toBeUndefined();
  });

  it("is cleared by a usage-API five-hour reading above zero", () => {
    const stored = { since: "2026-11-01T09:00:00.000Z" };
    expect(nextFiveHourAbsence(stored, evidence({ usageWindows: [win("5h", 3), win("7d", 37)] }))).toBeUndefined();
  });

  it("is recomputed on a plan change: cleared, and re-established only by a recent weekly-only snapshot", () => {
    const stored = { since: "2026-11-01T09:00:00.000Z", accountPlan: "team" };
    expect(nextFiveHourAbsence(stored, evidence({ statusline: weeklyOnly(6 * HOUR), accountPlan: "max" }))).toBeUndefined();
    expect(nextFiveHourAbsence(stored, evidence({ statusline: weeklyOnly(10 * 60_000), accountPlan: "max" })))
      .toEqual({ since: new Date(NOW).toISOString(), accountPlan: "max" });
  });

  it("is not cleared when the plan cannot be read this time, and learns the plan when it can", () => {
    const stored = { since: "2026-11-01T09:00:00.000Z", accountPlan: "team" };
    expect(nextFiveHourAbsence(stored, evidence({ accountPlan: undefined }))).toBe(stored);
    expect(nextFiveHourAbsence({ since: stored.since }, evidence({ accountPlan: "team" }))).toEqual(stored);
  });
});

describe("settleFiveHourAbsence", () => {
  it("stores the finding, answers from it once the evidence has aged, and removes it on contrary evidence", () => {
    expect(settleFiveHourAbsence("claude", evidence({ statusline: weeklyOnly(0), accountPlan: "team" }), FILE)).toBe(true);
    expect(JSON.parse(fs.readFileSync(FILE, "utf-8"))).toMatchObject({ accountPlan: "team" });

    const later = { nowMs: NOW + 2 * 24 * HOUR, accountPlan: "team" };
    expect(settleFiveHourAbsence("claude", evidence({ statusline: weeklyOnly(0), ...later }), FILE)).toBe(true);
    expect(settleFiveHourAbsence("claude", evidence({ statusline: null, ...later }), FILE)).toBe(true);

    expect(settleFiveHourAbsence("claude", evidence({ statusline: withFiveHour(0), ...later }), FILE)).toBe(false);
    expect(fs.existsSync(FILE)).toBe(false);
  });

  it("treats an unreadable store as no finding", () => {
    fs.writeFileSync(FILE, "{not json");
    expect(settleFiveHourAbsence("claude", evidence({}), FILE)).toBe(false);
  });
});

describe("withoutZeroFiveHour", () => {
  it("drops only a five-hour window at zero", () => {
    expect(withoutZeroFiveHour(zeroSession).map((w) => w.name)).toEqual(["7d"]);
    expect(withoutZeroFiveHour([win("5h", 100), win("7d", 37)]).map((w) => w.name)).toEqual(["5h", "7d"]);
  });
});
