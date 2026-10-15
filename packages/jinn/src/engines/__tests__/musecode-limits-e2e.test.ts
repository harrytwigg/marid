import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

// The usage snapshot freezes its path from JINN_HOME at import.
const TEST_HOME = path.join(os.tmpdir(), "jinn-musecode-limits-e2e-home");
vi.mock("../../shared/paths.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../shared/paths.js")>()),
  JINN_HOME: path.join(os.tmpdir(), "jinn-musecode-limits-e2e-home"),
}));

import type { JinnConfig } from "../../shared/types.js";
import { MusecodeEngine } from "../musecode.js";
import { discoverMusecodeModels } from "../../shared/musecode-models.js";
import { MUSECODE_USAGE_FILE, readMusecodeUsage, writeMusecodeUsage } from "../../shared/musecode-usage.js";
import { collectMusecodeLimits } from "../../shared/engine-limits-musecode.js";
import { invalidateModelRegistry } from "../../shared/models.js";

/**
 * Model discovery and the usage snapshot against the REAL Muse Code binary.
 * Off unless asked for, as musecode-e2e.test.ts:
 *
 *   MUSECODE_E2E=1 MUSECODE_BIN=/path/to/muse vitest run src/engines/__tests__/musecode-limits-e2e.test.ts
 *
 * The binary is pointed at a mock Meta provider that serves a priced catalog
 * and reports subscription usage, and runs with a scratch HOME.
 */

const ENABLED = process.env.MUSECODE_E2E === "1" && !!process.env.MUSECODE_BIN;
const BIN = process.env.MUSECODE_BIN ?? "";
const FIXTURES = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures");

let scratch: string;
let mock: ChildProcess | undefined;

async function startMock(): Promise<number> {
  mock = spawn(process.execPath, [path.join(FIXTURES, "musecode-mock-provider.mjs"), "0", path.join(scratch, "mock.log"), path.join(FIXTURES, "musecode-catalog-priced.json")], {
    stdio: ["ignore", "pipe", "inherit"],
  });
  return await new Promise<number>((resolve, reject) => {
    mock!.once("error", reject);
    mock!.stdout!.once("data", (d: Buffer) => resolve(Number(String(d).trim().split(" ")[1])));
  });
}

const flags = (port: number) => ["-c", `endpoint_transport.base_url="http://127.0.0.1:${port}"`, "-c", "run.reminder_roster=[]"];

describe.skipIf(!ENABLED)("Muse Code models and usage (real binary)", () => {
  beforeAll(() => {
    scratch = fs.mkdtempSync(path.join(os.tmpdir(), "musecode-limits-e2e-"));
    fs.mkdirSync(path.join(scratch, "ws"), { recursive: true });
  });
  beforeEach(() => {
    invalidateModelRegistry();
    vi.stubEnv("HOME", path.join(scratch, "home"));
    vi.stubEnv("META_API_KEY", "test-key");
    fs.mkdirSync(path.join(scratch, "home"), { recursive: true });
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    mock?.kill();
    mock = undefined;
    fs.rmSync(TEST_HOME, { recursive: true, force: true });
  });
  afterAll(() => fs.rmSync(scratch, { recursive: true, force: true }));

  it("lists the mock provider's catalog: ids, labels, efforts without none, context, cost, the host's default", async () => {
    const port = await startMock();
    const found = await discoverMusecodeModels(BIN, { cliFlags: flags(port) });
    expect(found.models.map((m) => m.id).sort()).toEqual(["muse-spark-1.2", "muse-spark-1.3"]);
    const newer = found.models.find((m) => m.id === "muse-spark-1.3")!;
    expect(newer).toMatchObject({ label: "muse-spark-1.3", supportsEffort: true, contextWindow: 262144 });
    expect(newer.effortLevels.length).toBeGreaterThan(0);
    expect(newer.effortLevels).not.toContain("none");
    expect(found.costs["muse-spark-1.3"]).toEqual({ input: 1.5, cached: 0.15, output: 7.5 });
    expect(found.costs["muse-spark-1.2"]).toEqual({ input: 1, cached: 0.1, output: 5 });
    // The host names its own default (the newest release); the catalog's `roles` do not decide it.
    expect(found.defaultModel).toBe("muse-spark-1.3");
  }, 60_000);

  it("finds no models, and does not throw, when a host with no cached catalog cannot fetch one", async () => {
    // Muse keeps the last catalog it fetched under $HOME, so this needs a home that has never had one.
    vi.stubEnv("HOME", fs.mkdtempSync(path.join(scratch, "fresh-home-")));
    const found = await discoverMusecodeModels(BIN, { cliFlags: ["-c", 'endpoint_transport.base_url="http://127.0.0.1:1"'] });
    expect(found.models).toEqual([]);
  }, 60_000);

  it("carries usage/changed from a turn into the snapshot file, and the collector reports it", async () => {
    const port = await startMock();
    const engine = new MusecodeEngine({ onUsage: writeMusecodeUsage });
    const result = await engine.run({
      prompt: "Explain what this repository does in one sentence.",
      cwd: path.join(scratch, "ws"),
      bin: BIN,
      sessionId: "limits-e2e",
      model: "muse-spark-1.2",
      cliFlags: flags(port),
    });
    expect(result.error).toBeUndefined();

    const kept = readMusecodeUsage();
    expect(kept).toMatchObject({ tier: "everyday", window: { usedPercent: 42, windowDurationMins: 300 }, weekly: { usedPercent: 17 } });
    expect(fs.statSync(MUSECODE_USAGE_FILE).mode & 0o777).toBe(0o600);

    const config = { engines: { default: "claude", musecode: { bin: BIN } } } as unknown as JinnConfig;
    const snap = collectMusecodeLimits(config);
    expect(snap).toMatchObject({ status: "snapshot", source: "muse usage/changed", accountPlan: "everyday", stale: false });
    expect(snap.windows?.map((w) => [w.name, w.usedPercent])).toEqual([["5h", 42], ["weekly", 17]]);
  }, 90_000);

  it("prices a turn from the catalog's rates and the host's token usage (its turn/completed carries none, so session/tokenUsage is summed)", async () => {
    const port = await startMock();
    const found = await discoverMusecodeModels(BIN, { cliFlags: flags(port) });
    const engine = new MusecodeEngine({ modelCost: (model) => found.costs[model ?? ""] });
    const result = await engine.run({
      prompt: "Explain what this repository does in one sentence.",
      cwd: path.join(scratch, "ws"),
      bin: BIN,
      sessionId: "cost-e2e",
      model: "muse-spark-1.2",
      cliFlags: flags(port),
    });
    expect(result.error).toBeUndefined();
    // The mock provider reports 100 input and 5 output tokens; the catalog prices muse-spark-1.2 at 1.00 / 0.10 / 5.00 per million.
    expect(result.cost).toBeCloseTo((100 * 1 + 5 * 5) / 1e6, 10);
  }, 90_000);

  it("reports no usage, with the first-turn message, before any turn has run", async () => {
    const config = { engines: { default: "claude", musecode: { bin: BIN } } } as unknown as JinnConfig;
    const snap = collectMusecodeLimits(config);
    expect(snap.status).toBe("unavailable");
    expect(snap.unsupportedReason).toMatch(/after the first Muse Code turn/);
  }, 60_000);
});
