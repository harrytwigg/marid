import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  COMMAND_TIMEOUT_ENV,
  commandTimeoutPluginEntry,
  DEFAULT_COMMAND_TIMEOUT_MS,
  localAssetsDir,
  localCommandTimeoutPlugins,
  remoteAssetsDir,
  resolveCommandTimeoutMs,
} from "../opencode-command-timeout.js";
import { buildOpencodeSessionConfigFor } from "../opencode-mcp.js";
import { opencodeProcessEnv } from "../opencode-launch.js";

/**
 * The command ceiling: its config, where its plugin is listed, and what the
 * two plugins (assets/opencode/command-timeout) do to a shell call. They are
 * loaded here as opencode loads them; the real-binary check is in
 * opencode-v2-e2e.test.ts.
 */

const v1Module = () => import(pathToFileURL(path.join(localAssetsDir(), "opencode", "command-timeout", "v1.js")).href);
const v2Module = () => import(pathToFileURL(path.join(localAssetsDir(), "opencode", "command-timeout", "v2", "index.js")).href);

afterEach(() => vi.unstubAllEnvs());

describe("engines.opencode.commandTimeoutMs", () => {
  it("defaults to 30 minutes and turns off at 0 or anything that is not a positive number", () => {
    expect(DEFAULT_COMMAND_TIMEOUT_MS).toBe(1_800_000);
    expect(resolveCommandTimeoutMs(undefined)).toBe(DEFAULT_COMMAND_TIMEOUT_MS);
    expect(resolveCommandTimeoutMs({})).toBe(DEFAULT_COMMAND_TIMEOUT_MS);
    expect(resolveCommandTimeoutMs({ commandTimeoutMs: 600_000 })).toBe(600_000);
    expect(resolveCommandTimeoutMs({ commandTimeoutMs: 0 })).toBe(0);
    expect(resolveCommandTimeoutMs({ commandTimeoutMs: -1 })).toBe(0);
    expect(resolveCommandTimeoutMs({ commandTimeoutMs: "10m" })).toBe(0);
  });

  it("is passed to opencode in the environment, only when set", () => {
    expect(opencodeProcessEnv({ disableFff: true, commandTimeoutMs: 5000 })[COMMAND_TIMEOUT_ENV]).toBe("5000");
    expect(opencodeProcessEnv({ disableFff: true })).not.toHaveProperty(COMMAND_TIMEOUT_ENV);
    expect(opencodeProcessEnv({ disableFff: true, commandTimeoutMs: 0 })).not.toHaveProperty(COMMAND_TIMEOUT_ENV);
  });
});

describe("where the plugin is listed", () => {
  it("names a module URL for 1.x and a package directory for 2.x", () => {
    expect(commandTimeoutPluginEntry(1, "/opt/jinn/assets", path.posix.join)).toBe("file:///opt/jinn/assets/opencode/command-timeout/v1.js");
    expect(commandTimeoutPluginEntry(2, "/opt/jinn/assets", path.posix.join)).toBe("file:/opt/jinn/assets/opencode/command-timeout/v2");
  });

  it("finds a remote host's assets from its jinn-cli install's MCP entry directory", () => {
    expect(remoteAssetsDir("/usr/lib/node_modules/jinn-cli/dist/src/mcp")).toBe("/usr/lib/node_modules/jinn-cli/assets");
  });

  it("lists this install's plugin only when the ceiling is on", () => {
    expect(localCommandTimeoutPlugins(2, 0)).toEqual([]);
    const [entry] = localCommandTimeoutPlugins(2, 1000);
    expect(entry).toMatch(/^file:\/.*\/assets\/opencode\/command-timeout\/v2$/);
  });

  it("adds it to the staged config beside the MCP servers, in each API's own key", () => {
    const mcp = { mcpServers: { jinn: { command: "node", args: ["server.js"] } } };
    expect(buildOpencodeSessionConfigFor(mcp, 1, ["file:///p/v1.js"])).toMatchObject({ plugin: ["file:///p/v1.js"], mcp: { jinn: { type: "local" } } });
    const v2 = buildOpencodeSessionConfigFor(mcp, 2, ["file:/p/v2"]);
    expect(v2).toMatchObject({ plugins: ["file:/p/v2"], mcp: { servers: { jinn: { codemode: false } } } });
    expect(v2).not.toHaveProperty("plugin");
  });

  it("stages a config for it even when the session has no MCP servers, and none without either", () => {
    expect(buildOpencodeSessionConfigFor(undefined, 1, ["file:///p/v1.js"])).toEqual({ $schema: "https://opencode.ai/config.json", mcp: {}, plugin: ["file:///p/v1.js"] });
    expect(buildOpencodeSessionConfigFor(undefined, 2, ["file:/p/v2"])).toEqual({ $schema: "https://opencode.ai/config.json", mcp: { servers: {} }, plugins: ["file:/p/v2"] });
    expect(buildOpencodeSessionConfigFor(undefined, 2, [])).toBeUndefined();
  });
});

describe("the 1.x plugin", () => {
  it("caps the bash tool's timeout, gives one to a call that asked for none, and leaves a smaller one", async () => {
    vi.stubEnv(COMMAND_TIMEOUT_ENV, "3000");
    const exports = await v1Module();
    expect(Object.keys(exports)).toHaveLength(1);
    const hooks = await (Object.values(exports)[0] as () => Promise<Record<string, (i: unknown, o: { args: Record<string, unknown> }) => Promise<void>>>)();
    const before = hooks["tool.execute.before"]!;
    const call = async (tool: string, args: Record<string, unknown>) => {
      const output = { args: { ...args } };
      await before({ tool, sessionID: "ses_test", callID: "call_test" }, output);
      return output.args.timeout;
    };
    expect(await call("bash", { command: "x", timeout: 600_000 })).toBe(3000);
    expect(await call("bash", { command: "x" })).toBe(3000);
    expect(await call("bash", { command: "x", timeout: 0 })).toBe(3000);
    expect(await call("bash", { command: "x", timeout: 1000 })).toBe(1000);
    expect(await call("read", { filePath: "x", timeout: 600_000 })).toBe(600_000);
  });

  it("does nothing without the ceiling", async () => {
    vi.stubEnv(COMMAND_TIMEOUT_ENV, "");
    const exports = await v1Module();
    expect(await (Object.values(exports)[0] as () => Promise<unknown>)()).toEqual({});
  });
});

describe("the 2.x plugin", () => {
  async function hookWith(ceiling: string) {
    vi.stubEnv(COMMAND_TIMEOUT_ENV, ceiling);
    const plugin = (await v2Module()).default as { id: string; setup: (ctx: unknown) => Promise<void> };
    let hook: ((event: { tool: string; input: Record<string, unknown> }) => Promise<void>) | undefined;
    await plugin.setup({ tool: { hook: async (name: string, fn: typeof hook) => { if (name === "execute.before") hook = fn; } } });
    return { plugin, hook };
  }

  it("caps a foreground shell command's timeout, 0 and none included, and leaves background ones alone", async () => {
    const { plugin, hook } = await hookWith("3000");
    expect(plugin.id).toBe("marid-command-timeout");
    const call = async (tool: string, input: Record<string, unknown>) => {
      const event = { tool, input: { ...input } };
      await hook!(event);
      return event.input.timeout;
    };
    expect(await call("shell", { command: "x", timeout: 0 })).toBe(3000);
    expect(await call("shell", { command: "x" })).toBe(3000);
    expect(await call("shell", { command: "x", timeout: 600_000 })).toBe(3000);
    expect(await call("shell", { command: "x", timeout: 1000 })).toBe(1000);
    expect(await call("shell", { command: "x", background: true })).toBeUndefined();
    expect(await call("read", { path: "x", timeout: 0 })).toBe(0);
  });

  it("registers nothing without the ceiling", async () => {
    const { hook } = await hookWith("0");
    expect(hook).toBeUndefined();
  });
});
