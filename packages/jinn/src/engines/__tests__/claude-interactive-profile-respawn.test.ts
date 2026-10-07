import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The Claude profile binds at spawn, like `--model`: a warm PTY runs as the
 * login it was spawned on. A turn or a terminal attach asking for another
 * profile (an account override starting or ending) must cold-respawn on the
 * profile asked for, in either direction between the default profile and a
 * named one, and against a settings file that exists. The same profile reuses
 * the warm PTY, and a turn being typed into the terminal is never torn down.
 */

interface FakePty { env: Record<string, string>; settingsExisted: boolean; writes: string[] }
const ptys: FakePty[] = [];
vi.mock("node-pty", () => ({
  spawn: vi.fn((_bin: string, args: string[], options: { env: Record<string, string> }) => {
    const i = args.indexOf("--settings");
    const record: FakePty = { env: options.env, settingsExisted: i >= 0 && fs.existsSync(args[i + 1]!), writes: [] };
    ptys.push(record);
    return {
      pid: 9300 + ptys.length, _exitCode: null, onData() {}, onExit() {}, kill() {},
      write(data: string) { record.writes.push(data); }, resize() {}, on() {},
    };
  }),
}));
vi.mock("../sse-pty-proxy.js", () => ({
  MAIN_AGENT_SENTINEL: "<!-- jinn-main-agent:5c1f -->",
  SsePtyProxy: class {
    port = 0;
    constructor(_label: string, _onEvent: (e: unknown) => void) {}
    async start() { return 41600; }
    stop() {}
  },
}));

import { InteractiveClaudeEngine } from "../claude-interactive.js";
import { PtyLifecycleManager } from "../pty-lifecycle.js";
import { claudeProfileFromDir, type ClaudeProfile } from "../../shared/claude-profile.js";
import { cleanupSessionSettings } from "../../shared/claude-settings.js";
import { CLAUDE_SETTINGS_DIR } from "../../shared/paths.js";

const flush = () => new Promise((r) => setTimeout(r, 30));
const SID = "profile-respawn-sess";

let tmp: string;
let defaultDir: string;
let friend: Exclude<ClaudeProfile, null>;
let lifecycle: PtyLifecycleManager;
let engine: InteractiveClaudeEngine;
let hookCb: ((payload: Record<string, unknown>) => void) | undefined;

/** One completed turn, leaving its PTY warm. */
async function turn(prompt: string, claudeProfile: ClaudeProfile | undefined): Promise<void> {
  const run = engine.run({ sessionId: SID, prompt, cwd: tmp, model: "opus", claudeProfile } as never);
  await flush();
  hookCb!({ hook_event_name: "SessionStart", session_id: "thread-1" });
  hookCb!({ hook_event_name: "UserPromptSubmit" });
  hookCb!({ hook_event_name: "Stop", last_assistant_message: `answered ${prompt}` });
  await run;
}

beforeEach(() => {
  ptys.length = 0;
  hookCb = undefined;
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "claude-profile-respawn-")));
  defaultDir = path.join(tmp, "default-claude");
  fs.mkdirSync(defaultDir);
  vi.stubEnv("CLAUDE_CONFIG_DIR", defaultDir);
  friend = claudeProfileFromDir(path.join(tmp, "friend"));
  fs.mkdirSync(friend.dir);
  // The gateway's wiring: a released PTY's per-session settings file is deleted.
  lifecycle = new PtyLifecycleManager({ maxLivePtys: 10, onCleanup: (id) => cleanupSessionSettings(CLAUDE_SETTINGS_DIR, id) });
  engine = new InteractiveClaudeEngine(lifecycle, {
    register: (_id: string, cb: (payload: Record<string, unknown>) => void) => { hookCb = cb; },
    unregister: () => {},
  } as never);
});

afterEach(() => {
  lifecycle.killAll();
  cleanupSessionSettings(CLAUDE_SETTINGS_DIR, SID);
  vi.unstubAllEnvs();
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe("a turn on another Claude profile than the warm PTY's", () => {
  it("default to named: cold-respawns on the named profile", async () => {
    await turn("one", undefined);
    void engine.run({ sessionId: SID, prompt: "two", cwd: tmp, model: "opus", claudeProfile: friend } as never);
    await flush();
    expect(ptys).toHaveLength(2);
    expect(ptys[1]!.env.CLAUDE_CONFIG_DIR).toBe(friend.dir);
    expect(ptys[1]!.settingsExisted).toBe(true);
    expect(ptys[0]!.writes.join("")).not.toContain("two");
  });

  it("named to default: cold-respawns on the default profile", async () => {
    await turn("one", friend);
    void engine.run({ sessionId: SID, prompt: "two", cwd: tmp, model: "opus", claudeProfile: null } as never);
    await flush();
    expect(ptys).toHaveLength(2);
    expect(ptys[1]!.env.CLAUDE_CONFIG_DIR).toBe(defaultDir);
    expect(ptys[1]!.settingsExisted).toBe(true);
    expect(ptys[0]!.writes.join("")).not.toContain("two");
  });

  it("the same profile, null or undefined alike for the default, reuses the warm PTY", async () => {
    await turn("one", null);
    await turn("two", undefined);
    expect(ptys).toHaveLength(1);
    expect(ptys[0]!.writes.join("")).toContain("two");
  });
});

describe("a terminal attach to a warm PTY on another profile", () => {
  it("leaves it alone while a turn is being typed into it", async () => {
    engine.ensureIdleSpawn(SID, { cwd: tmp, claudeProfile: friend });
    await flush();
    // What a UserPromptSubmit no gateway turn owns records: the operator is typing a turn.
    (engine as unknown as { terminalTurns: Map<string, number> }).terminalTurns.set(SID, Date.now());
    engine.ensureIdleSpawn(SID, { cwd: tmp, claudeProfile: null });
    await flush();
    expect(ptys).toHaveLength(1);
  });
});
