import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const TEST_HOME = path.join(os.tmpdir(), "hundredfold-engine-health-keys-test");
vi.mock("../paths.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../paths.js")>()),
  HUNDREDFOLD_HOME: path.join(os.tmpdir(), "hundredfold-engine-health-keys-test"),
}));

import { withEngineHealth } from "../engine-health.js";
import { writeStore } from "../engine-health-store.js";
import { bindingHealthRecord, engineReadKeys } from "../engine-health-keys.js";
import type { HundredfoldConfig, ModelRegistry } from "../types.js";

const STATE_PATH = path.join(TEST_HOME, "tmp", "engine-health.json");
const config = (model?: string) => ({ engines: { default: "claude", opencode: { bin: "opencode", ...(model ? { model } : {}) } } }) as unknown as HundredfoldConfig;
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

  it("adds an opencode model's provider and the model's own key first: the given model, else the configured one", () => {
    expect(engineReadKeys("opencode", config("opencode-go-b/flash"))).toEqual(["opencode/opencode-go-b", "opencode/opencode-go-b/flash", "opencode"]);
    expect(engineReadKeys("opencode", config("opencode-go-b/flash"), "opencode-go/pro")).toEqual(["opencode/opencode-go", "opencode/opencode-go/pro", "opencode"]);
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

describe("bindingHealthRecord", () => {
  const base = Date.now();
  const at = (minutes: number) => new Date(base + minutes * 60_000).toISOString();
  const ex = (minutes?: number) => ({ state: "exhausted" as const, ...(minutes === undefined ? {} : { until: at(minutes) }) });
  const deg = (minutes: number) => ({ state: "degraded" as const, until: at(minutes) });

  it("prefers exhausted over degraded in either order", () => {
    expect(bindingHealthRecord([deg(15), ex(120)])).toEqual(ex(120));
    expect(bindingHealthRecord([ex(120), deg(15)])).toEqual(ex(120));
  });

  it("takes the latest until among records of one state", () => {
    expect(bindingHealthRecord([ex(30), ex(120)])).toEqual(ex(120));
    expect(bindingHealthRecord([ex(120), ex(30)])).toEqual(ex(120));
    expect(bindingHealthRecord([deg(5), deg(15)])).toEqual(deg(15));
  });

  it("takes an open-ended exhausted record (no until) over a timed one, in either order", () => {
    expect(bindingHealthRecord([ex(), ex(30)])).toEqual(ex());
    expect(bindingHealthRecord([ex(30), ex()])).toEqual(ex());
    expect(bindingHealthRecord([deg(30), ex()])).toEqual(ex());
  });

  it("is the first record when none is out, and nothing for no records", () => {
    const ok = { state: "ok" as const, until: at(-5) };
    expect(bindingHealthRecord([ok, { state: "ok" as const }])).toBe(ok);
    expect(bindingHealthRecord([])).toBeUndefined();
  });
});

describe("withEngineHealth, several records under opencode's keys", () => {
  const later = new Date(Date.now() + 7_200_000).toISOString();
  const soon = new Date(Date.now() + 900_000).toISOString();

  it("reads the engine-wide exhaustion through a provider record that is ok or lapsed", () => {
    writeStore({ "opencode/opencode-go-b": { state: "ok" }, opencode: spent });
    expect(withEngineHealth(registry, config("opencode-go-b/flash")).opencode.health).toMatchObject({ state: "exhausted", until });
    writeStore({ "opencode/opencode-go-b": { state: "exhausted", until: new Date(Date.now() - 60_000).toISOString() }, opencode: spent });
    expect(withEngineHealth(registry, config("opencode-go-b/flash")).opencode.health).toMatchObject({ state: "exhausted", until });
  });

  it("does not let a provider's degraded record mask the engine being exhausted", () => {
    writeStore({ "opencode/opencode-go-b": { state: "degraded", until: soon }, opencode: { state: "exhausted", until: later } });
    expect(withEngineHealth(registry, config("opencode-go-b/flash")).opencode.health).toMatchObject({ state: "exhausted", until: later });
  });

  it("reads an open-ended engine hold over a provider's timed one", () => {
    const openEnded = { state: "exhausted" as const, recheckAt: later, reason: "held until re-probed" };
    writeStore({ "opencode/opencode-go-b": { state: "exhausted", until: soon }, opencode: openEnded });
    const read = withEngineHealth(registry, config("opencode-go-b/flash")).opencode.health;
    expect(read).toMatchObject({ state: "exhausted", reason: "held until re-probed" });
    expect(read.until).toBeUndefined();
  });

  it("names the later reopening when both keys are exhausted", () => {
    writeStore({ "opencode/opencode-go-b": { state: "exhausted", until: soon }, opencode: { state: "exhausted", until: later } });
    expect(withEngineHealth(registry, config("opencode-go-b/flash")).opencode.health).toMatchObject({ state: "exhausted", until: later });
    writeStore({ "opencode/opencode-go-b": { state: "exhausted", until: later }, opencode: { state: "exhausted", until: soon } });
    expect(withEngineHealth(registry, config("opencode-go-b/flash")).opencode.health).toMatchObject({ state: "exhausted", until: later });
  });
});
