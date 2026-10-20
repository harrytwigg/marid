import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import yaml from "js-yaml";
import type { JinnConfig } from "../../shared/types.js";

/** An employee YAML's `fallback` at roster load: kept as links, inherited when absent, ignored (not fatal) when invalid. */

let orgDir: string;

vi.mock("../../shared/paths.js", () => ({ resolveJinnHome: () => path.dirname(orgDir) }));

const warn = vi.fn();
vi.mock("../../shared/logger.js", () => ({ logger: { warn: (...args: unknown[]) => warn(...args), debug: vi.fn(), info: vi.fn(), error: vi.fn() } }));

import { scanOrg } from "../org.js";

const config = {
  engines: { default: "claude", claude: { bin: "claude", model: "opus", accounts: { A: { configDir: "/srv/operator/.claude-a" } } }, codex: { bin: "codex", model: "gpt" } },
} as unknown as JinnConfig;

function employee(name: string, fallback?: unknown): void {
  const data = { name, displayName: name, department: "eng", rank: "employee", engine: "claude", model: "opus", persona: "p", ...(fallback === undefined ? {} : { fallback }) };
  fs.mkdirSync(path.join(orgDir, "eng"), { recursive: true });
  fs.writeFileSync(path.join(orgDir, "eng", `${name}.yaml`), yaml.dump(data));
}

beforeEach(() => {
  orgDir = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "org-fallback-test-")), "org");
  fs.mkdirSync(orgDir, { recursive: true });
  warn.mockClear();
});
afterEach(() => fs.rmSync(path.dirname(orgDir), { recursive: true, force: true }));

describe("employee fallback at load", () => {
  it("reads links, an explicit empty list, and nothing for an absent or empty key", () => {
    employee("linked", [{ engine: "claude", profile: "A", model: "opus" }, { engine: "codex" }]);
    employee("none", []);
    employee("plain");
    fs.writeFileSync(path.join(orgDir, "eng", "blank.yaml"), "name: blank\ndisplayName: blank\ndepartment: eng\npersona: p\nfallback:\n");
    const roster = scanOrg(config);
    expect(roster.get("linked")?.fallback).toEqual([{ engine: "claude", profile: "A", model: "opus" }, { engine: "codex" }]);
    expect(roster.get("none")?.fallback).toEqual([]);
    expect(roster.get("plain")?.fallback).toBeUndefined();
    expect(roster.get("linked")?.fallbackProblems).toBeUndefined();
    expect(roster.get("blank")).toBeDefined();
    expect(roster.get("blank")?.fallback).toBeUndefined();
    expect(warn).not.toHaveBeenCalled();
  });

  it("an invalid chain is logged and left out; the employee still loads and inherits", () => {
    employee("bad", [{ engine: "gemini" }]);
    employee("ghost", [{ engine: "claude", profile: "nobody" }]);
    employee("strings", ["codex"]);
    const roster = scanOrg(config);
    for (const name of ["bad", "ghost", "strings"]) {
      expect(roster.get(name), name).toBeDefined();
      expect(roster.get(name)?.fallback, name).toBeUndefined();
    }
    expect(warn).toHaveBeenCalledTimes(3);
    // The warning names the employee and the problem, and the problem stays on the roster entry.
    expect(String(warn.mock.calls[0]?.[0])).toContain("employee bad");
    expect(String(warn.mock.calls[0]?.[0])).toContain('"gemini" is not a known engine');
    expect(roster.get("bad")?.fallbackProblems?.[0]).toContain('"gemini" is not a known engine');
    expect(roster.get("ghost")?.fallbackProblems?.[0]).toContain('profile "nobody" names no account');
    expect(roster.get("strings")?.fallbackProblems?.[0]).toContain("must be a mapping");
  });

  it("a repeated target is kept like config.yaml's: warned about by employee, listed once, and reported", () => {
    employee("twice", [{ engine: "codex", model: "m" }, { engine: "codex", model: "m" }]);
    const worker = scanOrg(config).get("twice");
    expect(worker?.fallback).toEqual([{ engine: "codex", model: "m" }, { engine: "codex", model: "m" }]);
    expect(worker?.fallbackProblems).toEqual(["fallback[1] duplicates fallback[0] (codex · m): a chain tries each target once, so list it once"]);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0]?.[0])).toContain("Employee twice");
  });

  it("reports every problem at once: a string entry does not hide an undeclared profile", () => {
    employee("both", ["codex", { engine: "claude", profile: "nobody" }]);
    const problems = scanOrg(config).get("both")?.fallbackProblems?.join("\n") ?? "";
    expect(problems).toContain("fallback[0] must be a mapping");
    expect(problems).toContain('profile "nobody" names no account');
  });
});
