import { describe, expect, it } from "vitest";
import { configEnvReferences } from "../config-env-references.js";
import { declaredOpencodeAccounts, opencodeAccountByProvider, stagedOpencodeAccounts, validateOpencodeAccounts } from "../opencode-accounts-config.js";

const engines = (accounts: unknown) => ({ opencode: { accounts } });

describe("validateOpencodeAccounts", () => {
  it("accepts an alias account and a built-in one", () => {
    expect(validateOpencodeAccounts(engines({
      "go-b": { provider: "opencode-go-b", base: "opencode-go", keyEnv: "GO_B_KEY", label: "Go B", models: ["model-a"], usageLimits: { monthlyUsd: { "*": 100, "model-a": 15 } } },
      "go-a": { provider: "opencode-go" },
    }))).toEqual([]);
  });

  it("accepts no accounts block", () => {
    expect(validateOpencodeAccounts({ opencode: {} })).toEqual([]);
    expect(validateOpencodeAccounts({})).toEqual([]);
  });

  it.each([
    ["a non-mapping block", [], /must be a mapping of account names/],
    ["a bad name", { "-x": { provider: "p" } }, /account name must match/],
    ["a bad provider id", { a: { provider: "Bad Id" } }, /provider must be an opencode provider id/],
    ["the opencode provider", { a: { provider: "opencode" } }, /cannot be an account's id/],
    ["a base equal to provider", { a: { provider: "p", base: "p", keyEnv: "K" } }, /base must differ/],
    ["a base without keyEnv", { a: { provider: "p", base: "q" } }, /keyEnv must name/],
    ["a lowercase keyEnv", { a: { provider: "p", base: "q", keyEnv: "key" } }, /keyEnv must name/],
    ["a keyEnv the gateway sets itself", { a: { provider: "p", base: "q", keyEnv: "OPENCODE_SERVER_PASSWORD" } }, /cannot hold an account's key/],
    ["a keyEnv in the program's own namespace", { a: { provider: "p", base: "q", keyEnv: "JINN_EMPLOYEE" } }, /cannot hold an account's key/],
    ["a keyEnv that is an opencode switch", { a: { provider: "p", base: "q", keyEnv: "OPENCODE_DISABLE_FFF" } }, /cannot hold an account's key/],
    ...["PATH", "HOME", "USER", "SHELL", "LANG", "TERM", "TMPDIR", "PWD", "NODE_OPTIONS", "NODE_PATH", "LD_PRELOAD", "LD_LIBRARY_PATH", "DYLD_INSERT_LIBRARIES", "XDG_CONFIG_HOME", "SSH_AUTH_SOCK", "SSH_ASKPASS"]
      .map((keyEnv): [string, unknown, RegExp] => [`a keyEnv naming the process variable ${keyEnv}`, { a: { provider: "p", base: "q", keyEnv } }, /cannot hold an account's key/]),
    ["a keyEnv that is any OPENCODE_ variable", { a: { provider: "p", base: "q", keyEnv: "OPENCODE_GO_B_API_KEY" } }, /cannot hold an account's key.*removes an account's key variable from every other process/],
    ...["ANTHROPIC_API_KEY", "OPENAI_API_KEY", "OPENROUTER_API_KEY", "GEMINI_API_KEY", "GOOGLE_API_KEY", "GOOGLE_GENERATIVE_AI_API_KEY", "DEEPSEEK_API_KEY", "XAI_API_KEY", "MISTRAL_API_KEY", "GROQ_API_KEY"]
      .map((keyEnv): [string, unknown, RegExp] => [`a keyEnv naming the provider key ${keyEnv}`, { a: { provider: "p", base: "q", keyEnv } }, /standard key variable.*removes an account's key variable from every other process/]),
    ["keyEnv without base", { a: { provider: "p", keyEnv: "K" } }, /keyEnv needs base/],
    ["models without base", { a: { provider: "p", models: ["m"] } }, /models needs base/],
    ["models with a provider prefix", { a: { provider: "p", base: "q", keyEnv: "K", models: ["q/m"] } }, /models must be a non-empty list/],
    ["an empty models list", { a: { provider: "p", base: "q", keyEnv: "K", models: [] } }, /models must be a non-empty list/],
    ["a non-positive limit", { a: { provider: "p", usageLimits: { monthlyUsd: { "*": 0 } } } }, /must be a positive number/],
    ["a prefixed limit key", { a: { provider: "p", usageLimits: { monthlyUsd: { "p/m": 5 } } } }, /without its provider/],
    ["an empty label", { a: { provider: "p", label: " " } }, /label must be a non-empty string/],
  ])("refuses %s", (_name, accounts, message) => {
    const problems = validateOpencodeAccounts(engines(accounts));
    expect(problems.join("\n")).toMatch(message);
  });

  it.each(["apiKey", "key", "token"])("refuses an inline %s and never echoes it", (field) => {
    const problems = validateOpencodeAccounts(engines({ a: { provider: "p", base: "q", keyEnv: "K", [field]: "sk-secret-value" } }));
    expect(problems.join("\n")).toMatch(/a key is never written in config/);
    expect(problems.join("\n")).not.toContain("sk-secret-value");
  });

  it("refuses two accounts on one provider id", () => {
    const problems = validateOpencodeAccounts(engines({ a: { provider: "p" }, b: { provider: "p" } }));
    expect(problems).toEqual([`engines.opencode.accounts.b.provider "p" is already account "a"'s`]);
  });
});

describe("declaredOpencodeAccounts", () => {
  const config = { engines: { opencode: { accounts: {
    "go-b": { provider: "opencode-go-b", base: "opencode-go", keyEnv: "GO_B_KEY", models: ["m1"], usageLimits: { monthlyUsd: { "*": 10 } } },
    "go-a": { provider: "opencode-go", label: "Go A" },
    broken: { provider: "x", base: "y" },
  } } } };

  it("normalises valid accounts by name and drops invalid ones", () => {
    expect(declaredOpencodeAccounts(config)).toEqual([
      { name: "go-a", provider: "opencode-go", label: "Go A" },
      { name: "go-b", provider: "opencode-go-b", base: "opencode-go", keyEnv: "GO_B_KEY", label: "go-b", models: ["m1"], monthlyUsd: { "*": 10 } },
    ]);
  });

  it("finds an account by provider and lists the staged ones", () => {
    expect(opencodeAccountByProvider(config, "opencode-go")?.name).toBe("go-a");
    expect(opencodeAccountByProvider(config, "nope")).toBeUndefined();
    expect(stagedOpencodeAccounts(config).map((a) => a.name)).toEqual(["go-b"]);
  });

  it("returns nothing without accounts", () => {
    expect(declaredOpencodeAccounts({})).toEqual([]);
  });
});

describe("a keyEnv the rest of config.yaml expands", () => {
  const accounts = { a: { provider: "p", base: "q", keyEnv: "SHARED_TOKEN" } };

  it("is refused, saying the gateway removes the variable from every other process", () => {
    const problems = validateOpencodeAccounts(engines(accounts), configEnvReferences({ gateway: { host: "${SHARED_TOKEN}" }, engines: { opencode: { accounts } } }));
    expect(problems).toHaveLength(1);
    expect(problems[0]).toMatch(/expanded elsewhere in config\.yaml.*removes an account's key variable from every other process/);
  });

  it("is found under either spelling, in any string value, but not in the accounts block itself", () => {
    const spellings = { hooks: { a: ["run $SHARED_TOKEN now"], b: { c: "x-${SHARED_TOKEN:-none}" } } };
    expect([...configEnvReferences(spellings)].sort()).toEqual(["SHARED_TOKEN"]);
    expect(configEnvReferences({ engines: { opencode: { accounts } } }).size).toBe(0);
    expect(configEnvReferences({ engines: { opencode: { accounts, bin: "$OTHER_BIN" }, claude: { x: "${CLAUDE_X}" } } })).toEqual(new Set(["OTHER_BIN", "CLAUDE_X"]));
  });

  it("leaves an account whose variable nothing else uses alone", () => {
    expect(validateOpencodeAccounts(engines(accounts), configEnvReferences({ gateway: { host: "${OTHER}" }, engines: { opencode: { accounts } } }))).toEqual([]);
  });

  it("refuses it when the whole config is loaded through its shape check", async () => {
    const { validateConfigShape } = await import("../config.js");
    const problems = validateConfigShape({ gateway: { port: 7799, host: "$SHARED_TOKEN" }, engines: { claude: {}, opencode: { accounts } }, sessions: {} });
    expect(problems.join("\n")).toMatch(/keyEnv: SHARED_TOKEN is expanded elsewhere/);
  });
});
