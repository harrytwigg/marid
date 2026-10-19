import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import yaml from "js-yaml";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { findSettings, renderMigration, runMigrateOpencode, settingsSearchPaths, writeEngineChain } from "../opencode-fallback-command.js";
import { migrateOpencodeFallback, modelOfEntry, type OpencodeEmployee } from "../opencode-fallback-migration.js";

const employees: OpencodeEmployee[] = [
  { name: "coder-a", engine: "opencode", model: "opencode-go/m1" },
  { name: "coder-b", engine: "opencode", model: "opencode-go/m1" },
  { name: "claude-coder", engine: "claude", model: "opencode-go/m1" },
  { name: "default-coder", engine: "opencode", model: "" },
];
const org = { employees, defaultModel: "opencode-go/m2" };

describe("migrateOpencodeFallback", () => {
  it("turns a fallbackModels list into the engine default chain", () => {
    const m = migrateOpencodeFallback({ fallbackModels: [{ providerID: "openrouter", modelID: "x/y" }, "backup/z"] }, org);
    expect(m.engineChain).toEqual([{ engine: "opencode", model: "openrouter/x/y" }, { engine: "opencode", model: "backup/z" }]);
    expect(m.employeeSuggestions).toEqual([]);
    expect(m.problems).toEqual([]);
  });

  it("maps \"*\" to the engine default and each model to the employees pinned to it", () => {
    const m = migrateOpencodeFallback({
      fallbackModels: {
        "*": [{ providerID: "or", modelID: "any" }],
        "opencode-go/m1": [{ providerID: "or", modelID: "m1" }],
        "opencode-go/m2": [{ providerID: "or", modelID: "m2" }],
        "opencode-go/none": [{ providerID: "or", modelID: "n" }],
      },
    }, org);
    expect(m.engineChain).toEqual([{ engine: "opencode", model: "or/any" }]);
    expect(m.employeeSuggestions.map((s) => [s.model, s.employees])).toEqual([
      ["opencode-go/m1", ["coder-a", "coder-b"]], // not claude-coder: another engine
      ["opencode-go/m2", ["default-coder"]], // an employee with no model runs on the engine's default
      ["opencode-go/none", []],
    ]);
  });

  it("lists the settings it cannot map, with why, and ignores the ones it needs no mapping for", () => {
    const m = migrateOpencodeFallback({
      enabled: true, fallbackModels: [], cooldownMs: 1, circuitBreaker: {}, fallbackMode: "cycle", restoreModel: true, retryPolicy: {}, metrics: {},
    }, org);
    expect(m.unmapped.map((u) => u.key)).toEqual(["cooldownMs", "circuitBreaker", "fallbackMode", "restoreModel", "retryPolicy", "metrics"]);
    expect(m.unmapped.every((u) => u.reason.length > 10)).toBe(true);
    expect(m.unmapped.at(-1)!.reason).toContain("no setting");
  });

  it("notes entries it cannot read and drops repeated models", () => {
    const m = migrateOpencodeFallback({ fallbackModels: [{ providerID: "a" }, "nomodel", "a/b", "a/b"] }, org);
    expect(m.engineChain).toEqual([{ engine: "opencode", model: "a/b" }]);
    expect(m.notes).toHaveLength(2);
  });

  it("migrates nothing from a file that disables the plugin, or that is not an object", () => {
    const off = migrateOpencodeFallback({ enabled: false, fallbackModels: ["a/b"] }, org);
    expect(off.engineChain).toEqual([]);
    expect(off.notes[0]).toContain("nothing to migrate");
    expect(migrateOpencodeFallback([], org).notes).toEqual(["the settings file is not a JSON object"]);
  });

  it("validates the chains: a chain that lists its own model is a problem", () => {
    const m = migrateOpencodeFallback({ fallbackModels: { "opencode-go/m1": ["opencode-go/m1", "or/m1"] } }, org);
    expect(m.problems).toHaveLength(1);
    expect(m.problems[0]).toContain("falls back from");
  });

  it("reads providerID/modelID objects and provider/model strings only", () => {
    expect(modelOfEntry({ providerID: "a", modelID: "b/c" })).toBe("a/b/c");
    expect(modelOfEntry("a/b")).toBe("a/b");
    expect(modelOfEntry("ab")).toBeUndefined();
    expect(modelOfEntry({ providerID: "", modelID: "x" })).toBeUndefined();
  });
});

describe("the report", () => {
  it("prints the engine chain as YAML that loads back, the suggestions, the unmapped keys and the removal steps", () => {
    const m = migrateOpencodeFallback({
      cooldownMs: 5,
      fallbackModels: { "*": ["or/x", "or/y"], "opencode-go/m1": ["or/m1"] },
    }, org);
    const text = renderMigration(m, "/some/rate-limit-fallback.json");
    expect(text).toContain("# From /some/rate-limit-fallback.json");
    const yamlBlock = text.split("\n").filter((l) => !l.startsWith("#") && l.trim()).join("\n");
    expect(yaml.load(yamlBlock.split("\nfallback:")[0]!)).toEqual({
      engines: { opencode: { fallback: [{ engine: "opencode", model: "or/x" }, { engine: "opencode", model: "or/y" }] } },
    });
    expect(text).toContain("# opencode-go/m1: employees coder-a, coder-b");
    expect(text).toContain("cooldownMs:");
    expect(text).toContain("delete model-fallback.js from the plugin directory");
    expect(text).toContain("jinn doctor");
  });
});

describe("--write", () => {
  let dir: string;
  let configPath: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "oc-migrate-"));
    configPath = path.join(dir, "config.yaml");
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));
  const chain = [{ engine: "opencode", model: "or/x" }];
  const save = (config: unknown) => fs.writeFileSync(configPath, yaml.dump(config));

  it("merges the engine chain into the config and keeps the rest", () => {
    fs.writeFileSync(configPath, yaml.dump({ gateway: { port: 18080 }, engines: { default: "claude", opencode: { model: "opencode-go/m1" } } }));
    expect(writeEngineChain(chain, configPath, save)).toEqual({ written: true });
    expect(yaml.load(fs.readFileSync(configPath, "utf-8"))).toEqual({
      gateway: { port: 18080 },
      engines: { default: "claude", opencode: { model: "opencode-go/m1", fallback: chain } },
    });
  });

  it("creates the opencode block when the config has none", () => {
    fs.writeFileSync(configPath, yaml.dump({ engines: { default: "claude" } }));
    expect(writeEngineChain(chain, configPath, save)).toEqual({ written: true });
    expect((yaml.load(fs.readFileSync(configPath, "utf-8")) as any).engines.opencode.fallback).toEqual(chain);
  });

  it("refuses when engines.opencode.fallback is already set, even to an empty list, and leaves the file alone", () => {
    for (const existing of [[{ engine: "codex" }], []]) {
      fs.writeFileSync(configPath, yaml.dump({ engines: { opencode: { fallback: existing } } }));
      const before = fs.readFileSync(configPath, "utf-8");
      const outcome = writeEngineChain(chain, configPath, save);
      expect(outcome).toMatchObject({ written: false });
      expect((outcome as { reason: string }).reason).toContain("already set");
      expect(fs.readFileSync(configPath, "utf-8")).toBe(before);
    }
  });

  it("refuses an empty chain and a missing config", () => {
    fs.writeFileSync(configPath, "engines: {}\n");
    expect(writeEngineChain([], configPath, save)).toMatchObject({ written: false });
    expect(writeEngineChain(chain, path.join(dir, "absent.yaml"), save)).toMatchObject({ written: false });
  });
});

describe("finding the settings file", () => {
  it("searches the project's, the home's and the config dir's .opencode/, opencode/ and bare paths, and takes the first that parses", () => {
    const paths = settingsSearchPaths("/p", { HOME: "/h", XDG_CONFIG_HOME: "/x" });
    expect(paths[0]).toBe(path.join("/p", ".opencode", "rate-limit-fallback.json"));
    expect(paths).toContain(path.join("/h", ".opencode", "rate-limit-fallback.json"));
    expect(paths).toContain(path.join("/x", "opencode", "rate-limit-fallback.json"));
    expect(paths).toHaveLength(9);
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "oc-find-"));
    try {
      const broken = path.join(dir, "a.json");
      const good = path.join(dir, "b.json");
      fs.writeFileSync(broken, "{ nope");
      fs.writeFileSync(good, '{"fallbackModels": ["a/b"]}');
      expect(findSettings([path.join(dir, "missing.json"), broken, good])).toEqual({ file: good, settings: { fallbackModels: ["a/b"] } });
      expect(findSettings([broken])).toBeUndefined();
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("the command prints the chain for a --file and fails clearly without one", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "oc-cmd-"));
    const lines: string[] = [];
    const saved = process.exitCode;
    try {
      const file = path.join(dir, "rate-limit-fallback.json");
      fs.writeFileSync(file, JSON.stringify({ fallbackModels: [{ providerID: "or", modelID: "x" }] }));
      await runMigrateOpencode({ file }, (l) => lines.push(l));
      expect(lines.join("\n")).toContain("model: or/x");
      expect(process.exitCode).toBe(saved);
      lines.length = 0;
      await runMigrateOpencode({ file: path.join(dir, "none.json") }, (l) => lines.push(l));
      expect(lines[0]).toContain("No readable settings file");
      expect(process.exitCode).toBe(1);
    } finally {
      process.exitCode = saved;
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
