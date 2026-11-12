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
  process.env.FAKE_OPENCODE_STAGED_ENV = "GO_A_KEY,GO_B_KEY,OPENCODE_GO_API_KEY";
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
    const accounts = staging();
    const { engine } = serverEngine(() => accounts);
    const result = await engine.run(runOpts({ sessionId: "sess-server-acc" }));
    expect(result.error).toBeUndefined();
    // Served by the server, not by a plain run it fell back to.
    expect(staged().some((line) => line.verb === "run")).toBe(false);
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

/** Two accounts declared; the session's chain reaches only `go-a` (the narrowing the gateway's reader does). */
const TWO = {
  a: { provider: "go-a", base: "base-go", keyEnv: "GO_A_KEY", label: "Go A" },
  b: { provider: "go-b", base: "base-go", keyEnv: "GO_B_KEY", label: "Go B" },
};
const KEYS = { GO_A_KEY: "sentinel-key-a-0123456789abcdef", GO_B_KEY: SENTINEL };
const readerFor = (reach: string[], asked: Array<{ sessionId?: string; model?: string }> = []) => (scope: { sessionId?: string; model?: string }) => {
  asked.push(scope);
  return opencodeAccountStaging(configWith(TWO), KEYS, new Set(reach));
};

describe("an employee whose chain reaches one account", () => {
  const blocks = (config: Record<string, unknown> | null) => Object.keys((config as { provider?: Record<string, unknown> } | null)?.provider ?? {});

  it("stages only that account's block and key, and none when it reaches none (staging itself)", () => {
    const a = opencodeAccountStaging(configWith(TWO), KEYS, new Set(["go-a"]))!;
    expect(Object.keys(a.providers(1))).toEqual(["go-a"]);
    expect(a.env).toEqual({ GO_A_KEY: KEYS.GO_A_KEY });
    expect(a.fingerprint).not.toContain("go-b");
    // None reachable: no block, no key, but every key variable is still listed to be scrubbed from the child.
    const none = opencodeAccountStaging(configWith(TWO), KEYS, new Set())!;
    expect(none.providers(2)).toEqual({});
    expect(none.env).toEqual({});
    expect(none.scrub.slice().sort()).toEqual(["GO_A_KEY", "GO_B_KEY"]);
    expect(buildOpencodeSessionConfigFor(undefined, 2, [], none)).toBeUndefined();
    expect(opencodeAccountStaging(configWith(TWO), KEYS, new Set(["go-a", "go-b"]))!.env).toEqual(KEYS);
  });

  for (const [api, version] of [[1, "1.19.0"], [2, "2.0.32"]] as const) {
    it(`gets only that account on a real run turn (OpenCode ${api}.x), asking with its session and model`, async () => {
      process.env.FAKE_OPENCODE_VERSION = version;
      const asked: Array<{ sessionId?: string; model?: string }> = [];
      const engine = new OpencodeEngine({ mode: () => "run", accounts: readerFor(["go-a"], asked) });
      await engine.run(runOpts({ sessionId: `sess-reach-${api}`, model: "go-a/alpha" }));
      const [seen] = staged();
      expect(blocks(seen?.config ?? null)).toEqual(["go-a"]);
      expect(seen?.env).toMatchObject({ GO_A_KEY: KEYS.GO_A_KEY, GO_B_KEY: null });
      expect(JSON.stringify(seen)).not.toContain(SENTINEL);
      expect(asked).toEqual([{ sessionId: `sess-reach-${api}`, model: "go-a/alpha" }]);
    });
  }

  it("gets no block and no key on a real run turn when its chain reaches no account", async () => {
    const engine = new OpencodeEngine({ mode: () => "run", accounts: readerFor([]) });
    await engine.run(runOpts({ sessionId: "sess-reach-none" }));
    const [seen] = staged();
    expect(seen?.config).toBeNull();
    expect(seen?.env).toEqual({ GO_A_KEY: null, GO_B_KEY: null, OPENCODE_GO_API_KEY: null });
  });

  it("gets only that account on a real local server, asked with its session and model", async () => {
    const asked: Array<{ sessionId?: string; model?: string }> = [];
    const reader = readerFor(["go-a"], asked);
    const lifecycle = new PtyLifecycleManager({ maxLivePtys: 8, enforceLocalCap: false });
    const pool = new OpencodeServerPool(lifecycle, { bin: () => FAKE, accounts: reader });
    try {
      await new OpencodeEngine({ mode: () => "server", servers: pool, accounts: reader }).run(runOpts({ sessionId: "sess-reach-server", model: "go-a/alpha" }));
      expect(staged().some((line) => line.verb === "run")).toBe(false);
      const serve = staged().find((line) => line.verb === "serve");
      expect(blocks(serve?.config ?? null)).toEqual(["go-a"]);
      expect(serve?.env).toMatchObject({ GO_A_KEY: KEYS.GO_A_KEY, GO_B_KEY: null });
      expect(asked.every((scope) => scope.sessionId === "sess-reach-server" && scope.model === "go-a/alpha")).toBe(true);
    } finally {
      await pool.stopAll();
    }
  });

  it("replaces a warm server when a chain change adds an account", async () => {
    let reach = ["go-a"];
    const reader = (scope: { sessionId?: string; model?: string }) => readerFor(reach)(scope);
    const lifecycle = new PtyLifecycleManager({ maxLivePtys: 8, enforceLocalCap: false });
    const pool = new OpencodeServerPool(lifecycle, { bin: () => FAKE, accounts: reader });
    try {
      const engine = new OpencodeEngine({ mode: () => "server", servers: pool, accounts: reader });
      await engine.run(runOpts({ sessionId: "sess-reach-grow" }));
      await engine.run(runOpts({ sessionId: "sess-reach-grow" }));

      expect(staged().some((line) => line.verb === "run")).toBe(false);
      expect(staged().filter((line) => line.verb === "serve")).toHaveLength(1);
      reach = ["go-a", "go-b"];
      await engine.run(runOpts({ sessionId: "sess-reach-grow" }));
      const serves = staged().filter((line) => line.verb === "serve");
      expect(serves).toHaveLength(2);
      expect(blocks(serves[1]?.config ?? null).sort()).toEqual(["go-a", "go-b"]);
    } finally {
      await pool.stopAll();
    }
  });
});

describe("the gateway's own environment holds every account's key", () => {
  const stubKeys = () => { vi.stubEnv("GO_A_KEY", KEYS.GO_A_KEY); vi.stubEnv("GO_B_KEY", KEYS.GO_B_KEY); };
  afterEach(() => vi.unstubAllEnvs());
  const reader = (reach: string[]) => (_scope: { sessionId?: string; model?: string }) => opencodeAccountStaging(configWith(TWO), process.env, new Set(reach));

  it("leaves a run child exactly the reachable key, and none when none is reachable", async () => {
    stubKeys();
    await new OpencodeEngine({ mode: () => "run", accounts: reader(["go-a"]) }).run(runOpts({ sessionId: "sess-env-run-a" }));
    expect(staged().at(-1)?.env).toEqual({ GO_A_KEY: KEYS.GO_A_KEY, GO_B_KEY: null, OPENCODE_GO_API_KEY: null });
    await new OpencodeEngine({ mode: () => "run", accounts: reader([]) }).run(runOpts({ sessionId: "sess-env-run-none" }));
    expect(staged().at(-1)?.env).toEqual({ GO_A_KEY: null, GO_B_KEY: null, OPENCODE_GO_API_KEY: null });
  });

  it("leaves a local server exactly the reachable key", async () => {
    stubKeys();
    const read = reader(["go-a"]);
    const lifecycle = new PtyLifecycleManager({ maxLivePtys: 8, enforceLocalCap: false });
    const pool = new OpencodeServerPool(lifecycle, { bin: () => FAKE, accounts: read });
    try {
      await new OpencodeEngine({ mode: () => "server", servers: pool, accounts: read }).run(runOpts({ sessionId: "sess-env-server" }));
      const serve = staged().find((line) => line.verb === "serve");
      expect(serve?.env).toEqual({ GO_A_KEY: KEYS.GO_A_KEY, GO_B_KEY: null, OPENCODE_GO_API_KEY: null });
    } finally {
      await pool.stopAll();
    }
  });

  it("gives the launch plans' environments (local, remote's ssh client) no unreachable key, and discovery none at all", async () => {
    stubKeys();
    const local = localOpencodeLaunch(runOpts(), "trk-env", { disableFff: true, api: 2, accounts: reader(["go-a"])({}) });
    try {
      expect(local.env.GO_A_KEY).toBe(KEYS.GO_A_KEY);
      expect("GO_B_KEY" in local.env).toBe(false);
    } finally {
      cleanupOpencodeSessionConfig(local.configHandle);
    }
    const { opencodeDiscoveryEnv, cleanEnv } = await import("../opencode-launch.js");
    const discovery = opencodeDiscoveryEnv(configWith(TWO));
    expect("GO_A_KEY" in discovery || "GO_B_KEY" in discovery).toBe(false);
    // The environment a remote turn's ssh client (and the terminal view) starts with: scrubbed, and nothing added.
    const client = cleanEnv("sess-env-client", { disableFff: true, accounts: reader(["go-a"])({}) });
    expect("GO_A_KEY" in client || "GO_B_KEY" in client).toBe(false);
  });
});
