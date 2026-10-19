import { describe, expect, it } from "vitest";
import { employeeFallbackProblems, employeeFallbackUpdate, storedFallbackProblems } from "../employee-fallback.js";
import { validateConfigShape } from "../config.js";
import type { JinnConfig } from "../types.js";

/**
 * Chains in config: the legacy strings, the object form and the two mixed, on an engine
 * default, a declared account and an employee; what the loader refuses, and in which words.
 */

const DIR_A = "/srv/operator/.claude-a";
const DIR_B = "/srv/operator/.claude-b";
const ACCOUNTS = { A: { configDir: DIR_A }, B: { configDir: DIR_B } };

/** The shape validator on `engines.claude` and whatever sits beside it. */
function problems(claude: Record<string, unknown>, rest: Record<string, unknown> = {}): string[] {
  return validateConfigShape({ engines: { default: "claude", claude: { bin: "claude", model: "opus", ...claude }, ...rest } });
}

describe("what loads", () => {
  it("a chain of claude/A/opus, claude/B/sonnet, opencode/X, opencode/Y loads with no problems", () => {
    expect(problems({
      accounts: ACCOUNTS,
      fallback: [
        { engine: "claude", profile: "A", model: "opus" },
        { engine: "claude", profile: "B", model: "sonnet" },
        { engine: "opencode", model: "provider/x" },
        { engine: "opencode", model: "provider/y" },
      ],
    })).toEqual([]);
  });

  it("legacy strings, objects and a mix, on engines and accounts", () => {
    expect(problems({ accounts: ACCOUNTS, fallback: ["codex", "claude:A"] })).toEqual([]);
    expect(problems({ accounts: ACCOUNTS, fallback: ["codex", { engine: "opencode", model: "provider/x" }, "claude:B"] })).toEqual([]);
    expect(problems({ accounts: { A: { configDir: DIR_A, fallback: ["claude", { engine: "claude", profile: "B", model: "sonnet" }] }, B: { configDir: DIR_B } } })).toEqual([]);
    expect(problems({}, { codex: { bin: "codex", model: "gpt", fallback: [{ engine: "claude", profile: "A" }] }, claude: { accounts: ACCOUNTS } })).toEqual([]);
  });

  it("the same engine more than once on other profiles or models, and a cycle", () => {
    expect(problems({ accounts: ACCOUNTS, fallback: [{ engine: "claude", profile: "A" }, { engine: "claude", profile: "B" }, { engine: "claude", model: "sonnet" }] })).toEqual([]);
    expect(problems({ fallback: ["codex"] }, { codex: { bin: "codex", model: "gpt", fallback: ["claude"] } })).toEqual([]);
  });
});

describe("what is refused", () => {
  it("a duplicate target, with the wire module's sentence, whichever forms spell it", () => {
    expect(problems({ fallback: [{ engine: "codex", model: "m" }, { engine: "codex", model: "m" }] }))
      .toEqual(["engines.claude.fallback[1] duplicates engines.claude.fallback[0] (codex · m): a chain tries each target once, so list it once"]);
    expect(problems({ fallback: ["codex", { engine: "codex" }] }))
      .toEqual(["engines.claude.fallback[1] duplicates engines.claude.fallback[0] (codex): a chain tries each target once, so list it once"]);
    expect(problems({ accounts: { A: { configDir: DIR_A, fallback: ["codex", "codex"] } } }))
      .toEqual(["engines.claude.accounts.A.fallback[1] duplicates engines.claude.accounts.A.fallback[0] (codex): a chain tries each target once, so list it once"]);
  });

  it("an engine, or an account, naming its own target", () => {
    expect(problems({}, { codex: { bin: "codex", model: "gpt", fallback: ["codex"] } }).join("\n")).toContain("engines.codex.fallback[0] (codex) is the target this chain falls back from");
    expect(problems({ accounts: { A: { configDir: DIR_A, fallback: [{ engine: "claude", profile: "A" }, "claude:A"] } } }).join("\n"))
      .toContain("engines.claude.accounts.A.fallback[0] (claude · A) is the target this chain falls back from");
  });

  it("unknown engines and profiles, a profile on a non-Claude link, and a model that is not an id", () => {
    const refused = problems({ accounts: ACCOUNTS, fallback: [{ engine: "gemini" }, { engine: "claude", profile: "ghost" }, { engine: "codex", profile: "A" }, { engine: "codex", model: "" }, "claude:nope"] }).join("\n");
    expect(refused).toContain('fallback[0]: "gemini" is not a known engine');
    expect(refused).toContain('fallback[1]: profile "ghost" names no account under engines.claude.accounts');
    expect(refused).toContain("fallback[2]: only a claude target takes a profile");
    expect(refused).toContain("fallback[3].model must be a model id");
    expect(refused).toContain('fallback[4]: profile "nope" names no account');
  });
});

describe("an employee's chain", () => {
  const config = { engines: { default: "claude", claude: { bin: "claude", model: "opus", accounts: ACCOUNTS }, codex: { bin: "codex", model: "gpt" } } } as unknown as JinnConfig;
  const worker = { engine: "claude", model: "opus" };

  it("accepts links across engines, profiles and models, and [] for none", () => {
    expect(employeeFallbackProblems(config, worker, [{ engine: "claude", profile: "A", model: "opus" }, { engine: "codex" }])).toEqual([]);
    expect(employeeFallbackProblems(config, worker, [])).toEqual([]);
  });

  it("refuses a duplicate with the wire sentence and the employee's own target as its self", () => {
    expect(employeeFallbackProblems(config, worker, [{ engine: "codex" }, { engine: "codex" }]))
      .toEqual(["fallback[1] duplicates fallback[0] (codex): a chain tries each target once, so list it once"]);
    expect(employeeFallbackProblems(config, worker, [{ engine: "claude", model: "opus" }])[0]).toContain("is the target this chain falls back from");
    // The same link is another target for an employee on another model.
    expect(employeeFallbackProblems(config, { engine: "claude", model: "sonnet" }, [{ engine: "claude", model: "opus" }])).toEqual([]);
  });

  it("a link with no model is the own target too: it runs the employee's own model on its own engine", () => {
    expect(employeeFallbackProblems(config, worker, [{ engine: "claude" }])[0]).toContain("is the target this chain falls back from");
    expect(employeeFallbackProblems(config, worker, [{ engine: "claude", profile: "A" }])).toEqual([]);
  });

  it("a stored chain is rechecked against a new engine or model, and left alone when the target stays", () => {
    const stored = { ...worker, fallback: [{ engine: "codex", model: "gpt" }] };
    expect(storedFallbackProblems(config, stored, { engine: "codex", model: "gpt" })[0]).toContain("is the target this chain falls back from");
    expect(storedFallbackProblems(config, stored, { engine: "claude", model: "sonnet" })).toEqual([]);
    expect(storedFallbackProblems(config, stored, worker)).toEqual([]);
    expect(storedFallbackProblems(config, worker, { engine: "codex", model: "gpt" })).toEqual([]);
  });

  it("an employee on a declared account's directory cannot name that account as a fallback with the same model", () => {
    const onA = { engine: "claude", model: "opus", claudeConfigDir: DIR_A };
    expect(employeeFallbackProblems(config, onA, [{ engine: "claude", profile: "A", model: "opus" }])[0]).toContain("(claude · A · opus) is the target");
  });

  it("writes strings out: only the object form is an employee's", () => {
    expect(employeeFallbackProblems(config, worker, ["codex"])[0]).toContain("fallback[0] must be a mapping");
  });

  it("an update normalises to links, takes null as inherit and reports the refusal", () => {
    expect(employeeFallbackUpdate(config, worker, [{ engine: " codex ", model: " m " }])).toEqual({ ok: true, value: [{ engine: "codex", model: "m" }] });
    expect(employeeFallbackUpdate(config, worker, null)).toEqual({ ok: true, value: null });
    expect(employeeFallbackUpdate(config, worker, "x")).toEqual({ ok: false, error: "fallback must be a list of fallback targets" });
  });
});
