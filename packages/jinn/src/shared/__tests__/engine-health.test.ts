import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// The store freezes its path from JINN_HOME at import, and the run's shared temp
// home would let a suite in another worker see — or clear — these records.
const TEST_HOME = path.join(os.tmpdir(), "jinn-engine-health-test");
vi.mock("../paths.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../paths.js")>()),
  JINN_HOME: path.join(os.tmpdir(), "jinn-engine-health-test"),
}));

import {
  isEngineExhausted,
  readEngineHealth,
  recordEngineUnavailable,
  recordExhaustedWindows,
} from "../engine-health.js";

const STATE_PATH = path.join(TEST_HOME, "tmp", "engine-health.json");
const NOW = new Date("2026-08-19T10:00:00.000Z");
const at = (minutes: number) => new Date(NOW.getTime() + minutes * 60_000);
/** Unix seconds, which is the unit every caller carries a stated reset in. */
const secondsAt = (minutes: number) => at(minutes).getTime() / 1000;

beforeEach(() => {
  fs.mkdirSync(path.dirname(STATE_PATH), { recursive: true });
  fs.rmSync(STATE_PATH, { force: true });
});

afterEach(() => {
  fs.rmSync(TEST_HOME, { recursive: true, force: true });
});

describe("recordEngineUnavailable", () => {
  it("records an engine exhausted until the reset it stated", () => {
    recordEngineUnavailable("codex", "out of quota", secondsAt(90), NOW);

    expect(readEngineHealth(NOW).codex).toEqual({
      state: "exhausted",
      until: at(90).toISOString(),
      recheckAt: at(90).toISOString(),
      reason: "out of quota",
      observedAt: NOW.toISOString(),
    });
  });

  it("records a failure that stated no reset as degraded, which never blocks", () => {
    recordEngineUnavailable("codex", "unreachable", undefined, NOW);

    expect(readEngineHealth(NOW).codex?.state).toBe("degraded");
    expect(isEngineExhausted(readEngineHealth(NOW), "codex")).toBe(false);
  });

  it("stores a reset further out than twelve hours verbatim rather than clamping it", () => {
    recordEngineUnavailable("codex", "out of quota", secondsAt(3 * 24 * 60), NOW);

    expect(readEngineHealth(NOW).codex?.until).toBe(at(3 * 24 * 60).toISOString());
  });

  it("re-probes at the stated reset or twelve hours out, whichever comes first", () => {
    recordEngineUnavailable("codex", "out of quota", secondsAt(3 * 24 * 60), NOW);
    recordEngineUnavailable("claude", "out of quota", secondsAt(90), NOW);

    expect(readEngineHealth(NOW).codex?.recheckAt).toBe(at(12 * 60).toISOString());
    expect(readEngineHealth(NOW).claude?.recheckAt).toBe(at(90).toISOString());
  });

  it("keeps one record per engine", () => {
    recordEngineUnavailable("codex", "out of quota", secondsAt(90), NOW);
    recordEngineUnavailable("claude", "rate-limited", secondsAt(30), NOW);

    expect(Object.keys(readEngineHealth(NOW)).sort()).toEqual(["claude", "codex"]);
  });
});

describe("isEngineExhausted", () => {
  const threeDays = 3 * 24 * 60;

  it("stops steering dispatch at the re-probe while the reading keeps the true reset", () => {
    recordEngineUnavailable("codex", "out of quota", secondsAt(threeDays), NOW);
    const before = at(12 * 60 - 1);
    const after = at(12 * 60);

    expect(isEngineExhausted(readEngineHealth(before), "codex", before)).toBe(true);
    expect(isEngineExhausted(readEngineHealth(after), "codex", after)).toBe(false);
    // The same instant, on the surfaces the operator reads: still out, still until the true reset.
    expect(readEngineHealth(after).codex).toMatchObject({
      state: "exhausted",
      until: at(threeDays).toISOString(),
    });
  });

  it("blocks until the stated reset on a record written before re-probes existed", () => {
    fs.writeFileSync(STATE_PATH, JSON.stringify({ codex: { state: "exhausted", until: at(90).toISOString() } }));

    expect(isEngineExhausted(readEngineHealth(at(89)), "codex", at(89))).toBe(true);
    expect(isEngineExhausted(readEngineHealth(at(91)), "codex", at(91))).toBe(false);
  });
});

describe("a re-probe that fails again", () => {
  const threeDays = 3 * 24 * 60;
  const reprobe = at(12 * 60);
  const twelveHoursOn = new Date(reprobe.getTime() + 12 * 60 * 60_000).toISOString();

  it("keeps the stated reset and pushes the next re-probe twelve hours out", () => {
    recordEngineUnavailable("codex", "out of quota", secondsAt(threeDays), NOW);
    recordEngineUnavailable("codex", "out of quota", secondsAt(threeDays), reprobe);

    expect(readEngineHealth(reprobe).codex).toMatchObject({
      until: at(threeDays).toISOString(),
      recheckAt: twelveHoursOn,
    });
  });

  it("keeps a live exhausted record rather than downgrading it when it states no reset", () => {
    recordEngineUnavailable("codex", "out of quota", secondsAt(threeDays), NOW);
    recordEngineUnavailable("codex", "unreachable", undefined, reprobe);

    expect(readEngineHealth(reprobe).codex).toMatchObject({
      state: "exhausted",
      until: at(threeDays).toISOString(),
      recheckAt: twelveHoursOn,
      reason: "unreachable",
    });
  });

  it("records degraded when the record it would have kept has already been spent", () => {
    recordEngineUnavailable("codex", "out of quota", secondsAt(90), NOW);
    recordEngineUnavailable("codex", "unreachable", undefined, at(91));

    expect(readEngineHealth(at(91)).codex?.state).toBe("degraded");
  });
});

describe("readEngineHealth", () => {
  it("reads a record back as ok once the window it stated has passed", () => {
    recordEngineUnavailable("codex", "out of quota", secondsAt(90), NOW);

    expect(readEngineHealth(at(89)).codex?.state).toBe("exhausted");
    expect(readEngineHealth(at(91)).codex?.state).toBe("ok");
    // Nothing swept: the record on disk is untouched, the clock decided.
    expect(JSON.parse(fs.readFileSync(STATE_PATH, "utf-8")).codex.state).toBe("exhausted");
  });

  it("reports nothing for an engine no failure has been observed on", () => {
    expect(readEngineHealth(NOW).codex).toBeUndefined();
    expect(isEngineExhausted(readEngineHealth(NOW), "codex")).toBe(false);
  });

  it("ignores a store that is corrupt or holds a state it does not know", () => {
    fs.writeFileSync(STATE_PATH, "{not json");
    expect(readEngineHealth(NOW)).toEqual({});

    fs.writeFileSync(STATE_PATH, JSON.stringify({ codex: { state: "on fire" }, claude: null }));
    expect(readEngineHealth(NOW)).toEqual({});
  });

  it("treats an until it cannot parse as spent rather than as a permanent block", () => {
    fs.writeFileSync(STATE_PATH, JSON.stringify({ codex: { state: "exhausted", until: "whenever" } }));

    expect(isEngineExhausted(readEngineHealth(NOW), "codex")).toBe(false);
  });
});

describe("recordExhaustedWindows", () => {
  const spent = (name: string, minutesOut: number) => ({ name, usedPercent: 100, resetsAt: secondsAt(minutesOut) });

  it("records the last of several spent windows to reopen", () => {
    recordExhaustedWindows("codex", [spent("5h", 60), spent("7d", 240)], NOW);

    expect(readEngineHealth(NOW).codex).toMatchObject({ state: "exhausted", until: at(240).toISOString() });
  });

  it("names the window that binds, so the display can say which limit is spent", () => {
    recordExhaustedWindows("codex", [spent("5h", 60), spent("7d", 3 * 24 * 60)], NOW);

    expect(readEngineHealth(NOW).codex).toMatchObject({ window: "7d", until: at(3 * 24 * 60).toISOString() });
  });

  it("ignores a window with allowance left, or one that has already reopened", () => {
    recordExhaustedWindows("codex", [{ name: "5h", usedPercent: 99, resetsAt: secondsAt(60) }], NOW);
    recordExhaustedWindows("claude", [spent("5h", -60)], NOW);

    expect(readEngineHealth(NOW)).toEqual({});
  });
});
