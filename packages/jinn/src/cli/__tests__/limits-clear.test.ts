import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * `jinn limits --clear <key>`: the operator's way to end a recorded limit the
 * usage readout cannot see lifted. It writes a clear for the key whatever the
 * record holds, says what it replaced, and shows no limits.
 */

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "jinn-limits-clear-"));
process.env.JINN_HOME = tmp;
const collect = vi.fn();
vi.mock("../../shared/engine-limits.js", () => ({ collectEngineLimits: (...args: unknown[]) => collect(...args) }));
vi.mock("../../shared/config.js", async (importOriginal) => ({ ...(await importOriginal<typeof import("../../shared/config.js")>()), loadConfig: () => ({ engines: {} }) }));

// The readout path discovers models by running each engine's CLI; none of that is under test.
vi.mock("../../shared/models.js", async (importOriginal) => {
  const none = async () => {};
  return { ...(await importOriginal<typeof import("../../shared/models.js")>()), refreshPiModels: none, refreshOpencodeModels: none, refreshGrokModels: none, refreshMusecodeModels: none, refreshHermesModels: none };
});

const { runLimits } = await import("../limits.js");
const { readEngineHealth, recordEngineUnavailable } = await import("../../shared/engine-health.js");

let out: string[];
beforeEach(() => {
  out = [];
  collect.mockClear();
  vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => { out.push(args.map(String).join(" ")); });
  fs.rmSync(path.join(tmp, "tmp", "engine-health.json"), { force: true });
});
afterEach(() => vi.restoreAllMocks());

describe("limits --clear", () => {
  it("clears an exhausted record, says what it replaced, and collects no limits", async () => {
    recordEngineUnavailable("claude", "usage limit", Date.now() / 1000 + 4 * 24 * 3600, new Date(), { window: "7d" });

    await runLimits({ clear: "claude" });

    expect(readEngineHealth().claude).toMatchObject({ state: "ok", clearedAt: expect.any(String), reason: "cleared by the operator" });
    expect(out[0]).toMatch(/^Cleared claude \(was exhausted, until \d{4}-.*, window 7d\)\.$/);
    expect(collect).not.toHaveBeenCalled();
  });

  it("clears a host-scoped record too: the operator decides", async () => {
    recordEngineUnavailable("claude", "authentication failed", Date.now() / 1000 + 3600, new Date(), { host: "build-box" });

    await runLimits({ clear: "claude" });

    expect(readEngineHealth().claude?.clearedAt).toBeDefined();
    expect(out[0]).toContain("host build-box");
  });

  it("says there was nothing for a key with no record, and writes no record for it", async () => {
    await runLimits({ clear: "claude:friend01" });

    expect(out).toEqual(["Nothing to clear: claude:friend01 has no record (a key is an engine, or a Claude account such as claude:<profile>)."]);
    expect(readEngineHealth()["claude:friend01"]).toBeUndefined();
  });

  it("without --clear still reads the limits and touches no record", async () => {
    recordEngineUnavailable("claude", "usage limit", Date.now() / 1000 + 4 * 24 * 3600, new Date());
    collect.mockResolvedValue({ generatedAt: new Date().toISOString(), default: "claude", engines: {} });

    await runLimits({});

    expect(collect).toHaveBeenCalledTimes(1);
    expect(readEngineHealth().claude?.state).toBe("exhausted");
  });
});
