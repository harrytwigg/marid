import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The session-side launch paths of a named Claude profile (FR-051, FR-058,
 * FR-059). The interactive engine's own spawns are covered beside it
 * (engines/__tests__/claude-interactive-profile.test.ts); these cover what the
 * gateway hands the engine, and fork, which spawns claude itself.
 */

const forkSpawn = vi.hoisted(() => ({
  execEnv: undefined as Record<string, string> | undefined,
  ptyEnv: undefined as Record<string, string> | undefined,
  onPtySpawn: undefined as (() => void) | undefined,
}));

vi.mock("node:child_process", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:child_process")>()),
  execFileSync: vi.fn((_bin: string, _args: string[], options: { env: Record<string, string> }) => {
    forkSpawn.execEnv = options.env;
    return JSON.stringify({ session_id: "forked-1" });
  }),
}));
vi.mock("node-pty", () => ({
  spawn: vi.fn((_bin: string, _args: string[], options: { env: Record<string, string> }) => {
    forkSpawn.ptyEnv = options.env;
    forkSpawn.onPtySpawn?.();
    return { pid: 1, onData() {}, onExit() {}, kill() {}, write() {}, resize() {} };
  }),
}));

import { runEngineAttempt } from "../turn/engine-run.js";
import { forkEngineSession, claudeProjectDir } from "../fork.js";
import { scanOrg } from "../../gateway/org.js";
import { claudeProfileFromDir, resolveEmployeeClaudeProfile } from "../../shared/claude-profile.js";
import { JINN_HOME } from "../../shared/paths.js";
import type { EngineRunOpts, Employee, EngineResult } from "../../shared/types.js";

const FRIEND = "/Users/operator/.claude-friend";

function attempt(employee: Partial<Employee> | undefined): Promise<EngineRunOpts> {
  let seen: EngineRunOpts | undefined;
  const engine = { run: vi.fn(async (opts: EngineRunOpts) => { seen = opts; return { sessionId: "n1", result: "ok" } as EngineResult; }) };
  return runEngineAttempt({
    input: { session: { id: "s1" }, attachments: [], employee, attemptToken: "t1", config: {} } as any,
    plan: {
      engine, engineConfig: {}, promptToRun: "hi", runtimeSource: "web",
      prepareContext: () => ({ systemPrompt: "sys", fingerprint: "f", refresh: undefined }),
    } as any,
    surface: {} as any,
    heartbeat: { beat() {} } as any,
    partialStream: { finish() {}, persist() {} } as any,
    turnStartedAt: Date.now(),
    model: undefined,
  }).then(() => seen!);
}

describe("an ordinary turn (and auto-compaction, which runs through the same attempt)", () => {
  it("hands the engine the employee's named profile", async () => {
    // Red on main: the field did not exist, and the session ran on the gateway's profile.
    const opts = await attempt({ name: "side-dev", claudeConfigDir: `${FRIEND}/` });
    expect(opts.claudeProfile).toEqual(claudeProfileFromDir(FRIEND));
  });

  it("hands the engine no profile for an employee without one", async () => {
    expect((await attempt({ name: "dev" })).claudeProfile).toBeNull();
    expect((await attempt(undefined)).claudeProfile).toBeNull();
  });

  it("passes a remote employee's remoteClaudeConfigDir (FR-058)", async () => {
    // Red on main: engine-run passed host, user and cwd but dropped the profile,
    // so ordinary remote turns ran on the instance-wide default.
    const opts = await attempt({ name: "far", remoteHost: "build-box", remoteCwd: "/srv/w", remoteClaudeConfigDir: "/home/b/.claude-work" });
    expect(opts.remoteClaudeConfigDir).toBe("/home/b/.claude-work");
    expect(opts.claudeProfile).toBeNull();
  });
});

describe("profiles are independent of department scope (FR-059)", () => {
  const orgDir = path.join(JINN_HOME, "org");
  afterEach(() => fs.rmSync(orgDir, { recursive: true, force: true }));

  it("an employee in a scoped department and one in an open department both run on their profile", () => {
    const write = (rel: string, body: string) => {
      fs.mkdirSync(path.dirname(path.join(orgDir, rel)), { recursive: true });
      fs.writeFileSync(path.join(orgDir, rel), body);
    };
    write("side-project/department.yaml", "name: side-project\nscope: scoped\n");
    write("side-project/side-dev.yaml", `name: side-dev\npersona: p\nclaudeConfigDir: ${FRIEND}\n`);
    write("engineering/eng-dev.yaml", `name: eng-dev\npersona: p\nclaudeConfigDir: ${FRIEND}/\n`);
    const roster = scanOrg();
    expect(roster.get("side-dev")?.claudeConfigDir).toBe(FRIEND);
    expect(roster.get("eng-dev")?.claudeConfigDir).toBe(FRIEND);
    expect(resolveEmployeeClaudeProfile(roster.get("side-dev"))).toEqual(claudeProfileFromDir(FRIEND));
    expect(resolveEmployeeClaudeProfile(roster.get("eng-dev"))).toEqual(claudeProfileFromDir(FRIEND));
  });

  it("the org scan skips an employee whose profile is refused, and keeps the rest", () => {
    fs.mkdirSync(path.join(orgDir, "eng"), { recursive: true });
    fs.writeFileSync(path.join(orgDir, "eng", "bad.yaml"), "name: bad\npersona: p\nclaudeConfigDir: ~/.claude-friend\n");
    fs.writeFileSync(path.join(orgDir, "eng", "good.yaml"), "name: good\npersona: p\n");
    const roster = scanOrg();
    expect(roster.has("bad")).toBe(false);
    expect(roster.has("good")).toBe(true);
  });
});

describe("fork runs on the source session's profile (FR-051)", () => {
  let profileDir: string;
  beforeEach(() => {
    profileDir = path.join(JINN_HOME, "..", `claude-friend-${process.pid}`);
    fs.mkdirSync(profileDir, { recursive: true });
    vi.stubEnv("CLAUDE_SECURESTORAGE_CONFIG_DIR", "/inherited");
    forkSpawn.execEnv = undefined;
    forkSpawn.ptyEnv = undefined;
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    fs.rmSync(profileDir, { recursive: true, force: true });
  });

  it("the headless fork", async () => {
    const profile = claudeProfileFromDir(profileDir);
    await expect(forkEngineSession("claude", "src-1", "/work", { claudeProfile: profile })).resolves.toEqual({ engineSessionId: "forked-1" });
    expect(forkSpawn.execEnv?.CLAUDE_CONFIG_DIR).toBe(profile.dir);
    expect(forkSpawn.execEnv).not.toHaveProperty("CLAUDE_SECURESTORAGE_CONFIG_DIR");
  });

  it("the interactive fork, which also finds the new transcript under the profile", async () => {
    const profile = claudeProfileFromDir(profileDir);
    const projectDir = claudeProjectDir("/work", profile);
    expect(projectDir).toBe(path.join(profile.dir, "projects", "-work"));
    forkSpawn.onPtySpawn = () => {
      fs.mkdirSync(projectDir, { recursive: true });
      fs.writeFileSync(path.join(projectDir, "forked-2.jsonl"), "{}\n");
    };
    const interactive = { sourceJinnSessionId: "s1", engine: { kill() {} } as any };
    await expect(forkEngineSession("claude", "src-1", "/work", { interactive, claudeProfile: profile }))
      .resolves.toEqual({ engineSessionId: "forked-2" });
    expect(forkSpawn.ptyEnv?.CLAUDE_CONFIG_DIR).toBe(profile.dir);
    expect(forkSpawn.ptyEnv).not.toHaveProperty("CLAUDE_SECURESTORAGE_CONFIG_DIR");
  });

  it("a default-profile fork keeps the gateway's environment", async () => {
    await forkEngineSession("claude", "src-1", "/work");
    expect(forkSpawn.execEnv?.CLAUDE_SECURESTORAGE_CONFIG_DIR).toBe("/inherited");
    expect(forkSpawn.execEnv?.CLAUDE_CONFIG_DIR).toBe(process.env.CLAUDE_CONFIG_DIR);
  });
});
