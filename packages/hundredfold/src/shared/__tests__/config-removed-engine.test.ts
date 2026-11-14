import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import yaml from "js-yaml";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The Freebuff engine was removed in 0.34.0. An instance upgraded from an
 * earlier release still has `engines.freebuff` in config.yaml (harmless, ignored)
 * and may have written it into a fallback chain (not harmless: a link that can
 * never run). The two must not behave the same way at load.
 */

let tmpHome: string;
const prevHome = process.env.HUNDREDFOLD_HOME;
const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

beforeEach(() => {
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "hundredfold-removed-engine-"));
  process.env.HUNDREDFOLD_HOME = tmpHome;
  warn.mockClear();
  vi.resetModules();
});

afterEach(() => {
  if (prevHome === undefined) delete process.env.HUNDREDFOLD_HOME;
  else process.env.HUNDREDFOLD_HOME = prevHome;
  vi.resetModules();
  fs.rmSync(tmpHome, { recursive: true, force: true });
});

const writeConfig = (engines: Record<string, unknown>) =>
  fs.writeFileSync(
    path.join(tmpHome, "config.yaml"),
    yaml.dump({ gateway: { port: 7778, host: "127.0.0.1" }, engines: { default: "claude", claude: { bin: "claude", model: "opus" }, ...engines } }),
  );

describe("a stale engines.freebuff block", () => {
  it("boots, warns once, and registers no freebuff engine", async () => {
    writeConfig({ freebuff: { bin: "freebuff", model: "MiMo v2.6 Flash Slow", maxConcurrent: 1 } });
    const { loadConfig } = await import("../config.js");
    const { getModelRegistry } = await import("../models.js");

    const loaded = loadConfig();
    loadConfig();

    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0]?.[0])).toContain("Ignoring engines.freebuff");
    expect(String(warn.mock.calls[0]?.[0])).toContain("removed in 0.34.0");
    expect(Object.keys(getModelRegistry(loaded))).not.toContain("freebuff");
  });
});

describe("a fallback link naming freebuff", () => {
  it("is refused at load, with the engine list and the removal", async () => {
    writeConfig({ freebuff: {}, claude: { bin: "claude", model: "opus", fallback: ["freebuff"] } });
    const { loadConfig } = await import("../config.js");

    expect(() => loadConfig()).toThrow(/Invalid config/);
    expect(() => loadConfig()).toThrow(/freebuff/);
    expect(() => loadConfig()).toThrow(/is not a known engine/);
  });
});
