import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import yaml from "js-yaml";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { duplicateProblemsByChain, unchangedDuplicates, warnDuplicates } from "../fallback-chain-load.js";
import { validateConfigShape } from "../config.js";

/**
 * A duplicate chain entry is refused on write, but an upgrade must never stop a gateway
 * starting: at load a duplicate, in either form, is reported and the expansion lists the target once.
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

describe("at load, a duplicate in either form is tolerated and reported", () => {
  const load = (fallback: unknown[], rest?: Record<string, unknown>) => validateConfigShape(config(fallback, rest), { tolerateDuplicates: warnDuplicates() });

  it("a string listed twice loads with one warning, naming the path and the target", () => {
    expect(load(["codex", "grok", "codex"])).toEqual([]);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0]?.[0])).toContain("engines.claude.fallback[2] duplicates engines.claude.fallback[0] (codex)");
    expect(load(["codex", "grok", "codex"])).toEqual([]);
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it("a repeated mapping, and a string repeated as a mapping, load with a warning too", () => {
    expect(load([{ engine: "codex", model: "m" }, { engine: "codex", model: "m" }])).toEqual([]);
    expect(String(warn.mock.calls.at(-1)?.[0])).toContain("duplicates engines.claude.fallback[0] (codex · m)");
    expect(load(["grok", { engine: "grok" }])).toEqual([]);
    expect(warn).toHaveBeenCalledTimes(2);
  });

  it("tolerates it in an account's chain as well", () => {
    const accounts = { A: { configDir: "/srv/operator/.claude-a", fallback: ["codex", "codex"] } };
    expect(validateConfigShape(config([], { claude: { bin: "claude", model: "opus", accounts } }), { tolerateDuplicates: warnDuplicates() })).toEqual([]);
    expect(String(warn.mock.calls.at(-1)?.[0])).toContain("engines.claude.accounts.A.fallback[1] duplicates");
  });

  it("every other problem stays a load error, naming the path", () => {
    expect(load(["gemini", "codex", "codex"]).join("\n")).toContain('engines.claude.fallback[0]: "gemini" is not a known engine');
    expect(load(["claude", "codex", "codex"]).join("\n")).toContain("engines.claude.fallback[0] (claude) is the target this chain falls back from");
    expect(load([{ engine: "claude", profile: "ghost" }]).join("\n")).toContain('profile "ghost" names no account');
    expect(load([{ engine: "codex", model: "" }]).join("\n")).toContain("fallback[0].model must be a model id");
  });

  it("lists them by chain for the API and doctor, in the wire module's words", () => {
    const accounts = { A: { configDir: "/srv/operator/.claude-a", fallback: ["codex", "codex"] } };
    const found = duplicateProblemsByChain({ claude: { fallback: [{ engine: "codex" }, { engine: "codex" }], accounts }, codex: { fallback: ["grok"] } });
    expect(found).toEqual({
      "engines.claude.fallback": [DUPLICATE],
      "engines.claude.accounts.A.fallback": ["engines.claude.accounts.A.fallback[1] duplicates engines.claude.accounts.A.fallback[0] (codex): a chain tries each target once, so list it once"],
    });
  });
});

describe("on write, a duplicate the file already has and the request leaves alone does not block the save", () => {
  const existing = config(["codex", "codex"]);

  it("tolerates it unchanged, and refuses it once the request writes that chain", () => {
    expect(validateConfigShape(existing, { tolerateDuplicates: unchangedDuplicates(existing) })).toEqual([]);
    const edited = config(["codex", "codex", "grok"]);
    expect(validateConfigShape(edited, { tolerateDuplicates: unchangedDuplicates(existing) })).toEqual([DUPLICATE]);
    expect(validateConfigShape(config([{ engine: "codex" }, { engine: "codex" }]), { tolerateDuplicates: unchangedDuplicates(existing) })).toEqual([DUPLICATE]);
  });
});

describe("on write, an unchanged duplicate is tolerated only at its own path", () => {
  it("the same repeated list added under another engine is a newly added duplicate", () => {
    const repeated = ["grok", { engine: "grok" }];
    const existing = { engines: { default: "claude", claude: { bin: "claude", model: "opus" }, codex: { bin: "codex", model: "gpt", fallback: repeated } } };
    const moved = { engines: { ...existing.engines, opencode: { bin: "opencode", model: "x", fallback: repeated } } };
    expect(validateConfigShape(existing, { tolerateDuplicates: unchangedDuplicates(existing) })).toEqual([]);
    expect(validateConfigShape(moved, { tolerateDuplicates: unchangedDuplicates(existing) }).join("\n")).toContain("engines.opencode.fallback[1] duplicates engines.opencode.fallback[0] (grok)");
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

  it("loads a repeated mapping with a warning too, and still refuses a self target", async () => {
    write([{ engine: "codex" }, { engine: "codex" }]);
    const { loadConfig } = await import("../config.js");
    expect(loadConfig().engines.claude.fallback).toEqual([{ engine: "codex" }, { engine: "codex" }]);
    expect(String(warn.mock.calls.at(-1)?.[0])).toContain("engines.claude.fallback[1] duplicates engines.claude.fallback[0] (codex)");
    write([{ engine: "claude" }]);
    expect(() => loadConfig()).toThrow(/engines\.claude\.fallback\[0\] \(claude\) is the target/);
  });
});
