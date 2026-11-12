import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OpencodeCloneModel } from "../../shared/opencode-clone.js";

/**
 * The accounts of `engines.opencode.accounts`, staged for every local launch
 * path (docs/design/opencode-accounts.md, "Staging"): a real `run` turn and a
 * real server, each started by the engine against the fake opencode, which
 * records the config file it was handed and the environment it started with.
 * The remote paths are in opencode-accounts-remote.test.ts.
 */

const SENTINEL = "sentinel-key-b-0123456789abcdef";
const OPENAI_URL = "https://go.example.test/openai/v1";
const ANTHROPIC_URL = "https://go.example.test/anthropic/v1";

const clones = vi.hoisted(() => ({ value: new Map<string, readonly OpencodeCloneModel[]>() }));
vi.mock("../../shared/opencode-catalogue.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../shared/opencode-catalogue.js")>()),
  opencodeClones: () => clones.value,
}));
vi.mock("../opencode-internal-fallback.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../opencode-internal-fallback.js")>()),
  hostHasInternalFallback: () => false,
  fallbackPluginAbortsTurns: () => false,
}));
vi.mock("../../shared/logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { OpencodeEngine } from "../opencode.js";
import { OpencodeServerPool, serverFingerprint, type OpencodeServerSpec } from "../opencode-server.js";
import { opencodeAccountStaging, type OpencodeAccountStaging } from "../opencode-accounts.js";
import { buildOpencodeSessionConfigFor, cleanupOpencodeSessionConfig, writeOpencodeSessionConfig } from "../opencode-mcp.js";
import { localOpencodeLaunch } from "../opencode-launch.js";
import { PtyLifecycleManager } from "../pty-lifecycle.js";
import { clearOpencodeVersionCache } from "../../shared/opencode-bin-version.js";
import { SERVER_TURN_TIMING } from "../opencode-server-turn.js";
import { MIN_OPENCODE_V2_SERVER_VERSION } from "../opencode-version.js";
import { JINN_HOME } from "../../shared/paths.js";
import type { JinnConfig } from "../../shared/types.js";
import type { EngineRunOpts } from "../../shared/types.js";

const FAKE = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures", "fake-opencode.mjs");

const GO_MODELS: OpencodeCloneModel[] = [
  { id: "alpha", name: "Alpha", npm: "@opencode/ai/providers/openai-compatible", endpoint: OPENAI_URL, cost: { input: 1, output: 2, cache_read: 0.1, cache_write: 0.2 }, limit: { context: 200_000 } },
  { id: "beta", name: "Beta", npm: "@opencode/ai/providers/anthropic", endpoint: ANTHROPIC_URL },
  { id: "gamma", name: "Gamma", npm: "@opencode/ai/providers/openai-compatible", endpoint: OPENAI_URL },
];

function configWith(accounts: Record<string, unknown> | undefined): JinnConfig {
  return { gateway: {}, engines: { default: "claude", opencode: { ...(accounts ? { accounts } : {}) } }, sessions: {} } as unknown as JinnConfig;
}
const ACCOUNT_B = { b: { provider: "go-b", base: "base-go", keyEnv: "GO_B_KEY", label: "Go B" } };

function staging(env: Record<string, string | undefined> = { GO_B_KEY: SENTINEL }, accounts: Record<string, unknown> = ACCOUNT_B): OpencodeAccountStaging {
  return opencodeAccountStaging(configWith(accounts), env)!;
}

function runOpts(over: Partial<EngineRunOpts> = {}): EngineRunOpts {
  return { prompt: "hello", cwd: JINN_HOME, sessionId: "sess-acc", bin: FAKE, model: "go-b/alpha", ...over };
}

const stagedLog = () => path.join(JINN_HOME, "staged-accounts.log");
const staged = (): Array<{ verb: string; config: Record<string, unknown> | null; env: Record<string, string | null> }> =>
  (fs.existsSync(stagedLog()) ? fs.readFileSync(stagedLog(), "utf8").split("\n").filter(Boolean) : []).map((line) => JSON.parse(line));

beforeEach(() => {
  clones.value = new Map([["base-go", GO_MODELS]]);
  fs.rmSync(stagedLog(), { force: true });
  process.env.FAKE_OPENCODE_STAGED_LOG = stagedLog();
  process.env.FAKE_OPENCODE_STAGED_ENV = "GO_B_KEY,OPENCODE_GO_API_KEY";
  clearOpencodeVersionCache();
  SERVER_TURN_TIMING.statusPollMs = 30_000;
  SERVER_TURN_TIMING.connectMs = 15_000;
  SERVER_TURN_TIMING.closeWaitMs = 2_000;
});

afterEach(() => {
  for (const name of ["FAKE_OPENCODE_STAGED_LOG", "FAKE_OPENCODE_STAGED_ENV", "FAKE_OPENCODE_VERSION"]) delete process.env[name];
  fs.rmSync(stagedLog(), { force: true });
});

describe("the staged provider block", () => {
  it("is staged on its own, with no MCP servers, in OpenCode 1.x's shape", () => {
    const config = buildOpencodeSessionConfigFor(undefined, 1, [], staging());
    expect(config).toMatchObject({
      mcp: {},
      provider: { "go-b": { name: "Go B", npm: "@ai-sdk/openai-compatible", options: { baseURL: OPENAI_URL, apiKey: "{env:GO_B_KEY}" } } },
    });
    const block = (config as { provider: Record<string, { models: Record<string, unknown> }> }).provider["go-b"]!;
    // 1.x: the model on the anthropic endpoint is left out, as 1.x would send it to the block's own.
    expect(Object.keys(block.models)).toEqual(["alpha", "gamma"]);
  });

  it("is staged on its own in OpenCode 2.x's shape, with the model on another endpoint carried per model", () => {
    const config = buildOpencodeSessionConfigFor(undefined, 2, [], staging());
    expect(config).toMatchObject({ mcp: { servers: {} } });
    const block = (config as unknown as { provider: Record<string, { models: Record<string, { provider?: unknown }> }> }).provider["go-b"]!;
    expect(Object.keys(block.models)).toEqual(["alpha", "beta", "gamma"]);
    expect(block.models.beta?.provider).toEqual({ npm: "@ai-sdk/anthropic", api: ANTHROPIC_URL });
  });

  it("stages nothing when no account has a base, and leaves a session with no servers unstaged", () => {
    expect(opencodeAccountStaging(configWith(undefined))).toBeUndefined();
    expect(opencodeAccountStaging(configWith({ a: { provider: "opencode-go" } }))).toBeUndefined();
    expect(buildOpencodeSessionConfigFor(undefined, 2, [], undefined)).toBeUndefined();
  });

  it("holds the key as an environment reference only, whether or not the variable is set", () => {
    for (const env of [{ GO_B_KEY: SENTINEL }, {}]) {
      const accounts = staging(env);
      for (const api of [1, 2] as const) {
        const text = JSON.stringify(buildOpencodeSessionConfigFor(undefined, api, [], accounts));
        expect(text).toContain("{env:GO_B_KEY}");
        expect(text).not.toContain(SENTINEL);
      }
    }
  });

  it("writes the file 0600 under the gateway's home, and no key into it", () => {
    const handle = writeOpencodeSessionConfig(undefined, "sess-file", 2, [], staging());
    try {
      expect(handle.staged).toBe(true);
      if (!handle.staged) return;
      const text = fs.readFileSync(handle.configPath, "utf8");
      expect(JSON.parse(text).provider["go-b"].options.apiKey).toBe("{env:GO_B_KEY}");
      expect(text).not.toContain(SENTINEL);
      if (process.platform !== "win32") expect(fs.statSync(handle.configPath).mode & 0o777).toBe(0o600);
    } finally {
      cleanupOpencodeSessionConfig(handle);
    }
  });
});

describe("the key variable on a local child", () => {
  it("is set explicitly from the gateway's environment, beside OPENCODE_CONFIG", () => {
    const plan = localOpencodeLaunch(runOpts(), "trk-1", { disableFff: true, api: 2, accounts: staging() });
    try {
      expect(plan.env.GO_B_KEY).toBe(SENTINEL);
      expect(plan.env.OPENCODE_CONFIG).toMatch(/opencode\.json$/);
      expect(plan.args.join(" ")).not.toContain(SENTINEL);
    } finally {
      cleanupOpencodeSessionConfig(plan.configHandle);
    }
  });

  it("stages the block but sets no variable when the gateway has none", () => {
    const plan = localOpencodeLaunch(runOpts(), "trk-2", { disableFff: true, api: 1, accounts: staging({}) });
    try {
      expect("GO_B_KEY" in plan.env).toBe(false);
      expect(plan.env.OPENCODE_CONFIG).toBeDefined();
    } finally {
      cleanupOpencodeSessionConfig(plan.configHandle);
    }
  });

  it("is untouched for a turn with no accounts", () => {
    const plan = localOpencodeLaunch(runOpts(), "trk-3", { disableFff: true, api: 2 });
    expect(plan.env.OPENCODE_CONFIG).toBeUndefined();
    expect(plan.env.GO_B_KEY).toBeUndefined();
  });
});

describe("a real run turn", { timeout: 20_000 }, () => {
  for (const [api, version] of [[1, "1.19.0"], [2, "2.0.32"]] as const) {
    it(`gets the provider block and its key on OpenCode ${api}.x`, async () => {
      process.env.FAKE_OPENCODE_VERSION = version;
      const accounts = staging();
      const engine = new OpencodeEngine({ mode: () => "run", accounts: () => accounts });
      const result = await engine.run(runOpts({ sessionId: `sess-run-${api}` }));
      expect(result.error).toBeUndefined();
      const [seen] = staged();
      expect(seen?.verb).toBe("run");
      expect(seen?.env.GO_B_KEY).toBe(SENTINEL);
      const block = (seen?.config as { provider?: Record<string, { options: { apiKey: string }; models: Record<string, unknown> }> }).provider?.["go-b"];
      expect(block?.options.apiKey).toBe("{env:GO_B_KEY}");
      expect(Object.keys(block?.models ?? {})).toEqual(api === 1 ? ["alpha", "gamma"] : ["alpha", "beta", "gamma"]);
      expect(JSON.stringify(seen?.config)).not.toContain(SENTINEL);
    });
  }

  it("is given no config at all when no account is declared and the session has no servers", async () => {
    const engine = new OpencodeEngine({ mode: () => "run" });
    await engine.run(runOpts());
    expect(staged()[0]?.config).toBeNull();
  });
});

describe("a real local server", { timeout: 30_000 }, () => {
  let pools: OpencodeServerPool[] = [];
  afterEach(async () => {
    await Promise.all(pools.map((pool) => pool.stopAll()));
    pools = [];
  });

  function serverEngine(read: () => OpencodeAccountStaging | undefined) {
    const lifecycle = new PtyLifecycleManager({ maxLivePtys: 8, enforceLocalCap: false });
    const pool = new OpencodeServerPool(lifecycle, { bin: () => FAKE, accounts: read });
    pools.push(pool);
    return { pool, engine: new OpencodeEngine({ mode: () => "server", servers: pool, accounts: read }) };
  }

  it("starts with the provider block staged and the key variable set", async () => {
    process.env.FAKE_OPENCODE_VERSION = MIN_OPENCODE_V2_SERVER_VERSION;
    const accounts = staging();
    const { engine } = serverEngine(() => accounts);
    const result = await engine.run(runOpts({ sessionId: "sess-server-acc" }));
    expect(result.error).toBeUndefined();
    const serve = staged().find((line) => line.verb === "serve");
    expect(serve?.env.GO_B_KEY).toBe(SENTINEL);
    const block = (serve?.config as { provider?: Record<string, { options: { apiKey: string } }> }).provider?.["go-b"];
    expect(block?.options.apiKey).toBe("{env:GO_B_KEY}");
    expect(JSON.stringify(serve?.config)).not.toContain(SENTINEL);
  });

  it("is replaced when its key is rotated, and kept when nothing changed", async () => {
    let key = "first-key-aaaaaaaaaa";
    const { pool, engine } = serverEngine(() => staging({ GO_B_KEY: key }));
    await engine.run(runOpts({ sessionId: "sess-rotate" }));
    const first = pool.get("sess-rotate")!;
    await engine.run(runOpts({ sessionId: "sess-rotate" }));
    expect(pool.get("sess-rotate")).toBe(first);
    key = "second-key-bbbbbbbbb";
    await engine.run(runOpts({ sessionId: "sess-rotate" }));
    const second = pool.get("sess-rotate")!;
    expect(second).not.toBe(first);
    expect(staged().filter((line) => line.verb === "serve").map((line) => line.env.GO_B_KEY)).toEqual(["first-key-aaaaaaaaaa", "second-key-bbbbbbbbb"]);
  });
});

describe("serverFingerprint", () => {
  const spec: OpencodeServerSpec = { cwd: "/work/a", bin: FAKE };

  it("is unchanged for a server with no accounts", () => {
    expect(serverFingerprint(spec, undefined)).toBe(serverFingerprint(spec));
  });

  it("adds each account's provider, model list and key, so each one's change restarts the server", () => {
    const base = serverFingerprint(spec, staging());
    expect(base).not.toBe(serverFingerprint(spec));
    expect(serverFingerprint(spec, staging())).toBe(base);
    // A rotated key.
    expect(serverFingerprint(spec, staging({ GO_B_KEY: "another-key" }))).not.toBe(base);
    // A key that is no longer set.
    expect(serverFingerprint(spec, staging({}))).not.toBe(base);
    // A changed provider id, subset or base catalogue.
    expect(serverFingerprint(spec, staging(undefined, { b: { ...ACCOUNT_B.b, provider: "go-c" } }))).not.toBe(base);
    expect(serverFingerprint(spec, staging(undefined, { b: { ...ACCOUNT_B.b, models: ["alpha"] } }))).not.toBe(base);
    clones.value = new Map([["base-go", GO_MODELS.slice(0, 2)]]);
    expect(serverFingerprint(spec, staging())).not.toBe(base);
  });

  it("holds a short hash of the key, never the key", () => {
    const accounts = staging();
    expect(accounts.fingerprint).not.toContain(SENTINEL);
    expect(accounts.fingerprint).toContain("go-b");
    expect(accounts.fingerprint).toContain("alpha");
    expect(serverFingerprint(spec, accounts)).toMatch(/^[0-9a-f]{64}$/);
  });
});
