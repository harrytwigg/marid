import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RemoteExecutionConfig } from "../../shared/config-types.js";
import type { OpencodeCloneModel } from "../../shared/opencode-clone.js";

/**
 * The accounts of `engines.opencode.accounts` on a remote host (design,
 * "Staging"): the provider block lands in the staged config, the key travels
 * only in the 0600 session-env file, and nothing carries it on an ssh argv.
 *
 * `ssh` is replaced by a local `sh` (as in remote-employee-env.test.ts), so
 * staging writes real files into a temporary directory standing in for the
 * host, and every spawned argv is recorded to be searched.
 */

const SENTINEL = "sentinel-key-b-0123456789abcdef";
const OPENAI_URL = "https://go.example.test/openai/v1";
const ANTHROPIC_URL = "https://go.example.test/anthropic/v1";

const spawned = vi.hoisted(() => ({ argv: [] as string[][] }));

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return {
    ...actual,
    spawn: ((command: string, args: readonly string[], options: object) => {
      spawned.argv.push([command, ...args]);
      if (command !== "ssh") return actual.spawn(command, args as string[], options);
      return actual.spawn("sh", ["-c", args.slice(args.indexOf("--") + 2).join(" ")], options);
    }) as typeof actual.spawn,
  };
});
vi.mock("../../gateway/gateway-info.js", () => ({
  readGatewayInfo: () => ({ port: 40123, secret: "hook-secret", token: "bearer-token" }),
}));

const clones = new Map<string, readonly OpencodeCloneModel[]>([["base-go", [
  { id: "alpha", name: "Alpha", npm: "@opencode/ai/providers/openai-compatible", endpoint: OPENAI_URL, cost: { input: 1, output: 2, cache_read: 0.1, cache_write: 0.2 } },
  { id: "beta", name: "Beta", npm: "@opencode/ai/providers/anthropic", endpoint: ANTHROPIC_URL },
]]]);
vi.mock("../../shared/opencode-catalogue.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../shared/opencode-catalogue.js")>()),
  opencodeClones: () => clones,
}));

const remoteStage = await import("../remote-stage.js");
const { prepareRemoteSession, clearRemoteStagingCache } = remoteStage;
const { opencodeAccountStaging } = await import("../opencode-accounts.js");
const { createSession, deleteSession } = await import("../../sessions/registry.js");

let tmp: string;
let remote: RemoteExecutionConfig;
let facts: import("../remote-stage.js").RemoteFacts;
const sessionIds: string[] = [];

const staging = (env: Record<string, string | undefined> = { GO_B_KEY: SENTINEL }) => opencodeAccountStaging({
  gateway: {}, sessions: {}, engines: { default: "claude", opencode: { accounts: { b: { provider: "go-b", base: "base-go", keyEnv: "GO_B_KEY", label: "Go B" } } } },
} as never, env)!;
const KEY_A = "sentinel-key-a-0123456789abcdef";
/** Two accounts declared, the session's chain reaching `reach` of them. */
const twoAccounts = (reach: string[]) => opencodeAccountStaging({
  gateway: {}, sessions: {}, engines: { default: "claude", opencode: { accounts: {
    a: { provider: "go-a", base: "base-go", keyEnv: "GO_A_KEY", label: "Go A" },
    b: { provider: "go-b", base: "base-go", keyEnv: "GO_B_KEY", label: "Go B" },
  } } },
} as never, { GO_A_KEY: KEY_A, GO_B_KEY: SENTINEL }, new Set(reach));

function session(): string {
  const created = createSession({ engine: "opencode", source: "web", sourceRef: "web:remote-accounts" });
  sessionIds.push(created.id);
  return created.id;
}

async function stage(opencodeVersion: string, opencodeAccounts: ReturnType<typeof staging> | undefined) {
  const staged = await prepareRemoteSession({
    target: { remoteHost: "box", remoteCwd: path.join(tmp, "root", "work") },
    remote,
    facts: { ...facts, opencodeVersion },
    engine: "opencode",
    jinnSessionId: session(),
    gatewayPort: 40123,
    ...(opencodeAccounts ? { opencodeAccounts } : {}),
  } as never) as { opencodeConfigPath?: string; envFilePath: string; accountKeysFilePath?: string };
  return {
    accountKeys: staged.accountKeysFilePath ? fs.readFileSync(staged.accountKeysFilePath, "utf-8") : undefined,
    accountKeysFilePath: staged.accountKeysFilePath,
    config: staged.opencodeConfigPath ? JSON.parse(fs.readFileSync(staged.opencodeConfigPath, "utf-8")) as Record<string, unknown> : undefined,
    configText: staged.opencodeConfigPath ? fs.readFileSync(staged.opencodeConfigPath, "utf-8") : "",
    envFile: fs.readFileSync(staged.envFilePath, "utf-8"),
    envFilePath: staged.envFilePath,
  };
}

beforeEach(() => {
  clearRemoteStagingCache();
  spawned.argv = [];
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "opencode-accounts-remote-")));
  const mount = path.join(tmp, "mount");
  fs.mkdirSync(path.join(mount, "knowledge"), { recursive: true });
  fs.writeFileSync(path.join(mount, "CLAUDE.md"), "company rules\n");
  fs.mkdirSync(path.join(tmp, "root", "work"), { recursive: true });
  fs.mkdirSync(path.join(tmp, "host", "profile"), { recursive: true });
  remote = { root: path.join(tmp, "root"), mount, claudeConfigDir: path.join(tmp, "host", "profile") } as RemoteExecutionConfig;
  facts = {
    home: path.join(tmp, "host"), stageDir: path.join(tmp, "host", ".jinn-remote-stage"), nodeBin: process.execPath,
    opencodeBin: "/usr/bin/true", jinnVersion: "0.0.0", entryDir: path.join(tmp, "host", "entry"),
  };
});

afterEach(() => {
  for (const id of sessionIds.splice(0)) deleteSession(id);
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe.skipIf(process.platform === "win32")("a remote opencode session with accounts", { timeout: 60_000 }, () => {
  it("stages the provider block alone, in OpenCode 2.x's shape, with the key as a reference", async () => {
    const { config, configText } = await stage("2.0.32", staging());
    expect(config).toMatchObject({ mcp: { servers: {} }, provider: { "go-b": { npm: "@ai-sdk/openai-compatible", options: { baseURL: OPENAI_URL, apiKey: "{env:GO_B_KEY}" } } } });
    const models = (config as { provider: Record<string, { models: Record<string, { provider?: unknown }> }> }).provider["go-b"]!.models;
    expect(models.beta?.provider).toEqual({ npm: "@ai-sdk/anthropic", api: ANTHROPIC_URL });
    expect(configText).not.toContain(SENTINEL);
  });

  it("leaves out, on a 1.x host, the model off the block's endpoint", async () => {
    const { config } = await stage("1.19.0", staging());
    const models = (config as { provider: Record<string, { models: Record<string, unknown> }> }).provider["go-b"]!.models;
    expect(Object.keys(models)).toEqual(["alpha"]);
  });

  it("carries the key in a 0600 file of its own, never the session-env file the terminal view sources, and nowhere on a command line", async () => {
    const { envFile, envFilePath, accountKeys, accountKeysFilePath, configText } = await stage("2.0.32", staging());
    expect(accountKeys).toBe(`export GO_B_KEY='${SENTINEL}'\n`);
    expect(accountKeysFilePath).toMatch(/\/tmp\/account-keys\.sh$/);
    expect(fs.statSync(accountKeysFilePath!).mode & 0o777).toBe(0o600);
    expect(envFilePath).not.toBe(accountKeysFilePath);
    expect(envFile).not.toContain(SENTINEL);
    expect(envFile).not.toContain("GO_B_KEY");
    expect(configText).not.toContain(SENTINEL);
    expect(spawned.argv.length).toBeGreaterThan(0);
    for (const argv of spawned.argv) expect(argv.join("\u0000"), argv[0]).not.toContain(SENTINEL);
  });

  it("stages the block but exports no variable when the gateway has no key", async () => {
    const { config, envFile, accountKeys } = await stage("2.0.32", staging({}));
    expect(config).toHaveProperty("provider.go-b");
    expect(envFile).not.toContain("GO_B_KEY");
    expect(accountKeys).toBe("");
  });

  it("stages only the account a session's chain reaches: its block in the config and its key in the keys file", async () => {
    const { config, envFile, accountKeys, configText } = await stage("2.0.32", twoAccounts(["go-a"]));
    expect(Object.keys((config as { provider: object }).provider)).toEqual(["go-a"]);
    expect(accountKeys).toBe(`export GO_A_KEY='${KEY_A}'\n`);
    expect(envFile).not.toMatch(/GO_[AB]_KEY/);
    expect(envFile).not.toContain(SENTINEL);
    expect(configText).not.toContain("go-b");
  });

  it("stages no account block and no key file for a session whose chain reaches none, or that has no accounts", async () => {
    expect((await stage("2.0.32", twoAccounts([]))).config).toBeUndefined();
    const { envFile, accountKeysFilePath } = await stage("2.0.32", undefined);
    expect(envFile).not.toMatch(/GO_[AB]_KEY/);
    expect(accountKeysFilePath).toBeUndefined();
  });

  it("stages nothing without accounts, MCP servers or a ceiling, as before", async () => {
    expect((await stage("2.0.32", undefined)).config).toBeUndefined();
  });
});

describe.skipIf(process.platform === "win32")("a remote run turn's launch plan", { timeout: 60_000 }, () => {
  it("names the staged config and the session-env file, and no key, on the ssh argv", async () => {
    const stub = await import("../remote-stage.js");
    vi.spyOn(stub, "ensureRemoteReady").mockResolvedValue({ ready: true, facts: { ...facts, opencodeVersion: "2.0.32" } } as never);
    vi.spyOn(stub, "reapStaleRemoteEngine").mockResolvedValue(undefined as never);
    const { remoteOpencodeLaunch } = await import("../opencode-launch.js");
    const plan = await remoteOpencodeLaunch(
      { prompt: "hi", cwd: tmp, sessionId: session(), model: "go-b/alpha", remoteHost: "box", remoteCwd: path.join(tmp, "root", "work") } as never,
      sessionIds.at(-1)!,
      { remote, gatewayPort: 40123, disableFff: true, accounts: staging() },
    );
    const argv = plan.args.join("\u0000");
    expect(argv).toContain("OPENCODE_CONFIG");
    expect(argv).toContain("session-env.sh");
    // The run command sources the keys file after the session-env file.
    expect(argv).toMatch(/\. '[^']*session-env\.sh' && \. '[^']*account-keys\.sh' && /);
    expect(argv).not.toContain(SENTINEL);
    expect(JSON.stringify(plan.env)).not.toContain(SENTINEL);
    expect(plan.prompt).not.toContain(SENTINEL);
  });

  it("lists every declared key variable by name for the MCP children to drop, and carries none of their values", async () => {
    const stub = await import("../remote-stage.js");
    vi.spyOn(stub, "ensureRemoteReady").mockResolvedValue({ ready: true, facts: { ...facts, opencodeVersion: "2.0.32" } } as never);
    vi.spyOn(stub, "reapStaleRemoteEngine").mockResolvedValue(undefined as never);
    const { remoteOpencodeLaunch } = await import("../opencode-launch.js");
    const plan = await remoteOpencodeLaunch(
      { prompt: "hi", cwd: tmp, sessionId: session(), model: "go-b/alpha", remoteHost: "box", remoteCwd: path.join(tmp, "root", "work") } as never,
      sessionIds.at(-1)!,
      { remote, gatewayPort: 40123, disableFff: true, accounts: twoAccounts(["go-b"]) },
    );
    const argv = plan.args.join("\u0000");
    expect(argv).toContain("JINN_SCRUB_ENV='GO_A_KEY,GO_B_KEY'");
    expect(argv).not.toContain(SENTINEL);
    expect(argv).not.toContain(KEY_A);
  });
});
