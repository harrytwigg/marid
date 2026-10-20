import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RemoteExecutionConfig } from "../../shared/config-types.js";

/**
 * A remote session's `session-env.sh`, staged for real, exports `JINN_EMPLOYEE` for a session that
 * has an employee, on every engine that runs remotely, and leaves it out for one that has none.
 * `ssh` is replaced by a local `sh` (as in remote-department-staging.test.ts), so
 * `prepareRemoteSession` writes the file into a temporary directory standing in for the host.
 */

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return {
    ...actual,
    spawn: ((command: string, args: readonly string[], options: object) => {
      if (command !== "ssh") return actual.spawn(command, args as string[], options);
      return actual.spawn("sh", ["-c", args.slice(args.indexOf("--") + 2).join(" ")], options);
    }) as typeof actual.spawn,
  };
});
vi.mock("../../gateway/gateway-info.js", () => ({
  readGatewayInfo: () => ({ port: 40123, secret: "hook-secret", token: "bearer-token" }),
}));

const { prepareRemoteSession, clearRemoteStagingCache } = await import("../remote-stage.js");
const { createSession, deleteSession } = await import("../../sessions/registry.js");

let tmp: string;
let remote: RemoteExecutionConfig;
let facts: import("../remote-stage.js").RemoteFacts;
const sessionIds: string[] = [];

function session(engine: string, employee?: string): string {
  const created = createSession({ engine, source: "web", sourceRef: `web:${employee ?? "none"}`, ...(employee ? { employee } : {}) });
  sessionIds.push(created.id);
  return created.id;
}

async function envFileOf(engine: "claude" | "pi" | "opencode" | "musecode", jinnSessionId: string): Promise<string> {
  const staging = await prepareRemoteSession({
    target: { remoteHost: "box", remoteCwd: path.join(tmp, "root", "work") }, remote, facts, engine, jinnSessionId, gatewayPort: 40123,
  } as never);
  return fs.readFileSync(staging.envFilePath, "utf-8");
}

beforeEach(() => {
  clearRemoteStagingCache();
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "remote-employee-env-")));
  const mount = path.join(tmp, "mount");
  fs.mkdirSync(path.join(mount, "knowledge"), { recursive: true });
  fs.writeFileSync(path.join(mount, "CLAUDE.md"), "company rules\n");
  fs.mkdirSync(path.join(tmp, "root", "work"), { recursive: true });
  fs.mkdirSync(path.join(tmp, "host", "profile"), { recursive: true });
  remote = { root: path.join(tmp, "root"), mount, claudeConfigDir: path.join(tmp, "host", "profile") } as RemoteExecutionConfig;
  facts = {
    home: path.join(tmp, "host"), stageDir: path.join(tmp, "host", ".jinn-remote-stage"), nodeBin: process.execPath,
    claudeBin: "/bin/true", jinnVersion: "0.0.0", entryDir: path.join(tmp, "host", "entry"),
  };
});

afterEach(() => {
  for (const id of sessionIds.splice(0)) deleteSession(id);
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe.skipIf(process.platform === "win32")("a remote session's session-env.sh", { timeout: 60_000 }, () => {
  for (const engine of ["claude", "pi", "opencode", "musecode"] as const) {
    it(`exports JINN_EMPLOYEE for a ${engine} session with an employee, and not for one without`, async () => {
      const withEmployee = await envFileOf(engine, session(engine, "build-dev"));
      expect(withEmployee).toContain("export JINN_EMPLOYEE='build-dev'\n");
      expect(withEmployee).toContain("export JINN_GATEWAY_TOKEN='bearer-token'");

      const without = await envFileOf(engine, session(engine));
      expect(without).not.toContain("JINN_EMPLOYEE");
    });
  }
});

describe.skipIf(process.platform === "win32")("a remote opencode session's staged config", { timeout: 60_000 }, () => {
  async function stagedConfig(opencodeVersion: string | undefined, commandTimeout: boolean): Promise<Record<string, unknown> | undefined> {
    const staging = await prepareRemoteSession({
      target: { remoteHost: "box", remoteCwd: path.join(tmp, "root", "work") },
      remote,
      facts: { ...facts, ...(opencodeVersion ? { opencodeVersion } : {}) },
      engine: "opencode",
      jinnSessionId: session("opencode"),
      gatewayPort: 40123,
      ...(commandTimeout ? { opencodeCommandTimeout: true } : {}),
    } as never) as { opencodeConfigPath?: string };
    return staging.opencodeConfigPath ? JSON.parse(fs.readFileSync(staging.opencodeConfigPath, "utf-8")) as Record<string, unknown> : undefined;
  }

  it("lists the command-timeout plugin from the host's own jinn-cli install, in the API's shape", async () => {
    const assets = path.posix.join(facts.entryDir, "..", "..", "..", "assets");
    expect(await stagedConfig("2.0.29", true)).toMatchObject({ plugins: [`file:${assets}/opencode/command-timeout/v2`], mcp: { servers: {} } });
    expect(await stagedConfig("1.19.0", true)).toMatchObject({ plugin: [`file://${assets}/opencode/command-timeout/v1.js`] });
  });

  it("stages no config without the ceiling or MCP servers", async () => {
    expect(await stagedConfig("2.0.29", false)).toBeUndefined();
  });
});

describe.skipIf(process.platform === "win32")("a remote Muse Code session's staging", { timeout: 60_000 }, () => {
  const CAPABILITY = "capability-of-this-session";
  const gatewayMcp = {
    mcpServers: {
      jinn: {
        command: process.execPath,
        args: ["/gateway/dist/src/mcp/server-entry.js"],
        env: { JINN_HOME: "/gateway/home", JINN_GATEWAY_URL: "http://127.0.0.1:7777", JINN_SESSION_CAPABILITY: CAPABILITY },
      },
    },
  };

  async function stage(resolvedMcp?: typeof gatewayMcp) {
    return await prepareRemoteSession({
      target: { remoteHost: "box", remoteCwd: path.join(tmp, "root", "work") }, remote, facts, engine: "musecode",
      jinnSessionId: session("musecode"), gatewayPort: 40123, ...(resolvedMcp ? { resolvedMcp } : {}),
    });
  }

  /** Every file under the stand-in host, with its content. */
  function hostFiles(): Array<[string, string]> {
    const host = path.join(tmp, "host");
    return (fs.readdirSync(host, { recursive: true }) as string[])
      .map((rel) => path.join(host, rel))
      .filter((file) => fs.lstatSync(file).isFile())
      .map((file) => [file, fs.readFileSync(file, "utf-8")]);
  }

  it("re-points the MCP set at the host's install and this session's tunnel, and keeps the capability off the host's disk", async () => {
    const staging = await stage(gatewayMcp);
    expect(staging.engine).toBe("musecode");
    expect(staging.resolvedMcp?.mcpServers.jinn).toMatchObject({
      command: facts.nodeBin,
      args: [path.posix.join(facts.entryDir, "server-entry.js")],
      env: { JINN_HOME: staging.sessionHome, JINN_GATEWAY_URL: `http://127.0.0.1:${staging.tunnelPort}`, JINN_SESSION_CAPABILITY: CAPABILITY },
    });
    // Muse takes the set over the host's stdin, so no file carries it.
    expect(hostFiles().filter(([, content]) => content.includes(CAPABILITY)).map(([file]) => file)).toEqual([]);
  });

  it("stages no MCP set for a session that has none, and no Claude trust seed either", async () => {
    const staging = await stage();
    expect(staging).not.toHaveProperty("resolvedMcp");
    expect(fs.existsSync(path.join(tmp, "host", "profile", ".claude.json"))).toBe(false);
  });
});
