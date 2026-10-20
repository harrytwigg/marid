import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";

/** The cached limits reading: the newest sample of an account's history, read again only when the file changes. */

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fallback-limits-"));
vi.mock("../paths.js", async (importOriginal) => ({ ...(await importOriginal<typeof import("../paths.js")>()), ENGINE_LIMITS_DIR: dir }));

const { latestLimitReadings } = await import("../fallback-chain-limits.js");
const { USAGE_HISTORY_PATH } = await import("../claude-usage-history.js");

const config = { engines: { claude: {} } } as never;
const sample = (at: number, usedPercent: number) => ({ at, windows: [{ name: "5h", usedPercent, resetsAt: 4_000_000_000 }] });

describe("latestLimitReadings", () => {
  it("is the newest sample of each account's history, and nothing for an account with none", () => {
    expect(latestLimitReadings(config, ["claude:none"])).toEqual({ claude: undefined, "claude:none": undefined });
    fs.writeFileSync(USAGE_HISTORY_PATH, JSON.stringify([sample(1, 10), sample(2, 20)]));
    expect(latestLimitReadings(config).claude).toEqual(sample(2, 20));
  });

  it("serves a changed file's newest sample, and an unchanged file from memory without reading it again", () => {
    const read = vi.spyOn(fs, "readFileSync");
    latestLimitReadings(config);
    const unchanged = read.mock.calls.filter(([file]) => file === USAGE_HISTORY_PATH).length;
    expect(unchanged).toBe(0);
    fs.writeFileSync(USAGE_HISTORY_PATH, JSON.stringify([sample(1, 10), sample(2, 20), sample(3, 99)]));
    expect(latestLimitReadings(config).claude).toEqual(sample(3, 99));
    read.mockRestore();
  });
});
