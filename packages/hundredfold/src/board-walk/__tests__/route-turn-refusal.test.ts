import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

/** The walk skips a tick when its runner's engine is recorded as out: opencode by the runner's model's provider as well as by the engine's own key. */

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "hundredfold-walk-refusal-"));
process.env.HUNDREDFOLD_HOME = tmp;
vi.mock("../../shared/models.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../shared/models.js")>()),
  engineAvailable: () => true,
}));
vi.mock("../../shared/paths.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../shared/paths.js")>()),
  HUNDREDFOLD_HOME: tmp,
}));

const { runnerRefusal } = await import("../route-turn.js");
const { recordEngineUnavailable } = await import("../../shared/engine-health.js");
import type { Employee, HundredfoldConfig } from "../../shared/types.js";
import type { BoardWalkSettings } from "../settings.js";

const STATE_PATH = path.join(tmp, "tmp", "engine-health.json");
const config = { engines: { default: "claude", claude: { bin: "claude", model: "sonnet" }, opencode: { bin: "opencode", model: "opencode-go-b/flash" } } } as unknown as HundredfoldConfig;
const settings = { engine: "opencode" } as BoardWalkSettings;
const runner = (model: string) => ({ name: "r", engine: "opencode", model }) as Employee;
const spend = (key: string) => {
  fs.mkdirSync(path.dirname(STATE_PATH), { recursive: true });
  recordEngineUnavailable(key, "quota window spent", (Date.now() + 90 * 60_000) / 1000);
};

beforeEach(() => fs.rmSync(STATE_PATH, { force: true }));

describe("runnerRefusal on opencode", () => {
  it("skips the tick when the runner's model's provider is spent", () => {
    spend("opencode/opencode-go-b");
    expect(runnerRefusal(settings, config, runner("opencode-go-b/flash"))).toMatch(/opencode is recorded as exhausted/);
  });

  it("reads the engine's default model's provider when the runner names none", () => {
    spend("opencode/opencode-go-b");
    expect(runnerRefusal(settings, config, runner(""))).toMatch(/recorded as exhausted/);
    expect(runnerRefusal(settings, config, undefined)).toMatch(/recorded as exhausted/);
  });

  it("reads the model the settings name over the runner's", () => {
    spend("opencode/opencode-go-c");
    expect(runnerRefusal({ ...settings, model: "opencode-go-c/flash" }, config, runner("opencode-go-b/flash"))).toMatch(/recorded as exhausted/);
    expect(runnerRefusal(settings, config, runner("opencode-go-b/flash"))).toBeNull();
  });

  it("keeps the engine-wide key, and runs when only another provider is spent", () => {
    spend("opencode/opencode-go");
    expect(runnerRefusal(settings, config, runner("opencode-go-b/flash"))).toBeNull();
    spend("opencode");
    expect(runnerRefusal(settings, config, runner("opencode-go-b/flash"))).toMatch(/recorded as exhausted/);
  });
});
