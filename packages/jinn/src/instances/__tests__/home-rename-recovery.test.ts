import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// A build whose one codename constant says "acme": every name derived from it follows.
vi.mock("../../shared/codename-constant.js", () => ({ CODENAME: "acme" }));

import { claudeProjectSlug } from "../../shared/claude-project-slug.js";
import { saveInstances } from "../directory.js";
import { renameHomeIfNeeded, type HomeRenameDeps } from "../home-rename.js";
import { HOME_MOVE_PENDING, writePendingMove } from "../home-pending.js";
import { settleInstanceEnv } from "../canonical-env.js";
import { settleBeforeRestart } from "../../gateway/restart-settle.js";
import { departmentStageRoot } from "../../gateway/department-workdirs.js";

/** Moves that die half way, race a gateway, or fail a step, and a home that has to stay put. A real-shaped host: an older build's home with a sessions database, an attachment, a department stage
 *  directory beside it, Claude conversations filed under both working directories, a registry entry and
 *  a snapshot directory. Nothing outside the scratch root is touched. */
let root: string;
let claudeDir: string;
let registryPath: string;
let deps: HomeRenameDeps;
const backups: Array<{ name: string; home: string }> = [];

const legacyHome = (name = "jinn-john") => path.join(root, `.${name}`);
const currentHome = (name = "acme-john") => path.join(root, `.${name}`);
const projectDir = (cwd: string) => path.join(claudeDir, "projects", claudeProjectSlug(cwd));

function seedHome(home: string): void {
  fs.mkdirSync(path.join(home, "sessions"), { recursive: true });
  const db = new Database(path.join(home, "sessions", "registry.db"));
  db.exec("create table sessions (id text primary key, title text); insert into sessions values ('s1', 'a real session')");
  db.close();
  fs.mkdirSync(path.join(home, "attachments"), { recursive: true });
  fs.writeFileSync(path.join(home, "attachments", "note.txt"), "attached");
  fs.writeFileSync(path.join(home, "config.yaml"), 'jinn:\n  version: "0.33.3"\ngateway:\n  port: 8099\n');
  fs.mkdirSync(path.join(home, "org"), { recursive: true });
  fs.writeFileSync(path.join(home, "gateway.json"), JSON.stringify({ port: 8099, secret: "s", pid: 999999, home: fs.realpathSync(home) }));
}

function seedStage(instance: string): { stageDir: string } {
  const stageDir = path.join(root, ".jinn-departments", ".instances", instance, "ops");
  fs.mkdirSync(stageDir, { recursive: true });
  fs.writeFileSync(path.join(stageDir, "CLAUDE.md"), "stage");
  return { stageDir };
}

function seedConversation(cwd: string, id: string): string {
  const file = path.join(projectDir(fs.realpathSync(cwd)), `${id}.jsonl`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, '{"type":"user"}\n');
  return file;
}

beforeEach(() => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "home-rename-")));
  claudeDir = path.join(root, "claude");
  registryPath = path.join(root, "registry", "instances.json");
  backups.length = 0;
  deps = {
    homeDir: root,
    claudeConfigDirs: () => [claudeDir],
    registry: { registryPath, legacyRegistryPath: path.join(root, "none.json"), previousRegistryPath: null },
    gatewayRunning: () => false,
    backup: async (name, home) => { backups.push({ name, home }); return path.join(root, "Backups", `${name}-snapshot`); },
    lockTimeoutMs: 2_000,
  };
  saveInstances([{ id: "i1", name: "jinn-john", port: 8099, home: legacyHome(), createdAt: "2026-01-01T00:00:00.000Z" }], { registryPath });
});
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));


describe("a move that does not go cleanly", () => {
  it("finishes the department conversations of a move that died between the stage-root rename and their move", async () => {
    seedHome(legacyHome());
    const { stageDir } = seedStage(".jinn-john");
    const stageConversation = seedConversation(stageDir, "stage-session");
    writePendingMove(legacyHome(), { legacy: legacyHome(), current: currentHome(), instance: "jinn-john", physicalLegacy: legacyHome(), configDirs: [claudeDir], at: "2026-10-01T00:00:00.000Z" });
    fs.renameSync(legacyHome(), currentHome());
    const newRoot = path.join(root, ".acme-departments", ".instances", ".acme-john");
    fs.mkdirSync(path.dirname(newRoot), { recursive: true });
    fs.renameSync(path.join(root, ".jinn-departments", ".instances", ".jinn-john"), newRoot);
    expect(fs.existsSync(stageConversation)).toBe(true);

    await renameHomeIfNeeded(legacyHome(), deps);

    expect(fs.existsSync(stageConversation)).toBe(false);
    expect(fs.existsSync(path.join(projectDir(path.join(newRoot, "ops")), "stage-session.jsonl"))).toBe(true);
    expect(fs.existsSync(path.join(currentHome(), HOME_MOVE_PENDING))).toBe(false);
  });

  it("does not move a home a gateway started at while the snapshot ran, and tells a waiting process not to start one", async () => {
    seedHome(legacyHome());
    let running = false;
    let releaseBackup!: () => void;
    const backupGate = new Promise<void>((resolve) => { releaseBackup = resolve; });
    const slow: HomeRenameDeps = { ...deps, gatewayRunning: () => running, backup: async () => { await backupGate; return undefined; } };
    const first = renameHomeIfNeeded(legacyHome(), slow);
    await new Promise((resolve) => setTimeout(resolve, 50));
    const second = await renameHomeIfNeeded(legacyHome(), { ...slow, lockTimeoutMs: 300 });
    expect(second).toMatchObject({ kind: "kept", blocking: true });
    running = true;
    releaseBackup();
    expect(await first).toMatchObject({ kind: "kept", home: legacyHome(), reason: expect.stringContaining("started") });
    expect(fs.lstatSync(legacyHome()).isDirectory()).toBe(true);
    expect(fs.existsSync(currentHome())).toBe(false);
  });

  it.skipIf(process.getuid?.() === 0)("keeps the note when a follow-up step fails, so the next run retries it", async () => {
    seedHome(legacyHome());
    const conversation = seedConversation(legacyHome(), "home-session");
    fs.chmodSync(path.join(claudeDir, "projects"), 0o555);
    try {
      await renameHomeIfNeeded(legacyHome(), deps);
      expect(fs.existsSync(path.join(currentHome(), HOME_MOVE_PENDING))).toBe(true);
    } finally {
      fs.chmodSync(path.join(claudeDir, "projects"), 0o755);
    }
    expect(await renameHomeIfNeeded(legacyHome(), deps)).toMatchObject({ kind: "moved", home: currentHome() });
    expect(fs.existsSync(conversation)).toBe(false);
    expect(fs.existsSync(path.join(projectDir(currentHome()), "home-session.jsonl"))).toBe(true);
    expect(fs.existsSync(path.join(currentHome(), HOME_MOVE_PENDING))).toBe(false);
  });
});

describe("a home that has to stay at its old path", () => {
  it("keeps its department conversations where the later move looks for them", async () => {
    seedHome(legacyHome());
    const env: NodeJS.ProcessEnv = { JINN_HOME: legacyHome() };
    const kept = await settleInstanceEnv(env, { ...deps, gatewayRunning: () => true });
    expect(kept.kind).toBe("kept");
    const saved = { ...process.env };
    Object.assign(process.env, env);
    let keptRoot: string;
    try { keptRoot = departmentStageRoot(); } finally { process.env = saved; }
    expect(path.relative(root, keptRoot)).toBe(path.join(".jinn-departments", ".instances", ".jinn-john"));
    fs.mkdirSync(path.join(keptRoot, "ops"), { recursive: true });
    const during = seedConversation(path.join(keptRoot, "ops"), "during-kept");

    expect(await renameHomeIfNeeded(legacyHome(), deps)).toMatchObject({ kind: "moved" });

    const newStage = path.join(root, ".acme-departments", ".instances", ".acme-john", "ops");
    expect(fs.existsSync(during)).toBe(false);
    expect(fs.existsSync(path.join(projectDir(newStage), "during-kept.jsonl"))).toBe(true);
    expect(fs.existsSync(keptRoot)).toBe(false);
  });
});

describe("a restart over a gateway that was running at an older build's home", () => {
  it("moves the home once that gateway is down and sends the helper on from the new location", async () => {
    seedHome(legacyHome());
    seedConversation(legacyHome(), "home-session");
    const env: NodeJS.ProcessEnv = { JINN_HOME: legacyHome(), JINN_HOME_IDENTITY: "stale", ACME_HOME_IDENTITY: "stale", JINN_BINDING_HOME: "stale" };
    // The command that asked for the restart found a gateway running, so it left the home where it was.
    expect((await settleInstanceEnv({ ...env }, { ...deps, gatewayRunning: () => true })).kind).toBe("kept");

    const settled = await settleBeforeRestart(env, legacyHome(), deps);

    expect(settled.respawn).toBe(true);
    expect(env.ACME_HOME).toBe(currentHome());
    expect(env.JINN_HOME).toBe(currentHome());
    expect(env.JINN_HOME_IDENTITY).toBeUndefined();
    expect(env.ACME_HOME_IDENTITY).toBeUndefined();
    expect(env.JINN_BINDING_HOME).toBeUndefined();
    expect(fs.existsSync(path.join(projectDir(currentHome()), "home-session.jsonl"))).toBe(true);
    // The helper that starts over has loaded the settled home: nothing more to do.
    expect((await settleBeforeRestart(env, currentHome(), deps)).respawn).toBe(false);
  });

  it("carries on at the loaded home, and starts nothing elsewhere, when both homes exist", async () => {
    seedHome(currentHome());
    seedHome(legacyHome());
    const env: NodeJS.ProcessEnv = { ACME_HOME: currentHome(), JINN_HOME: currentHome() };
    const logged: string[] = [];
    expect((await settleBeforeRestart(env, currentHome(), { ...deps, log: (message) => logged.push(message) })).respawn).toBe(false);
    expect(env).toEqual({ ACME_HOME: currentHome(), JINN_HOME: currentHome() });
    expect(logged.join(" ")).toContain("carrying on at");
  });

  it("carries on at the loaded home when another process is mid-move", async () => {
    seedHome(legacyHome());
    fs.writeFileSync(path.join(root, ".acme-home-move.lock"), String(process.pid));
    const env: NodeJS.ProcessEnv = { JINN_HOME: legacyHome() };
    expect((await settleBeforeRestart(env, legacyHome(), { ...deps, lockTimeoutMs: 100 })).respawn).toBe(false);
    expect(env).toEqual({ JINN_HOME: legacyHome() });
    expect(fs.lstatSync(legacyHome()).isDirectory()).toBe(true);
  });

  it("carries on in place when the home had to stay", async () => {
    seedHome(legacyHome());
    const env: NodeJS.ProcessEnv = { JINN_HOME: legacyHome() };
    expect((await settleBeforeRestart(env, legacyHome(), { ...deps, gatewayRunning: () => true })).respawn).toBe(false);
  });
});
