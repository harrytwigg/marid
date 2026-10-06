import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * A session on a named Claude profile must run, on every local launch path the
 * interactive engine owns, with that profile's CLAUDE_CONFIG_DIR, the operator
 * settings it cannot read for itself, and its own folder trust. A session on
 * the default profile must see none of it.
 */

const spawns: Array<{ bin: string; args: string[]; options: { env: Record<string, string>; cwd: string } }> = [];
vi.mock("node-pty", () => ({
  spawn: vi.fn((bin: string, args: string[], options: { env: Record<string, string>; cwd: string }) => {
    spawns.push({ bin, args, options });
    return { pid: 7000 + spawns.length, _exitCode: null, onData() {}, onExit() {}, kill() {}, write() {}, resize() {}, on() {} };
  }),
}));
vi.mock("../sse-pty-proxy.js", () => ({
  MAIN_AGENT_SENTINEL: "<!-- jinn-main-agent:5c1f -->",
  SsePtyProxy: class {
    port = 0;
    constructor(_label: string, _onEvent: (e: unknown) => void) {}
    async start() { return 41300; }
    stop() {}
  },
}));

const resets = vi.hoisted(() => ({ calls: 0, sources: [] as unknown[] }));
vi.mock("../../shared/engine-reset-times.js", () => ({
  // The gateway's own account's 5h reset, four hours out: never a named profile's.
  claudeResetsAtSeconds: async (_now: number, source?: unknown) => { resets.calls++; resets.sources.push(source); return Math.floor(Date.now() / 1000) + 4 * 3600; },
}));

import { InteractiveClaudeEngine, rateLimitFromStopFailure } from "../claude-interactive.js";
import { PtyLifecycleManager } from "../pty-lifecycle.js";
import { resetClaudeProfileTrustForTests } from "../claude-profile-launch.js";
import { claudeProfileFromDir, type ClaudeProfile } from "../../shared/claude-profile.js";
import { cleanupSessionSettings } from "../../shared/claude-settings.js";
import { CLAUDE_SETTINGS_DIR } from "../../shared/paths.js";

const flush = () => new Promise((r) => setTimeout(r, 30));
const SID = "profile-sess";

let tmp: string;
let cwd: string;
let profile: Exclude<ClaudeProfile, null>;
let lifecycle: PtyLifecycleManager;
let engine: InteractiveClaudeEngine;

function settingsOf(spawn: (typeof spawns)[number]): Record<string, unknown> {
  return JSON.parse(fs.readFileSync(spawn.args[spawn.args.indexOf("--settings") + 1]!, "utf-8"));
}

function expectOnProfile(spawn: (typeof spawns)[number]): void {
  expect(spawn.options.env.CLAUDE_CONFIG_DIR).toBe(profile.dir);
  expect(spawn.options.env).not.toHaveProperty("CLAUDE_SECURESTORAGE_CONFIG_DIR");
  expect(settingsOf(spawn)).toMatchObject({ attribution: { commit: "" }, skipDangerousModePermissionPrompt: true });
  const trust = JSON.parse(fs.readFileSync(path.join(profile.dir, ".claude.json"), "utf-8"));
  expect(trust.projects[cwd].hasTrustDialogAccepted).toBe(true);
}

beforeEach(() => {
  spawns.length = 0;
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "claude-interactive-profile-")));
  cwd = path.join(tmp, "work");
  fs.mkdirSync(cwd);
  const defaultDir = path.join(tmp, "default-claude");
  fs.mkdirSync(defaultDir);
  fs.writeFileSync(path.join(defaultDir, "settings.json"), JSON.stringify({
    attribution: { commit: "", pr: "", sessionUrl: false },
    skipDangerousModePermissionPrompt: true,
  }));
  vi.stubEnv("CLAUDE_CONFIG_DIR", defaultDir);
  vi.stubEnv("CLAUDE_SECURESTORAGE_CONFIG_DIR", path.join(tmp, "inherited"));
  profile = claudeProfileFromDir(path.join(tmp, "friend"));
  // The operator creates a profile; the gateway never does.
  fs.mkdirSync(profile.dir);
  resetClaudeProfileTrustForTests();
  lifecycle = new PtyLifecycleManager({ maxLivePtys: 10 });
  engine = new InteractiveClaudeEngine(lifecycle, { register: () => {}, unregister: () => {} } as any);
});

afterEach(() => {
  lifecycle.killAll();
  cleanupSessionSettings(CLAUDE_SETTINGS_DIR, SID);
  vi.unstubAllEnvs();
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe("InteractiveClaudeEngine on a named Claude profile (FR-051, FR-052, FR-052a)", () => {
  it("the turn spawn runs on the profile", async () => {
    void engine.run({ sessionId: SID, prompt: "hi", cwd, claudeProfile: profile } as any).catch(() => {});
    await flush();
    expect(spawns).toHaveLength(1);
    expectOnProfile(spawns[0]!);
  });

  it("the idle PTY spawn runs on the profile", async () => {
    engine.ensureIdleSpawn(SID, { cwd, claudeProfile: profile });
    await flush();
    expect(spawns).toHaveLength(1);
    expectOnProfile(spawns[0]!);
  });

  it("the redelivery respawn runs on the profile", async () => {
    const resolver = { isSettled: false, promptSubmittedAt: undefined, sessionId: undefined, newProcess() {}, interrupt() {} };
    const entry = { resolver } as any;
    const opts = { sessionId: SID, prompt: "hi", cwd, claudeProfile: profile } as any;
    await (engine as any).redeliverByRespawn(SID, entry, opts, Date.now(), () => {});
    expect(spawns).toHaveLength(1);
    expectOnProfile(spawns[0]!);
  });

  it("the turn spawn launches nothing for a profile directory that does not exist", async () => {
    fs.rmSync(profile.dir, { recursive: true });
    void engine.run({ sessionId: SID, prompt: "hi", cwd, claudeProfile: profile } as any).catch(() => {});
    await flush();
    expect(spawns).toHaveLength(0);
    expect(fs.existsSync(profile.dir)).toBe(false);
  });

  it("the idle PTY spawn (terminal view, no preflight) launches nothing for a profile directory that does not exist", async () => {
    fs.rmSync(profile.dir, { recursive: true });
    engine.ensureIdleSpawn(SID, { cwd, claudeProfile: profile });
    await flush();
    expect(spawns).toHaveLength(0);
    expect(fs.existsSync(profile.dir)).toBe(false);
  });

  it("a default-profile turn keeps the gateway's environment and carries no operator keys", async () => {
    void engine.run({ sessionId: SID, prompt: "hi", cwd } as any).catch(() => {});
    await flush();
    expect(spawns).toHaveLength(1);
    expect(spawns[0]!.options.env.CLAUDE_CONFIG_DIR).toBe(path.join(tmp, "default-claude"));
    expect(spawns[0]!.options.env.CLAUDE_SECURESTORAGE_CONFIG_DIR).toBe(path.join(tmp, "inherited"));
    const settings = settingsOf(spawns[0]!);
    expect(settings).not.toHaveProperty("attribution");
    expect(settings).not.toHaveProperty("skipDangerousModePermissionPrompt");
    expect(fs.existsSync(path.join(profile.dir, ".claude.json"))).toBe(false);
  });
});

describe("attaching the terminal to a warm PTY on another profile", () => {
  it("drops it and spawns on the profile asked for, and reuses one already on it", async () => {
    engine.ensureIdleSpawn(SID, { cwd, claudeProfile: profile });
    await flush();
    // The override has ended: the session's own (default) profile is asked for.
    engine.ensureIdleSpawn(SID, { cwd, claudeProfile: null });
    await flush();
    expect(spawns).toHaveLength(2);
    expect(spawns[1]!.options.env.CLAUDE_CONFIG_DIR).toBe(path.join(tmp, "default-claude"));
    engine.ensureIdleSpawn(SID, { cwd, claudeProfile: null });
    await flush();
    expect(spawns).toHaveLength(2);
  });
});

describe("a named profile's rate limit (FR-071)", () => {
  const stopFailure = { hook_event_name: "StopFailure", error: "rate_limit" } as any;

  it("asks the usage source of the profile that hit the limit, so it waits on its own reset", async () => {
    resets.calls = 0;
    resets.sources = [];
    const rl = await rateLimitFromStopFailure(stopFailure, { profile });
    expect(rl?.resetsAt).toBeGreaterThan(Date.now() / 1000);
    expect(resets.sources).toEqual([{ profile }]);
  });

  it("still asks the default account's usage source on the default profile", async () => {
    resets.calls = 0;
    resets.sources = [];
    const rl = await rateLimitFromStopFailure(stopFailure);
    expect(rl?.resetsAt).toBeGreaterThan(Date.now() / 1000);
    expect(resets.calls).toBe(1);
    expect(resets.sources).toEqual([undefined]);
  });
});
