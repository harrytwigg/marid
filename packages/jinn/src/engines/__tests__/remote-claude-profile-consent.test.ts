import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Employee } from "../../shared/types.js";
import type { RemoteExecutionConfig } from "../../shared/config-types.js";

/**
 * A remote employee on a named Claude profile that has never accepted
 * bypass-permissions mode. Claude Code answers `--dangerously-skip-permissions`
 * there with a consent dialog nobody in a gateway PTY can answer, so the turn
 * used to hang until the stall watchdog failed it. Now the operator's own consent
 * travels into the staged `--settings`, and without it the readiness check
 * refuses the turn before anything is spawned.
 *
 * `ssh` is replaced by a local `sh` that runs the remote command as the remote
 * shell would, so the real readiness probe and staging run against temporary
 * directories standing in for the host. Only the host-facts script is answered
 * with canned output: it looks for a `claude` and a `jinn` this machine may not have.
 */

const hoisted = vi.hoisted(() => ({ facts: "" }));

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return {
    ...actual,
    spawn: ((command: string, args: readonly string[], options: object) => {
      if (command !== "ssh") return actual.spawn(command, args as string[], options);
      const remote = args.slice(args.indexOf("--") + 2).join(" ");
      // The facts script travels as `sh -s` with the script on stdin.
      if (remote === "sh -s") return actual.spawn("sh", ["-c", `cat >/dev/null; printf '%s' '${hoisted.facts}'`], options);
      return actual.spawn("sh", ["-c", remote], options);
    }) as typeof actual.spawn,
  };
});

vi.mock("../../gateway/gateway-info.js", () => ({
  readGatewayInfo: () => ({ port: 40123, secret: "hook-secret", token: "bearer-token" }),
}));

const {
  ensureRemoteReady, prepareRemoteSession, buildClaudeProfileProbe, setManagedSettingsDirsForTests,
  clearRemoteFactsCache, clearRemoteProfileCache, clearRemoteStagingCache,
} = await import("../remote-stage.js");
const { employeeRemoteTarget } = await import("../../shared/remote-target.js");
const { resolveJinnHome } = await import("../../shared/paths.js");
const { getPackageVersion } = await import("../../shared/version.js");

let tmp: string;
let profile: string;
let operatorClaudeDir: string;
let remote: RemoteExecutionConfig;

function target(overrides: Partial<Employee> = {}) {
  return employeeRemoteTarget({
    name: "remote-dev", displayName: "Remote Dev", department: "engineering", rank: "employee", engine: "claude",
    model: "opus", persona: "p", remoteHost: "box", remoteCwd: path.join(tmp, "root", "work"),
    remoteClaudeConfigDir: profile, ...overrides,
  } as Employee, { remoteRoot: remote.root, departmentOf: () => null })!;
}

const ready = (t = target()) => ensureRemoteReady(t, remote, { engine: "claude", allowWake: false });

function writeJson(file: string, data: unknown): void {
  fs.writeFileSync(file, JSON.stringify(data, null, 2));
}

beforeEach(() => {
  clearRemoteFactsCache();
  clearRemoteProfileCache();
  clearRemoteStagingCache();
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "remote-consent-")));
  const host = path.join(tmp, "host");
  profile = path.join(host, "profile");
  fs.mkdirSync(profile, { recursive: true });
  fs.writeFileSync(path.join(profile, ".credentials.json"), "{\"signed\":\"in\"}");
  fs.mkdirSync(path.join(tmp, "root", "work"), { recursive: true });
  // The gateway's own instance home doubles as the mount, so the sentinel matches.
  remote = { root: path.join(tmp, "root"), mount: resolveJinnHome() } as RemoteExecutionConfig;
  hoisted.facts = [
    `home=${host}`, `node=${process.execPath}`, `claude=${path.join(host, "claude")}`,
    `jinnversion=${getPackageVersion()}`, `entrydir=${path.join(host, "entry")}`, "",
  ].join("\n");
  // The operator's own Claude settings, which hold no consent unless a test gives them one.
  operatorClaudeDir = path.join(tmp, "operator-claude");
  fs.mkdirSync(operatorClaudeDir);
  vi.stubEnv("CLAUDE_CONFIG_DIR", operatorClaudeDir);
  // Managed settings this machine may have must not decide any result here.
  setManagedSettingsDirsForTests([path.join(tmp, "no-managed-settings")]);
});

afterEach(() => {
  setManagedSettingsDirsForTests(null);
  vi.unstubAllEnvs();
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe.skipIf(process.platform === "win32")("a remote named Claude profile that never accepted bypass-permissions mode", { timeout: 30_000 }, () => {
  it("is refused before spawning, with the setting that fixes it", async () => {
    writeJson(path.join(profile, "settings.json"), { theme: "dark" });
    writeJson(path.join(profile, ".claude.json"), { hasCompletedOnboarding: true });
    const startedAt = Date.now();
    const readiness = await ready();
    expect(Date.now() - startedAt).toBeLessThan(10_000);
    expect(readiness.ready).toBe(false);
    const reason = readiness.ready ? "" : readiness.reason;
    expect(reason).toContain("never accepted bypass-permissions mode");
    expect(reason).toContain(`"skipDangerousModePermissionPrompt": true in ${path.join(profile, "settings.json")}`);
  });

  it("is refused when neither file exists yet", async () => {
    const readiness = await ready();
    expect(readiness.ready ? "" : readiness.reason).toContain("skipDangerousModePermissionPrompt");
  });

  it("does not count a consent set to false", async () => {
    writeJson(path.join(profile, "settings.json"), { skipDangerousModePermissionPrompt: false });
    writeJson(path.join(profile, ".claude.json"), { bypassPermissionsModeAccepted: false });
    expect((await ready()).ready).toBe(false);
  });

  it("runs once the profile's settings.json skips the prompt", async () => {
    writeJson(path.join(profile, "settings.json"), { skipDangerousModePermissionPrompt: true });
    expect((await ready()).ready).toBe(true);
  });

  it("runs once someone has accepted the dialog on that profile", async () => {
    writeJson(path.join(profile, ".claude.json"), { bypassPermissionsModeAccepted: true });
    expect((await ready()).ready).toBe(true);
  });

  it("runs on consent in the session directory's .claude/settings.local.json", async () => {
    const local = path.join(tmp, "root", "work", ".claude");
    fs.mkdirSync(local);
    writeJson(path.join(local, "settings.local.json"), { skipDangerousModePermissionPrompt: true });
    expect((await ready()).ready).toBe(true);
  });

  it("runs on consent in .claude/settings.local.json at the git root above the session directory", async () => {
    const repo = path.join(tmp, "root");
    execFileSync("git", ["init", "-q", repo]);
    fs.mkdirSync(path.join(repo, ".claude"));
    writeJson(path.join(repo, ".claude", "settings.local.json"), { skipDangerousModePermissionPrompt: true });
    expect((await ready()).ready).toBe(true);
  });

  it("still names a missing login before the consent", async () => {
    fs.rmSync(path.join(profile, ".credentials.json"));
    const readiness = await ready();
    expect(readiness.ready ? "" : readiness.reason).toContain("is not signed in");
  });

  it("leaves the remote user's default profile unprobed, as before", async () => {
    expect((await ready(target({ remoteClaudeConfigDir: undefined }))).ready).toBe(true);
  });
});

describe.skipIf(process.platform === "win32")("the operator's bypass consent travels into a remote named-profile session", { timeout: 60_000 }, () => {
  const stagedSettings = async (t = target()) => {
    const readiness = await ready(t);
    if (!readiness.ready) throw new Error(readiness.reason);
    const staging = await prepareRemoteSession({ target: t, remote, facts: readiness.facts, engine: "claude", jinnSessionId: "s1", gatewayPort: 40123 });
    return JSON.parse(fs.readFileSync(staging.settingsPath, "utf-8"));
  };

  it("runs the profile and stages the consent in its --settings", async () => {
    writeJson(path.join(operatorClaudeDir, "settings.json"), { skipDangerousModePermissionPrompt: true });
    expect((await ready()).ready).toBe(true);
    expect((await stagedSettings()).skipDangerousModePermissionPrompt).toBe(true);
  });

  it("never carries a false, which would outrank the profile's own consent", async () => {
    writeJson(path.join(operatorClaudeDir, "settings.json"), { skipDangerousModePermissionPrompt: false });
    writeJson(path.join(profile, "settings.json"), { skipDangerousModePermissionPrompt: true });
    expect(await stagedSettings()).not.toHaveProperty("skipDangerousModePermissionPrompt");
  });

  it("carries nothing into a session on the remote user's default profile", async () => {
    writeJson(path.join(operatorClaudeDir, "settings.json"), { skipDangerousModePermissionPrompt: true });
    expect(await stagedSettings(target({ remoteClaudeConfigDir: undefined }))).not.toHaveProperty("skipDangerousModePermissionPrompt");
  });
});

describe.skipIf(process.platform === "win32")("the operator's attribution travels into a remote named-profile session", { timeout: 60_000 }, () => {
  const attribution = { commit: "", pr: "", sessionUrl: false };
  const guard = { matcher: "Bash", hooks: [{ type: "command", command: "/gateway-host/hooks/guard.sh" }] };

  const stagedSettings = async (t = target()) => {
    const readiness = await ready(t);
    if (!readiness.ready) throw new Error(readiness.reason);
    const staging = await prepareRemoteSession({ target: t, remote, facts: readiness.facts, engine: "claude", jinnSessionId: "s1", gatewayPort: 40123 });
    return JSON.parse(fs.readFileSync(staging.settingsPath, "utf-8"));
  };

  beforeEach(() => {
    writeJson(path.join(operatorClaudeDir, "settings.json"), {
      attribution, skipDangerousModePermissionPrompt: true, hooks: { PreToolUse: [guard] }, theme: "dark",
    });
  });

  it("stages the operator's attribution in the profile's --settings", async () => {
    expect((await stagedSettings()).attribution).toEqual(attribution);
  });

  it("carries it when the profile holds its own consent and the operator gives none", async () => {
    writeJson(path.join(operatorClaudeDir, "settings.json"), { attribution });
    writeJson(path.join(profile, "settings.json"), { skipDangerousModePermissionPrompt: true });
    const settings = await stagedSettings();
    expect(settings.attribution).toEqual(attribution);
    expect(settings).not.toHaveProperty("skipDangerousModePermissionPrompt");
  });

  it("carries an attribution that keeps the trailers, as the operator wrote it", async () => {
    const custom = { commit: "Co-Authored-By: Example <bot@example.com>" };
    writeJson(path.join(operatorClaudeDir, "settings.json"), { attribution: custom, skipDangerousModePermissionPrompt: true });
    expect((await stagedSettings()).attribution).toEqual(custom);
  });

  it("does not carry the operator's PreToolUse hooks, whose commands name the gateway's host", async () => {
    const settings = await stagedSettings();
    expect(settings.hooks.PreToolUse).toHaveLength(1);
    expect(settings.hooks.PreToolUse[0].hooks[0].command).toContain("s1");
    expect(JSON.stringify(settings)).not.toContain("guard.sh");
    expect(settings).not.toHaveProperty("theme");
  });

  it("carries nothing into a session on the remote user's default profile", async () => {
    expect(await stagedSettings(target({ remoteClaudeConfigDir: undefined }))).not.toHaveProperty("attribution");
  });
});

/** Run the probe as ssh would: the command string handed to a login shell. */
const runProbe = (command: string, shell: string[] = ["sh", "-c"]) =>
  execFileSync(shell[0]!, [...shell.slice(1), command], { encoding: "utf-8" }).split(/\s+/).filter(Boolean);

const hasZsh = (() => {
  try {
    execFileSync("zsh", ["-fc", "true"]);
    return true;
  } catch {
    return false;
  }
})();

describe.skipIf(process.platform === "win32")("buildClaudeProfileProbe", () => {
  it("survives a profile path a shell would otherwise split or expand", () => {
    const odd = path.join(tmp, "it's a $HOME `profile`");
    fs.mkdirSync(odd);
    fs.writeFileSync(path.join(odd, ".credentials.json"), "x");
    writeJson(path.join(odd, "settings.json"), { skipDangerousModePermissionPrompt: true });
    expect(runProbe(buildClaudeProfileProbe(odd))).toEqual(["dir", "creds", "consent"]);
  });

  it("runs its script under sh, whatever the remote login shell is", () => {
    expect(buildClaudeProfileProbe(profile).startsWith("sh -c '")).toBe(true);
  });

  // zsh, a Mac's default login shell, aborts a command whose glob matches
  // nothing, which the absent managed-settings.d drop-ins always are.
  it.skipIf(!hasZsh)("finds the profile's consent when the login shell is zsh and no drop-ins exist", () => {
    writeJson(path.join(profile, "settings.json"), { skipDangerousModePermissionPrompt: true });
    expect(runProbe(buildClaudeProfileProbe(profile), ["zsh", "-f", "-c"])).toEqual(["dir", "creds", "consent"]);
  });

  describe("reads the host's managed settings", () => {
    const probe = () => runProbe(buildClaudeProfileProbe(profile));
    let managed: string;
    beforeEach(() => {
      managed = path.join(tmp, "etc claude-code");
      fs.mkdirSync(path.join(managed, "managed-settings.d"), { recursive: true });
      setManagedSettingsDirsForTests([path.join(tmp, "absent"), managed]);
    });

    it("finds consent in managed-settings.json", () => {
      writeJson(path.join(managed, "managed-settings.json"), { skipDangerousModePermissionPrompt: true });
      expect(probe()).toContain("consent");
    });

    it("finds consent in a managed-settings.d drop-in", () => {
      writeJson(path.join(managed, "managed-settings.d", "10-bypass.json"), { skipDangerousModePermissionPrompt: true });
      expect(probe()).toContain("consent");
    });

    it("finds none when the managed settings do not give it", () => {
      writeJson(path.join(managed, "managed-settings.json"), { skipDangerousModePermissionPrompt: false });
      expect(probe()).not.toContain("consent");
    });
  });
});
