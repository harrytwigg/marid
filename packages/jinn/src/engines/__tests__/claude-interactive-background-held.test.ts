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
const RESUME = "5a1c9d02-1111-4222-8333-444455556666";
const REFUSAL_TAIL = "Run `claude attach 5a1c9d02` to open it, or `claude stop 5a1c9d02` first to resume it here. Add --fork-session to branch off a copy instead.";
const HELD_LINE = `That session is running in the background (5a1c9d02). ${REFUSAL_TAIL}`;

const hoisted = vi.hoisted(() => ({
  spawns: [] as { bin: string; args: string[] }[],
  /** What each successive spawn prints before exiting 1; a spawn past the end stays up. */
  deaths: [] as Array<string | undefined>,
  stops: [] as { bin: string; args: string[]; opts: any }[],
  stopFails: false,
  /** When set, `claude stop` waits for this to be called instead of finishing at once. */
  holdStop: false,
  finishStop: undefined as (() => void) | undefined,
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
      const finish = () => {
        if (hoisted.stopFails) cb(new Error("exit code 1"), "", "no such background session");
        else cb(null, "stopped\n", "");
      };
      if (hoisted.holdStop) hoisted.finishStop = finish;
      else finish();
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
import { backgroundHeldSessionId, backgroundSessionMayHoldPrompt, processStartFailure } from "../../shared/process-start.js";
import { claudeProfileFromDir } from "../../shared/claude-profile.js";
import { CLAUDE_SETTINGS_DIR } from "../../shared/paths.js";
import { cleanupSessionSettings } from "../../shared/claude-settings.js";

const failure = (output: string) => processStartFailure("claude", { exitCode: 1, signal: 0 }, output, 1_000);
const LONG_TITLE = "Review the retry handling of the delegated build and report what the second attempt changed";

describe("backgroundHeldSessionId", () => {
  it("reads the short id out of Claude Code's refusal", () => {
    expect(backgroundHeldSessionId(failure(`\x1b[2m${HELD_LINE}\x1b[0m\r\n`))).toBe("5a1c9d02");
  });

  it("reads it when the session has a title, which replaces \"That session\"", () => {
    expect(backgroundHeldSessionId(failure(`"Fix the retry loop" is running in the background (5a1c9d02). ${REFUSAL_TAIL}`))).toBe("5a1c9d02");
  });

  it("reads it past a long title and a sentence on what became of the prompt", () => {
    const line = `"${LONG_TITLE.slice(0, 60)}" is running in the background (5a1c9d02). Your prompt was not sent to it: the job did not answer in time. ${REFUSAL_TAIL}`;
    expect(backgroundHeldSessionId(failure(line))).toBe("5a1c9d02");
  });

  it("reads it from the `claude stop` instruction alone when a long output has cut the front off", () => {
    const cut = processStartFailure("claude", { exitCode: 1, signal: 0 }, `${"x".repeat(400)} reason ${REFUSAL_TAIL}`, 150);
    expect(cut).not.toContain("is running in the background");
    expect(backgroundHeldSessionId(cut)).toBe("5a1c9d02");
  });

  it("says nothing when Claude Code cannot name the job", () => {
    expect(backgroundHeldSessionId(failure("That session is running in the background. Run `claude agents` to find it and open it, or stop it there first to resume it here."))).toBeUndefined();
  });

  it("says nothing for any other failure, or for the same words printed by a session that did start", () => {
    expect(backgroundHeldSessionId(processStartFailure("claude", { exitCode: 255, signal: 0 }, "ssh: connect to host build-box port 22: Connection refused"))).toBeUndefined();
    expect(backgroundHeldSessionId(processStartFailure("claude", { exitCode: 1, signal: 0 }, "No conversation found with session ID: 5a1c9d02"))).toBeUndefined();
    expect(backgroundHeldSessionId(`Interrupted: claude process exited. ${HELD_LINE}`)).toBeUndefined();
    expect(backgroundHeldSessionId(undefined)).toBeUndefined();
  });
});

describe("backgroundSessionMayHoldPrompt", () => {
  it.each([
    "Your prompt was saved and will be sent to it when you next restart it.",
    "Your prompt was sent to it, but it could not be opened here: the terminal is busy.",
    "Your prompt may not have reached it: the job did not answer.",
  ])("is true when Claude Code says: %s", (sentence) => {
    expect(backgroundSessionMayHoldPrompt(failure(`That session is running in the background (5a1c9d02). ${sentence} ${REFUSAL_TAIL}`))).toBe(true);
  });

  it.each([
    "",
    "Your prompt was not sent to it: the job did not answer.",
    "It could not be opened here: the terminal is busy.",
  ])("is false when the prompt did not arrive: %s", (sentence) => {
    expect(backgroundSessionMayHoldPrompt(failure(`That session is running in the background (5a1c9d02). ${sentence} ${REFUSAL_TAIL}`))).toBe(false);
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
    hoisted.holdStop = false;
    hoisted.finishStop = undefined;
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
    expect(hoisted.stops[0].args).toEqual(["stop", "5a1c9d02"]);
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
    expect(result.error).toContain("running in the background (5a1c9d02)");
  });

  it("still runs the turn again when the stop itself fails, since the session may have ended meanwhile", async () => {
    hoisted.stopFails = true;
    hoisted.deaths.push(HELD_LINE);
    void turn().catch(() => {});
    await vi.waitFor(() => expect(hoisted.spawns).toHaveLength(2));
    expect(hoisted.stops).toHaveLength(1);
  });

  it("does not stop a session other than the one it was asked to resume", async () => {
    hoisted.deaths.push(HELD_LINE.replaceAll("5a1c9d02", "0badf00d"));
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

  it.each([
    "Your prompt was saved and will be sent to it when you next restart it.",
    "Your prompt was sent to it, but it could not be opened here: the terminal is busy.",
    "Your prompt may not have reached it: the job did not answer.",
  ])("does not run the turn again when Claude Code says the prompt reached the session (%s)", async (sentence) => {
    hoisted.deaths.push(`"Fix the retry loop" is running in the background (5a1c9d02). ${sentence} ${REFUSAL_TAIL}`);
    const result = await turn();

    expect(hoisted.stops).toHaveLength(0);
    expect(hoisted.spawns).toHaveLength(1);
    expect(result.error).toContain(sentence);
  });

  it("runs the turn again when Claude Code says the prompt was not sent", async () => {
    hoisted.deaths.push(`"Fix the retry loop" is running in the background (5a1c9d02). Your prompt was not sent to it: the job did not answer. ${REFUSAL_TAIL}`);
    void turn().catch(() => {});
    await vi.waitFor(() => expect(hoisted.spawns).toHaveLength(2));
    expect(hoisted.stops).toHaveLength(1);
  });

  it("answers a stop that arrives while the background session is being stopped, and does not run the turn", async () => {
    hoisted.holdStop = true;
    hoisted.deaths.push(HELD_LINE);
    const pending = turn();
    await vi.waitFor(() => expect(hoisted.finishStop).toBeDefined());

    expect(engine.isTurnRunning(SID)).toBe(true);
    engine.kill(SID, "Interrupted: stopped by the operator");
    hoisted.finishStop!();
    const result = await pending;

    expect(result.error).toBe("Interrupted: stopped by the operator");
    expect(hoisted.spawns).toHaveLength(1);
    expect(engine.isTurnRunning(SID)).toBe(false);
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
    expect(command).toMatch(/'\/usr\/local\/bin\/claude' 'stop' '5a1c9d02'$/);
    expect(args).toContain("builder@build-box");
  });
});
