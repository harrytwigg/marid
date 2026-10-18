import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildRegistry, effortLevelsForModel, exactEffortLevelsForModel, invalidateModelRegistry, refreshOpencodeModels } from "../models.js";
import type { JinnConfig } from "../types.js";

/**
 * From the CLI to the registry the meter reads: discovery runs `opencode models
 * --verbose` (a stand-in binary printing a real capture), and a window or an
 * effort list the operator configured still wins over the one opencode reports.
 */
let dir: string;
let bin: string;

beforeAll(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "oc-registry-"));
  bin = path.join(dir, "opencode");
  const fixture = path.join(__dirname, "fixtures", "opencode-models-verbose.txt");
  fs.writeFileSync(bin, `#!/bin/sh\n[ "$1 $2" = "models --verbose" ] && cat "${fixture}"\n`, { mode: 0o755 });
});

afterAll(async () => {
  fs.rmSync(dir, { recursive: true, force: true });
  // Leave no discovered catalog behind for other files in this worker.
  await refreshOpencodeModels({ gateway: {}, engines: { default: "claude", opencode: { bin: path.join(dir, "missing") } }, sessions: {} } as unknown as JinnConfig);
  invalidateModelRegistry();
});

const config = (models: Array<{ id: string; contextWindow?: number; supportsEffort?: boolean; effortLevels?: string[] }> = [], pinned?: string) => ({
  gateway: {},
  engines: { default: "claude", opencode: { bin, ...(pinned ? { model: pinned } : {}) } },
  sessions: {},
  ...(models.length ? { models: { opencode: { models: models.map((m) => ({ label: m.id, ...m })) } } } : {}),
}) as unknown as JinnConfig;

const windows = (cfg: JinnConfig) => Object.fromEntries(buildRegistry(cfg).opencode.models.map((m) => [m.id, m.contextWindow]));

describe("opencode registry entry windows", () => {
  it("carries each discovered window", async () => {
    await refreshOpencodeModels(config());
    expect(windows(config())).toEqual({
      "opencode/big-pickle": 200_000,
      "opencode/exo-free": 1_048_576,
      "opencode/step-5-preview-free": 1_000_000,
    });
  });

  it("lets a configured window override a discovered one, and leaves the rest alone", async () => {
    await refreshOpencodeModels(config());
    expect(windows(config([{ id: "opencode/exo-free", contextWindow: 128_000 }, { id: "opencode/not-listed", contextWindow: 9 }, { id: "opencode/big-pickle" }]))).toEqual({
      "opencode/big-pickle": 200_000,
      "opencode/exo-free": 128_000,
      "opencode/step-5-preview-free": 1_000_000,
    });
  });
});

describe("opencode registry entry effort", () => {
  const levels = (cfg: JinnConfig) => Object.fromEntries(buildRegistry(cfg).opencode.models.map((m) => [m.id, m.supportsEffort ? m.effortLevels : null]));

  it("uses the variant mechanism and gives each model the variants it has", async () => {
    await refreshOpencodeModels(config());
    expect(buildRegistry(config()).opencode.effortMechanism).toBe("opencode-variant");
    expect(levels(config())).toEqual({
      "opencode/big-pickle": null,
      "opencode/exo-free": ["high"],
      "opencode/step-5-preview-free": ["low", "medium", "high"],
    });
  });

  it("keeps a pinned model discovery has not seen without effort", async () => {
    await refreshOpencodeModels(config());
    const registry = buildRegistry(config([], "anthropic/claude-sonnet-5")).opencode;
    expect(registry.defaultModel).toBe("anthropic/claude-sonnet-5");
    expect(registry.models[0]).toMatchObject({ id: "anthropic/claude-sonnet-5", supportsEffort: false, effortLevels: [] });
  });

  it("lets configured levels win over discovered ones, and give a model without variants its own", async () => {
    await refreshOpencodeModels(config());
    expect(levels(config([
      { id: "opencode/exo-free", effortLevels: ["medium", "high"] },
      { id: "opencode/big-pickle", supportsEffort: true, effortLevels: ["low"] },
      { id: "opencode/step-5-preview-free", supportsEffort: false },
    ]))).toEqual({
      "opencode/big-pickle": ["low"],
      "opencode/exo-free": ["medium", "high"],
      "opencode/step-5-preview-free": null,
    });
  });

  it("answers for exactly the model asked about", async () => {
    await refreshOpencodeModels(config());
    const cfg = config();
    expect(exactEffortLevelsForModel(cfg, "opencode", "opencode/exo-free")).toEqual(["high"]);
    expect(exactEffortLevelsForModel(cfg, "opencode", "opencode/big-pickle")).toEqual([]);
    // Not listed, or no model named: none, where effortLevelsForModel falls back to the default model's.
    expect(exactEffortLevelsForModel(cfg, "opencode", "opencode/unlisted")).toEqual([]);
    expect(exactEffortLevelsForModel(cfg, "opencode", undefined)).toEqual([]);
    expect(exactEffortLevelsForModel(cfg, "nope", "opencode/exo-free")).toEqual([]);
    invalidateModelRegistry();
    const pinned = config([], "opencode/exo-free");
    expect(effortLevelsForModel(pinned, "opencode", "opencode/unlisted")).toEqual(["high"]);
    expect(exactEffortLevelsForModel(pinned, "opencode", "opencode/unlisted")).toEqual([]);
  });
});
