import { describe, expect, it } from "vitest";
import {
  configuredEngineNames,
  scopeEngineLimitsToConfigured,
} from "../engine-limits-configured.js";
import type { Employee, EngineLimitsResponse, JinnConfig } from "../types.js";

function config(engines: Record<string, unknown>): JinnConfig {
  return {
    gateway: { port: 7799, host: "127.0.0.1" },
    engines: { default: "claude", claude: { bin: "claude", model: "opus" }, ...engines },
  } as unknown as JinnConfig;
}

function employee(over: Partial<Employee>): Employee {
  return {
    name: "worker", displayName: "Worker", department: "platform", rank: "employee",
    engine: "claude", model: "opus", persona: "p", ...over,
  } as Employee;
}

const snapshot = (name: string): EngineLimitsResponse["engines"][string] => ({
  name, available: true, status: "live", source: "test",
  refreshedAt: new Date(0).toISOString(), models: [],
});

function response(names: string[], accounts?: Record<string, string[]>): EngineLimitsResponse {
  return {
    generatedAt: new Date(0).toISOString(),
    default: "claude",
    engines: Object.fromEntries(names.map((name) => [name, snapshot(name)])),
    ...(accounts
      ? {
          accounts: Object.fromEntries(Object.entries(accounts).map(([engine, keys]) => [
            engine,
            keys.map((account) => ({
              ...snapshot(engine), account, label: account,
              location: { kind: "local" as const }, employees: [],
            })),
          ])),
        }
      : {}),
  };
}

describe("configuredEngineNames", () => {
  it("counts the default and every engine with a config block, and no merely supported engine", () => {
    const names = configuredEngineNames(config({ codex: { bin: "codex" }, opencode: {} }));
    expect([...names].sort()).toEqual(["claude", "codex", "opencode"]);
    expect(names.has("grok")).toBe(false);
    expect(names.has("musecode")).toBe(false);
  });

  it("counts an engine an employee runs on, even with no block of its own", () => {
    const names = configuredEngineNames(config({}), [employee({ engine: "pi" })]);
    expect(names.has("pi")).toBe(true);
  });

  it("counts engines named by config and employee fallback chains, legacy strings included", () => {
    const names = configuredEngineNames(
      config({
        claude: {
          fallback: ["codex", { engine: "opencode", model: "anthropic/opus" }],
          accounts: { work: { fallback: ["pi"] } },
        },
      }),
      [employee({ fallback: [{ engine: "grok" }] })],
    );
    expect([...names].filter((name) => name !== "claude").sort()).toEqual(["codex", "grok", "opencode", "pi"]);
  });

  it("treats a named Claude profile as Claude in use", () => {
    const names = configuredEngineNames(config({}), [employee({ engine: "codex", claudeConfigDir: "/tmp/profile" })]);
    expect(names.has("claude")).toBe(true);
  });
});

describe("scopeEngineLimitsToConfigured", () => {
  it("keeps exactly the configured engines and their accounts", () => {
    const scoped = scopeEngineLimitsToConfigured(
      response(["claude", "codex", "grok", "musecode"], { claude: ["claude", "claude:ab12cd34"], grok: ["grok"] }),
      config({ codex: {} }),
    );
    expect(Object.keys(scoped.engines).sort()).toEqual(["claude", "codex"]);
    expect(Object.keys(scoped.accounts ?? {})).toEqual(["claude"]);
    expect(scoped.default).toBe("claude");
    expect(scoped.generatedAt).toBe(new Date(0).toISOString());
  });

  it("leaves a response with no accounts block free of one", () => {
    const scoped = scopeEngineLimitsToConfigured(response(["claude", "grok"]), config({}));
    expect(Object.keys(scoped.engines)).toEqual(["claude"]);
    expect(scoped.accounts).toBeUndefined();
  });
});
