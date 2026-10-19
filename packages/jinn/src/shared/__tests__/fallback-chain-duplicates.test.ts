import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import yaml from "js-yaml";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { unchangedLegacyDuplicates, warnLegacyDuplicates } from "../fallback-chain-load.js";
import { validateConfigShape } from "../config.js";

/**
 * A duplicate chain entry is refused on write, but an upgrade must never stop a gateway
 * starting: what the legacy validator accepted (a string listed twice) loads with a warning.
 */

const warn = vi.hoisted(() => vi.fn());
vi.mock("../logger.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../logger.js")>()),
  logger: { warn: (...args: unknown[]) => warn(...args), info: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const config = (fallback: unknown[], rest: Record<string, unknown> = {}) => ({
  engines: { default: "claude", claude: { bin: "claude", model: "opus", fallback }, codex: { bin: "codex", model: "gpt" }, ...rest },
});
const DUPLICATE = "engines.claude.fallback[1] duplicates engines.claude.fallback[0] (codex): a chain tries each target once, so list it once";

beforeEach(() => warn.mockClear());

describe("on write, a duplicate is refused", () => {
  it("whichever way it is spelled", () => {
    expect(validateConfigShape(config(["codex", "codex"]))).toEqual([DUPLICATE]);
    expect(validateConfigShape(config([{ engine: "codex" }, { engine: "codex" }]))).toEqual([DUPLICATE]);
    expect(validateConfigShape(config(["codex", { engine: "codex" }]))).toEqual([DUPLICATE]);
  });
});

describe("at load, only the legacy string duplicate is tolerated", () => {
  const load = (fallback: unknown[], rest?: Record<string, unknown>) => validateConfigShape(config(fallback, rest), { tolerateDuplicates: warnLegacyDuplicates() });

  it("accepts a string listed twice and warns, once, naming the path", () => {
    expect(load(["codex", "grok", "codex"])).toEqual([]);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0]?.[0])).toContain("engines.claude.fallback[2] duplicates engines.claude.fallback[0] (codex)");
    expect(load(["codex", "grok", "codex"])).toEqual([]);
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it("tolerates it in an account's chain as well", () => {
    const accounts = { A: { configDir: "/srv/operator/.claude-a", fallback: ["codex", "codex"] } };
    expect(validateConfigShape(config([], { claude: { bin: "claude", model: "opus", accounts } }), { tolerateDuplicates: warnLegacyDuplicates() })).toEqual([]);
    expect(String(warn.mock.calls.at(-1)?.[0])).toContain("engines.claude.accounts.A.fallback[1] duplicates");
  });

  it("still refuses what only the object form can say, and every other problem", () => {
    expect(load([{ engine: "codex" }, { engine: "codex" }])).toEqual([DUPLICATE]);
    expect(load(["codex", { engine: "codex" }])).toEqual([DUPLICATE]);
    expect(warn).not.toHaveBeenCalled();
    expect(load(["gemini", "codex", "codex"]).join("\n")).toContain('"gemini" is not a known engine');
    expect(load(["claude", "codex", "codex"]).join("\n")).toContain("is the target this chain falls back from");
  });
});

describe("on write, a duplicate the file already has and the request leaves alone does not block the save", () => {
  const existing = config(["codex", "codex"]);

  it("tolerates it unchanged, and refuses it once the request writes that chain", () => {
    expect(validateConfigShape(existing, { tolerateDuplicates: unchangedLegacyDuplicates(existing) })).toEqual([]);
    const edited = config(["codex", "codex", "grok"]);
    expect(validateConfigShape(edited, { tolerateDuplicates: unchangedLegacyDuplicates(existing) })).toEqual([DUPLICATE]);
    expect(validateConfigShape(config([{ engine: "codex" }, { engine: "codex" }]), { tolerateDuplicates: unchangedLegacyDuplicates(existing) })).toEqual([DUPLICATE]);
  });
});

describe("loadConfig", () => {
  let tmpHome: string;
  const prevHome = process.env.JINN_HOME;

  beforeEach(() => {
    tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "jinn-fallback-duplicates-"));
    process.env.JINN_HOME = tmpHome;
    vi.resetModules();
  });
  afterEach(() => {
    if (prevHome === undefined) delete process.env.JINN_HOME;
    else process.env.JINN_HOME = prevHome;
    vi.resetModules();
    fs.rmSync(tmpHome, { recursive: true, force: true });
  });

  const write = (fallback: unknown[]) => fs.writeFileSync(path.join(tmpHome, "config.yaml"), yaml.dump({ gateway: { port: 7778, host: "127.0.0.1" }, ...config(fallback) }));

  it("loads a legacy [codex, codex] config with a warning", async () => {
    write(["codex", "codex"]);
    const { loadConfig } = await import("../config.js");
    expect(loadConfig().engines.claude.fallback).toEqual(["codex", "codex"]);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0]?.[0])).toContain("engines.claude.fallback[1] duplicates");
  });

  it("refuses a duplicate that only the object form can express", async () => {
    write([{ engine: "codex" }, { engine: "codex" }]);
    const { loadConfig } = await import("../config.js");
    expect(() => loadConfig()).toThrow(/duplicates engines\.claude\.fallback\[0\]/);
  });
});
