import { describe, expect, it } from "vitest";
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
