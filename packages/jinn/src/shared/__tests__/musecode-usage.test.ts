import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { MuseUsageSnapshot } from "../../engines/musecode-turn.js";
import { MUSECODE_USAGE_FILE, readMusecodeUsage, writeMusecodeUsage } from "../musecode-usage.js";

const usage = (observedAtMs: number, used = 42): MuseUsageSnapshot => ({
  observedAtMs,
  tier: "everyday",
  window: { usedPercent: used, windowDurationMins: 300, resetsAtMs: observedAtMs + 3_600_000 },
  weekly: { usedPercent: 17, resetsAtMs: observedAtMs + 86_400_000 },
});

describe("the Muse Code usage snapshot file", () => {
  let dir: string;
  let file: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "musecode-usage-"));
    file = path.join(dir, "tmp", "musecode-usage.json");
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  it("lives at tmp/musecode-usage.json under the instance home", () => {
    expect(MUSECODE_USAGE_FILE.split(path.sep).slice(-2)).toEqual(["tmp", "musecode-usage.json"]);
  });

  it("writes the snapshot whole, owner-only, with the host's observedAtMs, and leaves no temp file", () => {
    writeMusecodeUsage(usage(1_000_000), file);
    expect(JSON.parse(fs.readFileSync(file, "utf8"))).toEqual(usage(1_000_000));
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    expect(fs.readdirSync(path.dirname(file))).toEqual(["musecode-usage.json"]);
    expect(readMusecodeUsage(file)).toEqual(usage(1_000_000));
  });

  it("replaces a snapshot with a newer one but never with an older one", () => {
    writeMusecodeUsage(usage(2_000_000, 50), file);
    writeMusecodeUsage(usage(1_000_000, 10), file);
    expect(readMusecodeUsage(file)?.window.usedPercent).toBe(50);
    writeMusecodeUsage(usage(3_000_000, 60), file);
    expect(readMusecodeUsage(file)?.window.usedPercent).toBe(60);
  });

  it("reads a missing, corrupt or wrongly shaped file as no data", () => {
    expect(readMusecodeUsage(file)).toBeUndefined();
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, "{not json");
    expect(readMusecodeUsage(file)).toBeUndefined();
    fs.writeFileSync(file, JSON.stringify({ observedAtMs: 1, tier: "x" }));
    expect(readMusecodeUsage(file)).toBeUndefined();
  });

  it("does not throw when the file cannot be written", () => {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.mkdirSync(file); // a directory where the file should go
    expect(() => writeMusecodeUsage(usage(1), file)).not.toThrow();
  });
});
