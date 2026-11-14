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
  readGatewayInfo: () => ({ port: 40123, secret: "hook-secret", token: "bearer-token" }),
}));

const {
  FARM_SCRIPT, FACTS_SCRIPT, REMOTE_KILL_SCRIPT, buildTrustSeedCommand, buildSessionEnvFile, buildSshSpawnArgs,
  prepareRemoteSession, clearRemoteStagingCache,
} = await import("../remote-stage.js");

const sha256 = (text: string): string => crypto.createHash("sha256").update(text).digest("hex");

/** Hashes computed on origin/main 5587f6cb and re-pinned once for the codename rename, which changed every name
 *  these scripts and files spell (the kill script names none, so its hash is the original), except `factsScript`: the facts
 *  probe has since learned to read the host's `opencode --version` (OpenCode 2
 *  support), to look for an opencode internal fallback (a read-only probe) and to
 *  look for Muse Code's `muse` (Muse runs remotely too), deliberate changes for
 *  every session, scoped or not. */
const MAIN = {
  farmScript: "2e9a6a0d1df5b1a10a0de28c7e3ea5ebd02c90973736bf11b2383e53ab073f8e",
  factsScript: "1307ac278103761afd19bc01c428cb02ef5c97a26b55540bc300286dcd25aa1e",
  killScript: "d400383f3c8c055691322b6513249351035165e2aae839d87bb95c250e89eaf6",
  trustSeedCommand: "c84fddf24e3f5e6c2859e545b41984701928cf80567bdd7b78b7da7a0dc90f48",
  sessionEnvFile: "d866e3facb784d5441be3395dc892ca6874089d870f8659da7ec5932aa47eb92",
  sshSpawnArgv: "4e3b7485da1d3eb17de4a70e1cd974346fe7a0c2dd3fe70e4be31cf7d8cdb707",
  prepareCommands: "1d1d66d71b490c7b13a1e438f6ccfd8457ecb1991487965b470cd7de7532bd58",
};

const FIXED_FACTS = {
  home: "/home/u", stageDir: "/home/u/.hundredfold-remote-stage", nodeBin: "/usr/bin/node", claudeBin: "/usr/bin/claude",
  hundredfoldVersion: "0.0.0", entryDir: "/home/u/entry",
};

function spawnArgv(): string[] {
  return buildSshSpawnArgs({
    destination: "builder@build-box", tunnelPort: 44321, gatewayPort: 8722, remoteCwd: "/srv/root/work",
    remoteEnv: { HUNDREDFOLD_HOME: "/mnt/hundredfold-home/.hundredfold-remote-stage", HUNDREDFOLD_SESSION_ID: "sess-1", CLAUDE_CODE_DISABLE_ALTERNATE_SCREEN: "1" },
    unsetRemoteEnv: ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_BASE_URL", "CLAUDECODE"],
    bin: "/usr/local/bin/claude",
    args: ["--chrome", "--settings", "/mnt/hundredfold-home/.hundredfold-remote-stage/tmp/settings/sess-1.json"],
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
      home: path.join(tmp, "host"), stageDir: path.join(tmp, "host", ".hundredfold-remote-stage"), nodeBin: process.execPath,
      claudeBin: "/bin/true", hundredfoldVersion: "0.0.0", entryDir: path.join(tmp, "host", "entry"),
    };
    await prepareRemoteSession({
      target: { remoteHost: "box", remoteCwd: path.join(tmp, "root", "work") }, remote, facts, engine: "claude", hundredfoldSessionId: "s1", gatewayPort: 40123,
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
