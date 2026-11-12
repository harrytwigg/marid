import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const TEST_HOME = path.join(os.tmpdir(), "jinn-engine-health-keys-test");
vi.mock("../paths.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../paths.js")>()),
  JINN_HOME: path.join(os.tmpdir(), "jinn-engine-health-keys-test"),
}));

import { withEngineHealth } from "../engine-health.js";
import { writeStore } from "../engine-health-store.js";
import { engineReadKeys } from "../engine-health-keys.js";
import type { JinnConfig, ModelRegistry } from "../types.js";

const STATE_PATH = path.join(TEST_HOME, "tmp", "engine-health.json");
const config = (model?: string) => ({ engines: { default: "claude", opencode: { bin: "opencode", ...(model ? { model } : {}) } } }) as unknown as JinnConfig;
const registry = { claude: { models: [], available: true }, opencode: { models: [], available: true } } as unknown as ModelRegistry;
const until = new Date(Date.now() + 3_600_000).toISOString();
const spent = { state: "exhausted" as const, until, reason: "quota window spent" };

beforeEach(() => fs.mkdirSync(path.dirname(STATE_PATH), { recursive: true }));
afterEach(() => fs.rmSync(TEST_HOME, { recursive: true, force: true }));

describe("engineReadKeys", () => {
  it("is the engine's key alone for every engine but opencode", () => {
    expect(engineReadKeys("claude", config("a/b"))).toEqual(["claude"]);
    expect(engineReadKeys("codex", undefined)).toEqual(["codex"]);
  });

  it("adds an opencode model's provider first: the given model, else the configured one", () => {
    expect(engineReadKeys("opencode", config("opencode-go-b/flash"))).toEqual(["opencode/opencode-go-b", "opencode"]);
    expect(engineReadKeys("opencode", config("opencode-go-b/flash"), "opencode-go/pro")).toEqual(["opencode/opencode-go", "opencode"]);
  });

  it("is the engine's key alone when no model names a provider", () => {
    expect(engineReadKeys("opencode", config("plain"))).toEqual(["opencode"]);
    expect(engineReadKeys("opencode", config())).toEqual(["opencode"]);
    expect(engineReadKeys("opencode", undefined)).toEqual(["opencode"]);
  });
});

describe("withEngineHealth", () => {
  it("reads opencode out when its configured model's provider is, which GET /api/engines carries", () => {
    writeStore({ "opencode/opencode-go-b": spent });
    const read = withEngineHealth(registry, config("opencode-go-b/flash"));
    expect(read.opencode.health).toMatchObject({ state: "exhausted", until });
    expect(read.claude.health).toEqual({ state: "ok" });
  });

  it("reads another provider's record as ok, the engine-wide one as out, and is unchanged without a config", () => {
    writeStore({ "opencode/opencode-go": spent });
    expect(withEngineHealth(registry, config("opencode-go-b/flash")).opencode.health).toEqual({ state: "ok" });
    expect(withEngineHealth(registry).opencode.health).toEqual({ state: "ok" });
    writeStore({ opencode: spent });
    expect(withEngineHealth(registry, config("opencode-go-b/flash")).opencode.health).toMatchObject({ state: "exhausted" });
    expect(withEngineHealth(registry).opencode.health).toMatchObject({ state: "exhausted" });
  });
});
