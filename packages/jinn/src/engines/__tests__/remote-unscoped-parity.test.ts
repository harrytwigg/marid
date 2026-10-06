import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { RemoteExecutionConfig } from "../../shared/config-types.js";

/**
 * SC-007: the unscoped remote staging is byte-identical to `main`. The scripts, the trust
 * seed command, the environment file, the ssh argv and the ordered remote commands an
 * unscoped spawn runs are pinned by sha256. Every hash was computed by running this same
 * code in a detached worktree of origin/main at commit 5587f6cb, the commit before scoped
 * remote staging was added; a change to any of them for an unscoped session fails here.
 */

const hoisted = vi.hoisted(() => ({ ssh: [] as string[] }));

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return {
    ...actual,
    spawn: ((command: string, args: readonly string[], options: object) => {
      if (command !== "ssh") return actual.spawn(command, args as string[], options);
      const remote = args.slice(args.indexOf("--") + 2).join(" ");
      hoisted.ssh.push(remote);
      return actual.spawn("sh", ["-c", remote], options);
    }) as typeof actual.spawn,
  };
});
vi.mock("../../gateway/gateway-info.js", () => ({
  readGatewayInfo: () => ({ port: 7777, secret: "hook-secret", token: "bearer-token" }),
}));

const {
  FARM_SCRIPT, FACTS_SCRIPT, REMOTE_KILL_SCRIPT, buildTrustSeedCommand, buildSessionEnvFile, buildSshSpawnArgs,
  prepareRemoteSession, clearRemoteStagingCache,
} = await import("../remote-stage.js");

const sha256 = (text: string): string => crypto.createHash("sha256").update(text).digest("hex");

/** Hashes computed on origin/main 5587f6cb. */
const MAIN = {
  farmScript: "e5b74a0bedc2ea64111a00392827e9c883deeff711f4cf3640f74fb65a1548e5",
  factsScript: "a330a967f5ec9db60d0c546df32bc9fd95793e259d9bcb01fed1267ba8cf1d98",
  killScript: "d400383f3c8c055691322b6513249351035165e2aae839d87bb95c250e89eaf6",
  trustSeedCommand: "b6a9b06cc4e07add49ef443da653c3c546950dbd0564ddc29e4a2c9833c61b7c",
  sessionEnvFile: "1d350a33a74a0752f1540ecad76daddd0ab98a6686742ed01cad801bc230d910",
  sshSpawnArgv: "1180d17ffa9e3ef37e7e6805d8e678f5a5c2e1544b2dba77429ef026b57f0520",
  prepareCommands: "29dc9d3af88df123a6e6db4caf9d45def7760dcc037b3892a0e1c38128ddc7b3",
};

const FIXED_FACTS = {
  home: "/home/u", stageDir: "/home/u/.jinn-remote-stage", nodeBin: "/usr/bin/node", claudeBin: "/usr/bin/claude",
  jinnVersion: "0.0.0", entryDir: "/home/u/entry",
};

function spawnArgv(): string[] {
  return buildSshSpawnArgs({
    destination: "builder@build-box", tunnelPort: 44321, gatewayPort: 8722, remoteCwd: "/srv/root/work",
    remoteEnv: { JINN_HOME: "/mnt/jinn-home/.jinn-remote-stage", JINN_SESSION_ID: "sess-1", CLAUDE_CODE_DISABLE_ALTERNATE_SCREEN: "1" },
    unsetRemoteEnv: ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_BASE_URL", "CLAUDECODE"],
    bin: "/usr/local/bin/claude",
    args: ["--chrome", "--settings", "/mnt/jinn-home/.jinn-remote-stage/tmp/settings/sess-1.json"],
  });
}

/** The ordered ssh remote commands an unscoped spawn runs, against a fake host in a temp dir, with that dir and the node binary replaced. */
async function prepareCommands(): Promise<string> {
  const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "remote-parity-")));
  try {
    hoisted.ssh.length = 0;
    clearRemoteStagingCache();
    const mount = path.join(tmp, "mount");
    fs.mkdirSync(path.join(mount, "knowledge"), { recursive: true });
    fs.writeFileSync(path.join(mount, "CLAUDE.md"), "company rules\n");
    fs.mkdirSync(path.join(tmp, "root", "work"), { recursive: true });
    fs.mkdirSync(path.join(tmp, "host", "profile"), { recursive: true });
    const remote = { root: path.join(tmp, "root"), mount, claudeConfigDir: path.join(tmp, "host", "profile") } as RemoteExecutionConfig;
    const facts = {
      home: path.join(tmp, "host"), stageDir: path.join(tmp, "host", ".jinn-remote-stage"), nodeBin: process.execPath,
      claudeBin: "/bin/true", jinnVersion: "0.0.0", entryDir: path.join(tmp, "host", "entry"),
    };
    await prepareRemoteSession({
      target: { remoteHost: "box", remoteCwd: path.join(tmp, "root", "work") }, remote, facts, engine: "claude", jinnSessionId: "s1", gatewayPort: 7777,
    });
    return hoisted.ssh.map((command) => command.split(tmp).join("<TMP>").split(process.execPath).join("<NODE>")).join("\n--\n");
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

let actual: Record<keyof typeof MAIN, string>;

beforeAll(async () => {
  actual = {
    farmScript: sha256(FARM_SCRIPT),
    factsScript: sha256(FACTS_SCRIPT),
    killScript: sha256(REMOTE_KILL_SCRIPT),
    trustSeedCommand: sha256(buildTrustSeedCommand(FIXED_FACTS, "/srv/root/work", "/p")),
    sessionEnvFile: sha256(buildSessionEnvFile(4242, "tok")),
    sshSpawnArgv: sha256(spawnArgv().join("\n")),
    prepareCommands: sha256(await prepareCommands()),
  };
}, 60_000);
afterAll(() => { hoisted.ssh.length = 0; });

describe.skipIf(process.platform === "win32")("unscoped remote staging against main", () => {
  it("has the farm, facts and kill scripts byte-identical", () => {
    expect([actual.farmScript, actual.factsScript, actual.killScript]).toEqual([MAIN.farmScript, MAIN.factsScript, MAIN.killScript]);
  });

  it("builds the same trust seed command", () => expect(actual.trustSeedCommand).toBe(MAIN.trustSeedCommand));
  it("writes the same environment file", () => expect(actual.sessionEnvFile).toBe(MAIN.sessionEnvFile));
  it("builds the same ssh argv for a session", () => expect(actual.sshSpawnArgv).toBe(MAIN.sshSpawnArgv));
  it("runs the same remote commands, in the same order, to stage an unscoped session", () => expect(actual.prepareCommands).toBe(MAIN.prepareCommands));
});
