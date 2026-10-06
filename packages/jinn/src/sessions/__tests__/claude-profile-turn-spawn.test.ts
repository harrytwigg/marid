import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * End to end from the turn to the spawned process: an employee with
 * `claudeConfigDir` must start claude with that CLAUDE_CONFIG_DIR, and a remote
 * employee's ordinary turn must carry its `remoteClaudeConfigDir`. Both were
 * red on main: the first spawned on the gateway's own profile, and the second
 * dropped the profile, so the turn ran on the instance-wide default.
 */

const spawns: Array<{ env: Record<string, string> }> = [];
vi.mock("node-pty", () => ({
  spawn: vi.fn((_bin: string, _args: string[], options: { env: Record<string, string> }) => {
    spawns.push({ env: options.env });
    return { pid: 9100 + spawns.length, _exitCode: null, onData() {}, onExit() {}, kill() {}, write() {}, resize() {}, on() {} };
  }),
}));
vi.mock("../../engines/sse-pty-proxy.js", () => ({
  MAIN_AGENT_SENTINEL: "<!-- jinn-main-agent:5c1f -->",
  SsePtyProxy: class {
    port = 0;
    constructor(_label: string, _onEvent: (e: unknown) => void) {}
    async start() { return 41400; }
    stop() {}
  },
}));

import { runEngineAttempt } from "../turn/engine-run.js";
import { InteractiveClaudeEngine } from "../../engines/claude-interactive.js";
import { PtyLifecycleManager } from "../../engines/pty-lifecycle.js";
import { cleanupSessionSettings } from "../../shared/claude-settings.js";
import { CLAUDE_SETTINGS_DIR } from "../../shared/paths.js";
import type { EngineResult, EngineRunOpts, Employee } from "../../shared/types.js";

const flush = () => new Promise((r) => setTimeout(r, 30));
let tmp: string;
let lifecycle: PtyLifecycleManager;

function turn(engine: { run: (opts: EngineRunOpts) => Promise<EngineResult> }, employee: Partial<Employee>): void {
  void runEngineAttempt({
    input: { session: { id: "turn-spawn-1" }, attachments: [], employee, attemptToken: "t1" } as any,
    plan: {
      engine, engineConfig: {}, promptToRun: "hi", runtimeSource: "web",
      prepareContext: () => ({ systemPrompt: "sys", fingerprint: "f", refresh: undefined }),
    } as any,
    surface: {} as any,
    heartbeat: { beat() {} } as any,
    partialStream: { finish() {}, persist() {} } as any,
    turnStartedAt: Date.now(),
    model: undefined,
  }).catch(() => {});
}

beforeEach(() => {
  spawns.length = 0;
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "claude-profile-turn-")));
  vi.stubEnv("CLAUDE_CONFIG_DIR", path.join(tmp, "default-claude"));
  lifecycle = new PtyLifecycleManager({ maxLivePtys: 10 });
});

afterEach(() => {
  lifecycle.killAll();
  cleanupSessionSettings(CLAUDE_SETTINGS_DIR, "turn-spawn-1");
  vi.unstubAllEnvs();
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe("a turn reaches the spawned claude on the employee's profile", () => {
  it("an employee with claudeConfigDir spawns with that CLAUDE_CONFIG_DIR", async () => {
    const engine = new InteractiveClaudeEngine(lifecycle, { register: () => {}, unregister: () => {} } as any);
    const profileDir = path.join(tmp, "claude-friend");
    fs.mkdirSync(profileDir);
    turn(engine, { name: "side-dev", claudeConfigDir: profileDir });
    await flush();
    expect(spawns).toHaveLength(1);
    expect(spawns[0]!.env.CLAUDE_CONFIG_DIR).toBe(profileDir);
  });

  it("a remote employee's ordinary turn carries remoteClaudeConfigDir", async () => {
    let seen: EngineRunOpts | undefined;
    turn({ run: async (opts) => { seen = opts; return { sessionId: "n", result: "ok" }; } },
      { name: "far", remoteHost: "build-box", remoteCwd: "/srv/w", remoteClaudeConfigDir: "/home/b/.claude-work" });
    await flush();
    expect(seen?.remoteClaudeConfigDir).toBe("/home/b/.claude-work");
  });
});
