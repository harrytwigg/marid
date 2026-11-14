import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import yaml from "js-yaml";

/**
 * What `loadConfig` does with `engines.<name>.fallback` and `fallbackModelMap` as
 * they sit on disk. Split from engine-fallback.test.ts, which covers the same
 * validators as pure functions: only this half needs a real config.yaml under a
 * temp HUNDREDFOLD_HOME, and only this half proves the loader refuses a file that would
 * otherwise brick the next boot.
 */
describe("engines.<name>.fallback round-trip", () => {
  // CONFIG_PATH resolves at module load from HUNDREDFOLD_HOME, so point it at a temp dir
  // and re-import (same pattern as the saveConfigAtomic tests).
  let tmpHome: string;
  const prevHome = process.env.HUNDREDFOLD_HOME;

  beforeEach(() => {
    tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "hundredfold-engine-fallback-"));
    process.env.HUNDREDFOLD_HOME = tmpHome;
    vi.resetModules();
  });

  afterEach(() => {
    if (prevHome === undefined) delete process.env.HUNDREDFOLD_HOME;
    else process.env.HUNDREDFOLD_HOME = prevHome;
    vi.resetModules();
    try { fs.rmSync(tmpHome, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  it("loads a chain verbatim and survives a save/reload", async () => {
    const { loadConfig, saveConfigAtomic } = await import("../config.js");
    fs.writeFileSync(path.join(tmpHome, "config.yaml"), yaml.dump({
      gateway: { port: 7778, host: "127.0.0.1" },
      engines: {
        default: "claude",
        claude: { bin: "claude", model: "opus", fallback: ["codex", "grok"] },
        codex: { bin: "codex", model: "gpt-5.5" },
      },
    }));

    const loaded = loadConfig();
    expect(loaded.engines.claude.fallback).toEqual(["codex", "grok"]);

    saveConfigAtomic(loaded);
    expect(loadConfig().engines.claude.fallback).toEqual(["codex", "grok"]);
  });

  it("refuses to load a config whose model map is malformed, the same way a bad chain is refused", async () => {
    const { loadConfig } = await import("../config.js");
    fs.writeFileSync(path.join(tmpHome, "config.yaml"), yaml.dump({
      gateway: { port: 7778, host: "127.0.0.1" },
      engines: {
        default: "claude",
        claude: { bin: "claude", model: "opus" },
        codex: { bin: "codex", model: "gpt-5.5", fallbackModelMap: ["haiku"] },
      },
    }));

    expect(() => loadConfig()).toThrow(/engines\.codex\.fallbackModelMap/);
  });

  it("refuses to load a config whose map entry carries a control character", async () => {
    const { loadConfig } = await import("../config.js");
    fs.writeFileSync(path.join(tmpHome, "config.yaml"), yaml.dump({
      gateway: { port: 7778, host: "127.0.0.1" },
      engines: {
        default: "claude",
        claude: { bin: "claude", model: "opus" },
        codex: {
          bin: "codex", model: "gpt-5.5",
          fallbackModelMap: { "gpt-5.6-sol": "gemini-3.7-flash-high\tGemini 3.7 Flash (High)" },
        },
      },
    }));

    expect(() => loadConfig())
      .toThrow(/engines\.codex\.fallbackModelMap\["gpt-5\.6-sol"\] must be a model id with no control characters/);
  });

  it("loads a valid map verbatim, and an absent one as absent", async () => {
    const { loadConfig } = await import("../config.js");
    fs.writeFileSync(path.join(tmpHome, "config.yaml"), yaml.dump({
      gateway: { port: 7778, host: "127.0.0.1" },
      engines: {
        default: "claude",
        claude: { bin: "claude", model: "opus" },
        codex: { bin: "codex", model: "gpt-5.5", fallbackModelMap: { "gpt-5.6-luna": "haiku" } },
      },
    }));

    const loaded = loadConfig();
    expect(loaded.engines.codex.fallbackModelMap).toEqual({ "gpt-5.6-luna": "haiku" });
    expect(loaded.engines.claude.fallbackModelMap).toBeUndefined();
  });
});
