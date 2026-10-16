import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildRegistry, invalidateModelRegistry, refreshOpencodeModels } from "../models.js";
import type { JinnConfig } from "../types.js";

/**
 * From the CLI to the registry the meter reads: discovery runs `opencode models
 * --verbose` (a stand-in binary printing a real capture), and a window the
 * operator configured still wins over the one opencode reports.
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

const config = (models: Array<{ id: string; contextWindow?: number }> = []) => ({
  gateway: {},
  engines: { default: "claude", opencode: { bin } },
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
