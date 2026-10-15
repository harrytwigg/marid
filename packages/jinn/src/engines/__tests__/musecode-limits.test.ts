import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

// The snapshot file freezes its path from JINN_HOME at import.
const TEST_HOME = path.join(os.tmpdir(), "jinn-musecode-limits-test");
vi.mock("../../shared/paths.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../shared/paths.js")>()),
  JINN_HOME: path.join(os.tmpdir(), "jinn-musecode-limits-test"),
}));
vi.mock("../../shared/logger.js", () => ({ logger: { warn: vi.fn(), debug: vi.fn(), info: vi.fn(), error: vi.fn() } }));
vi.mock("../../sessions/employee-env.js", () => ({ employeeSessionEnv: () => ({}) }));

import { MusecodeEngine } from "../musecode.js";
import { musecodeModelCost, refreshMusecodeModels, invalidateModelRegistry } from "../../shared/models.js";
import { MUSECODE_USAGE_FILE, readMusecodeUsage, writeMusecodeUsage } from "../../shared/musecode-usage.js";
import { FAKE, opts, useFakeMuse } from "./helpers/fake-muse-harness.js";

useFakeMuse();

afterEach(() => fs.rmSync(TEST_HOME, { recursive: true, force: true }));

/** The engine as the gateway builds it. */
const wired = () => new MusecodeEngine({ onUsage: writeMusecodeUsage, modelCost: musecodeModelCost });

describe("usage/changed during a turn", () => {
  it("is kept in tmp/musecode-usage.json, owner-only, with the host's observedAtMs", async () => {
    const before = Date.now();
    await wired().run(opts({ prompt: "go\n---\nUSAGE" }));
    const kept = readMusecodeUsage();
    expect(kept).toMatchObject({ tier: "everyday", window: { usedPercent: 42, windowDurationMins: 300 }, weekly: { usedPercent: 17 } });
    expect(kept!.observedAtMs).toBeGreaterThanOrEqual(before);
    expect(fs.statSync(MUSECODE_USAGE_FILE).mode & 0o777).toBe(0o600);
  });

  it("writes nothing for a turn the host reported no usage on", async () => {
    await wired().run(opts());
    expect(fs.existsSync(MUSECODE_USAGE_FILE)).toBe(false);
  });
});

describe("the turn's cost from the discovered catalog", () => {
  const config = { engines: { default: "claude", musecode: { bin: FAKE } } } as never;
  afterEach(async () => {
    vi.stubEnv("FAKE_MUSE_MODELS", "");
    await refreshMusecodeModels({ engines: { default: "claude", musecode: { bin: path.join(TEST_HOME, "gone") } } } as never);
    invalidateModelRegistry();
  });

  it("prices the turn at the catalog's per-million rates (input minus cached, cached, output)", async () => {
    await refreshMusecodeModels(config);
    const result = await wired().run(opts({ model: "muse-spark-1.3" }));
    // The fake's turn used 100 input (20 of them cached) and 5 output tokens; the catalog says 1.50 / 0.15 / 7.50 per million.
    expect(result.cost).toBeCloseTo((80 * 1.5 + 20 * 0.15 + 5 * 7.5) / 1e6, 10);
  });

  it("prices a turn that names no model at the catalog's default", async () => {
    await refreshMusecodeModels(config);
    const result = await wired().run(opts());
    expect(result.cost).toBeCloseTo((80 * 1.5 + 20 * 0.15 + 5 * 7.5) / 1e6, 10);
  });

  it("omits cost, rather than reporting 0, when the catalog declares none for the model", async () => {
    await refreshMusecodeModels(config);
    const result = await wired().run(opts({ model: "muse-spark-1.2" }));
    expect(result.error).toBeUndefined();
    expect(result).not.toHaveProperty("cost");
  });

  it("omits cost before any catalog has been discovered", async () => {
    const result = await wired().run(opts({ model: "muse-spark-1.3" }));
    expect(result).not.toHaveProperty("cost");
  });
});
