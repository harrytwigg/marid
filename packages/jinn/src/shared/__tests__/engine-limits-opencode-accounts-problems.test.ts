import { describe, it, expect, vi } from "vitest";
import os from "node:os";
import path from "node:path";
import type { Employee, EngineLimitEngineSnapshot, JinnConfig, ModelInfo } from "../types.js";
import type { OpencodeCloneModel } from "../opencode-clone.js";

/**
 * `accounts.opencode[].problems` carries what `jinn doctor` says of each account (opencodeAccountProblems): a base
 * missing from the catalogue, a provider collision, an unknown subset model, a base whose endpoints are not staged,
 * models a local 1.x binary leaves out, and a key variable the gateway lacks.
 */

const state = vi.hoisted(() => ({
  catalogue: null as ModelInfo[] | null,
  clones: new Map<string, readonly OpencodeCloneModel[]>(),
  api: undefined as 1 | 2 | undefined,
}));
vi.mock("../opencode-catalogue.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../opencode-catalogue.js")>()),
  opencodeCatalogue: () => state.catalogue,
  opencodeClones: () => state.clones,
  opencodeLocalApi: () => state.api,
}));

process.env.JINN_HOME = path.join(os.tmpdir(), `jinn-oc-accounts-problems-${process.pid}`);
const { collectOpencodeAccounts } = await import("../engine-limits-opencode-accounts.js");

const model = (id: string): ModelInfo => ({ id, label: id, supportsEffort: false, effortLevels: [] });
const clone = (id: string, endpoint: string): OpencodeCloneModel => ({ id, name: id, npm: "@ai-sdk/openai-compatible", endpoint });
const config = (accounts: Record<string, unknown>): JinnConfig => ({
  gateway: { port: 7799, host: "127.0.0.1" },
  engines: { default: "claude", claude: { bin: "claude", model: "opus" }, opencode: { bin: process.execPath, model: "base-go/alpha", accounts } },
  connectors: {},
}) as unknown as JinnConfig;
const snapshot = { name: "opencode", available: true, status: "snapshot", source: "test", refreshedAt: "2026-11-12T12:00:00Z", models: [], buckets: [] } as unknown as EngineLimitEngineSnapshot;
const employees: Employee[] = [];
const problemsOf = (accounts: Record<string, unknown>, env: Record<string, string> = {}) =>
  Object.fromEntries(collectOpencodeAccounts(config(accounts), snapshot, { employees, env, health: {}, now: new Date("2026-11-12T12:00:00Z") })!
    .map((account) => [account.account, account.problems ?? []]));

describe("the account problems on the limits response", () => {
  it("says only the key is unset while the catalogue is not known", () => {
    state.catalogue = null;
    expect(problemsOf({ b: { provider: "go-b", base: "base-go", keyEnv: "GO_B_KEY" } })).toEqual({ b: ['account "b" has no key: GO_B_KEY is not set'] });
  });

  it("carries base missing, collision, unknown subset model, not staged and 1.x dropped models, as doctor words them", () => {
    state.catalogue = [model("base-go/alpha"), model("base-go/beta"), model("base-go/gamma"), model("go-clash/x")];
    state.clones = new Map([["base-go", [clone("alpha", "https://a.example/v1"), clone("gamma", "https://a.example/v1"), clone("beta", "https://b.example/v1")]]]);
    state.api = 1;
    const problems = problemsOf({
      missing: { provider: "go-m", base: "nowhere", keyEnv: "KEY_M" },
      clash: { provider: "go-clash", base: "base-go", keyEnv: "KEY_C" },
      subset: { provider: "go-s", base: "base-go", keyEnv: "KEY_S", models: ["nope"] },
      dropped: { provider: "go-d", base: "base-go", keyEnv: "KEY_D" },
      unstaged: { provider: "go-u", base: "later-base", keyEnv: "KEY_U" },
      ok: { provider: "go-ok", base: "base-go", keyEnv: "KEY_OK", models: ["alpha", "gamma"] },
    }, { KEY_M: "x", KEY_C: "x", KEY_S: "x", KEY_D: "x", KEY_OK: "x" });
    expect(problems.missing).toEqual(['account "missing": base "nowhere" is not in opencode\'s catalogue on this host']);
    expect(problems.clash).toContain('account "clash": provider "go-clash" is already a provider in opencode\'s catalogue; pick an id no provider uses');
    expect(problems.subset).toContain('account "subset": model "nope" is not one of base "base-go"\'s models');
    expect(problems.dropped).toEqual([expect.stringContaining("left out of the model list on this host, and a turn on one fails: beta")]);
    expect(problems.unstaged).toEqual(expect.arrayContaining(['account "unstaged" has no key: KEY_U is not set']));
    expect(problems.ok).toEqual([]);
  });

  it("does not report the 1.x models of a gateway whose local binary is 2.x or unknown", () => {
    state.catalogue = [model("base-go/alpha"), model("base-go/beta")];
    state.clones = new Map([["base-go", [clone("alpha", "https://a.example/v1"), clone("beta", "https://b.example/v1")]]]);
    for (const api of [2, undefined] as const) {
      state.api = api;
      expect(problemsOf({ b: { provider: "go-b", base: "base-go", keyEnv: "KEY_B" } }, { KEY_B: "x" })).toEqual({ b: [] });
    }
  });

  it("has no problems to report for a built-in provider declared without a base", () => {
    state.catalogue = [model("base-go/alpha")];
    expect(problemsOf({ a: { provider: "base-go" } })).toEqual({ a: [] });
  });
});
