import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

/**
 * A turn that leaves Claude Code's daemon hosting the session in the
 * background (a long Monitor, a forked sub-agent) makes the next `--resume`
 * exit at once: "That session is running in the background (<id>). Run
 * `claude attach <id>` to open it, or `claude stop <id>` first to resume it
 * here." The message that turn carried must still be delivered, so the engine
 * stops the background session and runs the turn again, once.
 */

const SID = "held-sess";
const RESUME = "7eaeb488-1111-4222-8333-444455556666";
const HELD_LINE = "That session is running in the background (7eaeb488). Run `claude attach 7eaeb488` to open it, or `claude stop 7eaeb488` first to resume it here.";

const hoisted = vi.hoisted(() => ({
  spawns: [] as { bin: string; args: string[] }[],
  /** What each successive spawn prints before exiting 1; a spawn past the end stays up. */
  deaths: [] as Array<string | undefined>,
  stops: [] as { bin: string; args: string[]; opts: any }[],
  stopFails: false,
}));

vi.mock("node-pty", () => ({
  spawn: vi.fn((bin: string, args: string[]) => {
    const index = hoisted.spawns.length;
    hoisted.spawns.push({ bin, args });
    let onData: ((d: string) => void) | undefined;
    let onExit: ((e: { exitCode: number; signal: number }) => void) | undefined;
    const proc = {
      pid: 7000 + index,
      _exitCode: null as number | null,
      onData(cb: (d: string) => void) { onData = cb; },
      onExit(cb: (e: { exitCode: number; signal: number }) => void) { onExit = cb; },
      kill() {},
      write() {},
      resize() {},
      on() {},
    };
    const death = hoisted.deaths[index];
    if (death !== undefined) {
      setTimeout(() => {
        onData?.(`${death}\r\n`);
        proc._exitCode = 1;
        onExit?.({ exitCode: 1, signal: 0 });
      }, 5);
    }
    return proc;
  }),
}));

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return {
    ...actual,
    execFile: vi.fn((bin: string, args: string[], opts: any, cb: (err: Error | null, stdout: string, stderr: string) => void) => {
      hoisted.stops.push({ bin, args, opts });
      if (hoisted.stopFails) cb(new Error("exit code 1"), "", "no such background session");
      else cb(null, "stopped\n", "");
    }),
  };
});

vi.mock("../sse-pty-proxy.js", () => ({
  MAIN_AGENT_SENTINEL: "<!-- jinn-main-agent:5c1f -->",
  SsePtyProxy: class {
    port = 0;
    constructor(_label: string, _onEvent: (e: unknown) => void, _opts?: unknown) {}
    async start() { return 41300; }
    stop() {}
  },
}));

vi.mock("../remote-stage.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../remote-stage.js")>();
  const facts = {
    home: "/home/builder",
    stageDir: "/mnt/jinn-home/.jinn-remote-stage",
    nodeBin: "/usr/bin/node",
    claudeBin: "/usr/local/bin/claude",
    jinnVersion: "0.32.0",
    entryDir: "/usr/lib/jinn/src/mcp",
  };
  return {
    ...actual,
    ensureRemoteReady: vi.fn(async () => ({ ready: true, facts })),
    cachedRemoteFacts: vi.fn(() => facts),
    prepareRemoteSession: vi.fn(async () => ({
      destination: "builder@build-box",
      tunnelPort: 44321,
      sessionHome: "/mnt/jinn-home/.jinn-remote-stage/sessions/held-sess",
      settingsPath: "/mnt/jinn-home/.jinn-remote-stage/sessions/held-sess/tmp/settings.json",
      envFilePath: "/mnt/jinn-home/.jinn-remote-stage/sessions/held-sess/tmp/session-env.sh",
    })),
  };
});

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { InteractiveClaudeEngine } from "../claude-interactive.js";
import { PtyLifecycleManager } from "../pty-lifecycle.js";
import { backgroundHeldSessionId, processStartFailure } from "../../shared/process-start.js";
import { claudeProfileFromDir } from "../../shared/claude-profile.js";
import { CLAUDE_SETTINGS_DIR } from "../../shared/paths.js";
import { cleanupSessionSettings } from "../../shared/claude-settings.js";

describe("backgroundHeldSessionId", () => {
  it("reads the short id out of Claude Code's refusal", () => {
    const error = processStartFailure("claude", { exitCode: 1, signal: 0 }, `\x1b[2m${HELD_LINE}\x1b[0m\r\n`);
    expect(backgroundHeldSessionId(error)).toBe("7eaeb488");
  });

  it("says nothing for any other failure, or for the same words printed by a session that did start", () => {
    expect(backgroundHeldSessionId(processStartFailure("claude", { exitCode: 255, signal: 0 }, "ssh: connect to host build-box port 22: Connection refused"))).toBeUndefined();
    expect(backgroundHeldSessionId(processStartFailure("claude", { exitCode: 1, signal: 0 }, "No conversation found with session ID: 7eaeb488"))).toBeUndefined();
    expect(backgroundHeldSessionId(`Interrupted: claude process exited. ${HELD_LINE}`)).toBeUndefined();
    expect(backgroundHeldSessionId(undefined)).toBeUndefined();
  });
});

describe("InteractiveClaudeEngine — a session held in the daemon's background", () => {
  let lifecycle: PtyLifecycleManager;
  let engine: InteractiveClaudeEngine;

  beforeEach(() => {
    hoisted.spawns.length = 0;
    hoisted.deaths.length = 0;
    hoisted.stops.length = 0;
    hoisted.stopFails = false;
    lifecycle = new PtyLifecycleManager({ maxLivePtys: 10 });
    engine = new InteractiveClaudeEngine(lifecycle, { register: () => {}, unregister: () => {} } as any, {
      remote: () => ({ root: "/srv/jinn-work", mount: "/mnt/jinn-home" }),
      gatewayPort: () => 8722,
    });
  });

  afterEach(() => {
    lifecycle.killAll();
    cleanupSessionSettings(CLAUDE_SETTINGS_DIR, SID);
  });

  const turn = (extra: Record<string, unknown> = {}) => engine.run({ sessionId: SID, prompt: "the reply", cwd: "/tmp", resumeSessionId: RESUME, ...extra } as any);

  it("stops the background session, then resumes it and delivers the message", async () => {
    hoisted.deaths.push(HELD_LINE);
    // The second spawn stays up, as a session that started would; abandon its turn.
    void turn().catch(() => {});
    await vi.waitFor(() => expect(hoisted.spawns).toHaveLength(2));

    expect(hoisted.stops).toHaveLength(1);
    expect(path.basename(hoisted.stops[0].bin)).toBe("claude");
    expect(hoisted.stops[0].args).toEqual(["stop", "7eaeb488"]);
    const resumed = hoisted.spawns[1].args;
    expect(resumed[resumed.indexOf("--resume") + 1]).toBe(RESUME);
    expect(resumed[resumed.length - 1]).toContain("the reply");
  });

  it("runs the stop as the session's own Claude profile", async () => {
    hoisted.deaths.push(HELD_LINE);
    const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "claude-background-held-")));
    try {
      // The operator creates a profile; the gateway never does.
      const profile = claudeProfileFromDir(path.join(tmp, "friend"));
      fs.mkdirSync(profile!.dir);
      void turn({ claudeProfile: profile }).catch(() => {});
      await vi.waitFor(() => expect(hoisted.stops).toHaveLength(1));
      expect(hoisted.stops[0].opts.env.CLAUDE_CONFIG_DIR).toBe(profile!.dir);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("runs the turn again only once: a session still held after the stop fails with Claude Code's own words", async () => {
    hoisted.deaths.push(HELD_LINE, HELD_LINE);
    const result = await turn();

    expect(hoisted.spawns).toHaveLength(2);
    expect(hoisted.stops).toHaveLength(1);
    expect(result.error).toContain("claude did not start");
    expect(result.error).toContain("running in the background (7eaeb488)");
  });

  it("still runs the turn again when the stop itself fails, since the session may have ended meanwhile", async () => {
    hoisted.stopFails = true;
    hoisted.deaths.push(HELD_LINE);
    void turn().catch(() => {});
    await vi.waitFor(() => expect(hoisted.spawns).toHaveLength(2));
    expect(hoisted.stops).toHaveLength(1);
  });

  it("does not stop a session other than the one it was asked to resume", async () => {
    hoisted.deaths.push(HELD_LINE.replaceAll("7eaeb488", "0badf00d"));
    const result = await turn();

    expect(hoisted.stops).toHaveLength(0);
    expect(hoisted.spawns).toHaveLength(1);
    expect(result.error).toContain("running in the background (0badf00d)");
  });

  it("does not touch a failure that is not the daemon holding the session", async () => {
    hoisted.deaths.push("Error: unknown option '--frobnicate'");
    const result = await turn();

    expect(hoisted.stops).toHaveLength(0);
    expect(hoisted.spawns).toHaveLength(1);
    expect(result.error).toContain("unknown option");
  });

  it("stops it on the remote host, over ssh, under the session's remote Claude profile", async () => {
    hoisted.deaths.push(HELD_LINE);
    void turn({
      remoteHost: "build-box", remoteUser: "builder", remoteCwd: "/srv/jinn-work/proj",
      remoteClaudeConfigDir: "/home/builder/.claude-work",
    }).catch(() => {});
    await vi.waitFor(() => expect(hoisted.spawns).toHaveLength(2));

    expect(hoisted.stops).toHaveLength(1);
    const { bin, args } = hoisted.stops[0];
    expect(path.basename(bin)).toBe("ssh");
    // No pty and no reverse tunnel: the live session already holds the tunnel port.
    expect(args).toContain("-T");
    expect(args).not.toContain("-R");
    const command = args[args.length - 1];
    expect(command).toContain("cd '/srv/jinn-work/proj' && exec env");
    expect(command).toContain("CLAUDE_CONFIG_DIR='/home/builder/.claude-work'");
    expect(command).toContain(`PATH='/usr/bin':"$PATH"`);
    expect(command).toMatch(/'\/usr\/local\/bin\/claude' 'stop' '7eaeb488'$/);
    expect(args).toContain("builder@build-box");
  });
});
