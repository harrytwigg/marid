import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import type { JinnConfig, ModelInfo } from "../../shared/types.js";
import type { OpencodeCloneModel } from "../../shared/opencode-clone.js";
import { baseConfig, call, loadApi, resetFallbackFixture, setConfig, unloadApi } from "./session-fallback-api-harness.js";

/**
 * opencode accounts over HTTP and everywhere else the gateway speaks:
 * `/api/engines` lists an account's models, `/api/fallback-chains` reports the
 * links that name a model or an account opencode does not serve, and none of
 * the gateway's surfaces (the API, the staged config, the log lines, doctor's
 * words) ever carries the key's value.
 */

const SENTINEL = "sentinel-key-b-0123456789abcdef";
const KEY_ENV = "OPENCODE_GO_B_API_KEY";

const catalogue: ModelInfo[] = [
  { id: "opencode-go/alpha", label: "alpha", supportsEffort: true, effortLevels: ["low", "high"], contextWindow: 200_000 },
  { id: "opencode-go/beta", label: "beta", supportsEffort: false, effortLevels: [] },
  { id: "opencode/big-pickle", label: "big-pickle", supportsEffort: false, effortLevels: [] },
];
const clones = new Map<string, readonly OpencodeCloneModel[]>([["opencode-go", [
  { id: "alpha", name: "Alpha", npm: "@opencode/ai/providers/openai-compatible", endpoint: "https://go.example.test/openai/v1" },
  { id: "beta", name: "Beta", npm: "@opencode/ai/providers/openai-compatible", endpoint: "https://go.example.test/openai/v1" },
]]]);
const logged: string[] = [];

vi.mock("../../shared/models.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../shared/models.js")>()),
  engineAvailable: () => true,
}));
vi.mock("../../shared/opencode-catalogue.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../shared/opencode-catalogue.js")>()),
  opencodeCatalogue: () => catalogue,
  opencodeClones: () => clones,
}));
vi.mock("../../shared/logger.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../shared/logger.js")>();
  const keep = (...args: unknown[]) => { logged.push(args.map((a) => (typeof a === "string" ? a : JSON.stringify(a))).join(" ")); };
  return { ...actual, logger: { ...actual.logger, debug: keep, info: keep, warn: keep, error: keep } };
});

beforeAll(loadApi);
afterAll(unloadApi);

function configWith(over: { accounts?: unknown; fallback?: unknown[] } = {}): JinnConfig {
  return {
    ...baseConfig,
    engines: {
      ...baseConfig.engines,
      claude: { bin: "claude", model: "opus", fallback: over.fallback ?? [] },
      opencode: {
        bin: "opencode",
        model: "opencode/big-pickle",
        accounts: over.accounts ?? { b: { provider: "opencode-go-b", base: "opencode-go", keyEnv: KEY_ENV, label: "Go B" } },
      },
    },
  } as unknown as JinnConfig;
}

/** A config the registry has not seen: it caches the entry it built for the last one. */
async function use(config: JinnConfig): Promise<void> {
  setConfig(config);
  (await import("../../shared/models.js")).invalidateModelRegistry();
}

beforeEach(async () => {
  resetFallbackFixture();
  logged.length = 0;
  process.env[KEY_ENV] = SENTINEL;
  await use(configWith());
});
afterEach(() => { delete process.env[KEY_ENV]; });

const subject = (body: any, kind: string, id: string) => body.subjects.find((s: any) => s.kind === kind && s.id === id);

describe("GET /api/engines", () => {
  it("lists an account's models as <provider>/<model> with the base's label, window and effort levels, and the account", async () => {
    const { status, body } = await call("GET", "/api/engines");
    expect(status).toBe(200);
    const models: ModelInfo[] = body.engines.opencode.models;
    expect(models.find((m) => m.id === "opencode-go-b/alpha")).toEqual({
      id: "opencode-go-b/alpha", label: "alpha", supportsEffort: true, effortLevels: ["low", "high"], contextWindow: 200_000, account: "b",
    });
    expect(models.find((m) => m.id === "opencode-go-b/beta")).toMatchObject({ account: "b" });
    // The base's own models, and those of other providers, are listed as before.
    expect(models.find((m) => m.id === "opencode-go/alpha")).not.toHaveProperty("account");
    expect(models.find((m) => m.id === "opencode/big-pickle")).not.toHaveProperty("account");
  });

  it("lists only the subset an account names", async () => {
    await use(configWith({ accounts: { b: { provider: "opencode-go-b", base: "opencode-go", keyEnv: KEY_ENV, models: ["beta"] } } }));
    const ids = (await call("GET", "/api/engines")).body.engines.opencode.models.map((m: ModelInfo) => m.id);
    expect(ids).toContain("opencode-go-b/beta");
    expect(ids).not.toContain("opencode-go-b/alpha");
  });

  it("adds no model for a built-in provider declared for a card", async () => {
    await use(configWith({ accounts: { go: { provider: "opencode-go" } } }));
    const ids = (await call("GET", "/api/engines")).body.engines.opencode.models.map((m: ModelInfo) => m.id);
    expect(ids.sort()).toEqual(["opencode-go/alpha", "opencode-go/beta", "opencode/big-pickle"]);
  });
});

describe("GET /api/fallback-chains", () => {
  const links = (...models: string[]) => models.map((model) => ({ engine: "opencode", model }));

  it("reports no problem for an account's model", async () => {
    await use(configWith({ fallback: links("opencode-go-b/alpha", "opencode-go/beta") }));
    expect(subject((await call("GET", "/api/fallback-chains")).body, "engine", "claude").problems).toBeUndefined();
  });

  it("reports a model the account does not serve, and a provider neither it nor the catalogue has", async () => {
    await use(configWith({
      accounts: { b: { provider: "opencode-go-b", base: "opencode-go", keyEnv: KEY_ENV, models: ["alpha"] } },
      fallback: links("opencode-go-b/beta", "mystery/x"),
    }));
    expect(subject((await call("GET", "/api/fallback-chains")).body, "engine", "claude").problems).toEqual([
      `engines.claude.fallback[0]: model "opencode-go-b/beta" is not served by account "b"`,
      `engines.claude.fallback[1]: provider "mystery" is not in opencode's catalogue or engines.opencode.accounts`,
    ]);
  });

  it("reports an account whose key variable is not set in the gateway's environment, by name", async () => {
    delete process.env[KEY_ENV];
    await use(configWith({ fallback: links("opencode-go-b/alpha") }));
    expect(subject((await call("GET", "/api/fallback-chains")).body, "engine", "claude").problems)
      .toEqual([`engines.claude.fallback[0]: account "b" has no key: ${KEY_ENV} is not set`]);
  });
});

describe("the key's value", () => {
  it("is on none of the gateway's surfaces: the API, a staged config, the log lines, doctor", async () => {
    const { opencodeAccountStaging } = await import("../../engines/opencode-accounts.js");
    const { writeOpencodeSessionConfig, cleanupOpencodeSessionConfig } = await import("../../engines/opencode-mcp.js");
    const { opencodeAccountProblems } = await import("../../shared/opencode-accounts.js");
    const { opencodeAccountsFindings } = await import("../../cli/doctor-opencode-accounts.js");
    await use(configWith({ fallback: [{ engine: "opencode", model: "opencode-go-b/alpha" }, { engine: "opencode", model: "mystery/x" }] }));
    const config = configWith();

    const surfaces: Record<string, string> = {};
    for (const route of ["/api/config", "/api/engines", "/api/fallback-chains"]) {
      const response = await call("GET", route);
      expect(response.status, route).toBe(200);
      surfaces[route] = JSON.stringify(response.body);
    }
    // /api/config shows the variable's NAME (it is not a secret), never its value.
    expect(surfaces["/api/config"]).toContain(KEY_ENV);

    const accounts = opencodeAccountStaging(config)!;
    for (const api of [1, 2] as const) {
      const handle = writeOpencodeSessionConfig(undefined, `leak-${api}`, api, [], accounts);
      try {
        if (handle.staged) surfaces[`staged config (opencode ${api}.x)`] = fs.readFileSync(handle.configPath, "utf8");
      } finally {
        cleanupOpencodeSessionConfig(handle);
      }
    }

    // The key is set, and the account's other problems (an unknown model) make doctor print something.
    const problems = opencodeAccountProblems(
      { engines: { opencode: { accounts: { b: { provider: "opencode-go-b", base: "opencode-go", keyEnv: KEY_ENV, models: ["ghost"] } } } } } as never,
      { catalogue, clones, env: process.env, localApi: 1 },
    );
    expect(problems.length).toBeGreaterThan(0);
    surfaces.doctor = JSON.stringify(opencodeAccountsFindings({ accounts: 1, accountProblems: problems, chainProblems: [] }));
    surfaces["doctor (key unset)"] = JSON.stringify(opencodeAccountProblems(config, { catalogue, clones, env: {} }));
    // The lines the engine logs as it launches a turn with the account staged.
    const { localOpencodeLaunch } = await import("../../engines/opencode-launch.js");
    const plan = localOpencodeLaunch({ prompt: "hi", cwd: process.cwd(), sessionId: "leak-run", model: "opencode-go-b/alpha" }, "leak-run", { disableFff: true, api: 2, accounts });
    cleanupOpencodeSessionConfig(plan.configHandle);
    expect(plan.env[KEY_ENV]).toBe(SENTINEL); // the child has it, as it must
    surfaces["ssh/launch argv"] = plan.args.join(" ");
    surfaces["log lines"] = logged.join("\n");

    // A surface the key could reach is found by a canary, so this cannot pass by searching nothing.
    expect(Object.keys(surfaces).length).toBeGreaterThanOrEqual(7);
    for (const [name, text] of Object.entries(surfaces)) {
      expect(text.length, name).toBeGreaterThan(0);
      expect(text, name).not.toContain(SENTINEL);
    }
  });
});
