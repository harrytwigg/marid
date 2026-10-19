import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// A build whose one codename constant says "acme": every name derived from it follows.
vi.mock("../../shared/codename-constant.js", () => ({ CODENAME: "acme" }));

import { claudeProjectSlug } from "../../shared/claude-project-slug.js";
import { findTranscriptForSession } from "../../engines/claude-transcript-path.js";
import { loadInstances, saveInstances } from "../directory.js";
import { HOME_MOVE_RECEIPT, readHomeMoveReceipt, renameHomeIfNeeded, type HomeRenameDeps } from "../home-rename.js";
import { inspectHome } from "../home-state.js";
import { HOME_MOVE_PENDING, writePendingMove } from "../home-pending.js";
import { settleInstanceEnv } from "../canonical-env.js";

/** A real-shaped host: an older build's home with a sessions database, an attachment, a department stage
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

describe("moving an older build's home", () => {
  it("moves a real-shaped home, leaves a link, and carries every conversation, the stage root, the registry and the snapshots with it", async () => {
    seedHome(legacyHome());
    const { stageDir } = seedStage(".jinn-john");
    const homeConversation = seedConversation(legacyHome(), "home-session");
    const stageConversation = seedConversation(stageDir, "stage-session");
    fs.mkdirSync(path.join(root, "Backups", "jinn-homes", "jinn-john", "2026-10-01"), { recursive: true });

    const outcome = await renameHomeIfNeeded(legacyHome(), deps);

    expect(outcome).toMatchObject({ kind: "moved", home: currentHome() });
    expect(backups).toEqual([{ name: "jinn-john", home: legacyHome() }]);
    // The home is the same directory under its new name; the old path is a link to it.
    expect(fs.lstatSync(legacyHome()).isSymbolicLink()).toBe(true);
    expect(fs.realpathSync(legacyHome())).toBe(currentHome());
    const db = new Database(path.join(currentHome(), "sessions", "registry.db"), { readonly: true });
    expect(db.prepare("select title from sessions where id = 's1'").get()).toEqual({ title: "a real session" });
    db.close();
    expect(fs.readFileSync(path.join(currentHome(), "attachments", "note.txt"), "utf-8")).toBe("attached");
    expect(JSON.parse(fs.readFileSync(path.join(currentHome(), "gateway.json"), "utf-8")).home).toBe(currentHome());
    // Conversations are filed by the physical working directory: both project keys moved.
    const newStage = path.join(root, ".acme-departments", ".instances", ".acme-john", "ops");
    expect(fs.existsSync(homeConversation)).toBe(false);
    expect(fs.existsSync(path.join(projectDir(currentHome()), "home-session.jsonl"))).toBe(true);
    expect(fs.existsSync(stageConversation)).toBe(false);
    expect(fs.existsSync(path.join(projectDir(newStage), "stage-session.jsonl"))).toBe(true);
    expect(fs.readFileSync(path.join(newStage, "CLAUDE.md"), "utf-8")).toBe("stage");
    expect(fs.existsSync(path.join(root, ".jinn-departments"))).toBe(false);
    // The registry says the new name and path, once.
    expect(loadInstances(deps.registry)).toEqual([expect.objectContaining({ id: "i1", name: "acme-john", home: currentHome(), port: 8099 })]);
    // Snapshots follow under the new root and name.
    expect(fs.existsSync(path.join(root, "Backups", "acme-homes", "acme-john", "2026-10-01"))).toBe(true);
    expect(fs.existsSync(path.join(root, "Backups", "jinn-homes"))).toBe(false);
    // And it says so afterwards.
    expect(readHomeMoveReceipt(currentHome())).toMatchObject({ from: legacyHome(), to: currentHome(), transcripts: 2, backup: path.join(root, "Backups", "acme-homes", "acme-john", "jinn-john-snapshot") });
    expect(fs.existsSync(path.join(currentHome(), HOME_MOVE_RECEIPT))).toBe(true);
  });

  it("lets a session be resumed from where the new home says its conversation is", async () => {
    seedHome(legacyHome());
    seedConversation(legacyHome(), "resume-me");
    await renameHomeIfNeeded(legacyHome(), deps);
    expect(findTranscriptForSession("resume-me", currentHome(), path.join(claudeDir, "projects"))).toBe(path.join(projectDir(currentHome()), "resume-me.jsonl"));
  });

  it("is idempotent, and names one identity whichever spelling it is asked for", async () => {
    seedHome(legacyHome());
    seedConversation(legacyHome(), "once");
    await renameHomeIfNeeded(legacyHome(), deps);
    const again = [await renameHomeIfNeeded(legacyHome(), deps), await renameHomeIfNeeded(currentHome(), deps)];
    for (const outcome of again) expect(outcome).toEqual({ kind: "nothing", home: currentHome() });
    expect(backups).toHaveLength(1);
    expect(fs.readdirSync(path.join(claudeDir, "projects"))).toHaveLength(1);
    expect(loadInstances(deps.registry)).toHaveLength(1);
    expect(inspectHome(legacyHome()).state).toBe("moved");
  });

  it("finishes a move whose process died right after the rename", async () => {
    seedHome(legacyHome());
    const { stageDir } = seedStage(".jinn-john");
    const homeConversation = seedConversation(legacyHome(), "home-session");
    const stageConversation = seedConversation(stageDir, "stage-session");
    // What a kill between the rename and the follow-up steps leaves: the note, the moved home, no link, nothing else.
    writePendingMove(legacyHome(), { legacy: legacyHome(), current: currentHome(), instance: "jinn-john", physicalLegacy: legacyHome(), configDirs: [claudeDir], at: "2026-10-01T00:00:00.000Z" });
    fs.renameSync(legacyHome(), currentHome());
    expect(fs.existsSync(legacyHome())).toBe(false);

    expect(await renameHomeIfNeeded(legacyHome(), deps)).toMatchObject({ kind: "moved", home: currentHome() });

    expect(fs.lstatSync(legacyHome()).isSymbolicLink()).toBe(true);
    expect(fs.existsSync(path.join(currentHome(), HOME_MOVE_PENDING))).toBe(false);
    expect(fs.existsSync(homeConversation)).toBe(false);
    expect(fs.existsSync(path.join(projectDir(currentHome()), "home-session.jsonl"))).toBe(true);
    expect(fs.existsSync(stageConversation)).toBe(false);
    expect(loadInstances(deps.registry)).toEqual([expect.objectContaining({ name: "acme-john", home: currentHome() })]);
    expect(readHomeMoveReceipt(currentHome())).toMatchObject({ from: legacyHome(), to: currentHome() });
    expect(await renameHomeIfNeeded(legacyHome(), deps)).toEqual({ kind: "nothing", home: currentHome() });
  });

  it("leaves no note behind after a complete move", async () => {
    seedHome(legacyHome());
    await renameHomeIfNeeded(legacyHome(), deps);
    expect(fs.existsSync(path.join(currentHome(), HOME_MOVE_PENDING))).toBe(false);
  });

  it("merges a home moved from two processes at once into one move", async () => {
    seedHome(legacyHome());
    const outcomes = await Promise.all([renameHomeIfNeeded(legacyHome(), deps), renameHomeIfNeeded(legacyHome(), deps)]);
    expect(outcomes.map((outcome) => outcome.kind).sort()).toEqual(["moved", "nothing"]);
    expect(backups).toHaveLength(1);
    expect(outcomes.every((outcome) => outcome.home === currentHome())).toBe(true);
  });

  it("moves the default home, whose name is the codename alone", async () => {
    seedHome(legacyHome("jinn"));
    saveInstances([{ id: "d", name: "jinn", port: 7000, home: legacyHome("jinn"), createdAt: "2026-01-01T00:00:00.000Z" }], { registryPath });
    expect(await renameHomeIfNeeded(legacyHome("jinn"), deps)).toMatchObject({ kind: "moved", home: currentHome("acme") });
    expect(loadInstances(deps.registry)).toEqual([expect.objectContaining({ name: "acme", home: currentHome("acme") })]);
  });
});

describe("leaving a home where it is", () => {
  it("does not move a home a gateway is running at", async () => {
    seedHome(legacyHome());
    const outcome = await renameHomeIfNeeded(legacyHome(), { ...deps, gatewayRunning: () => true });
    expect(outcome).toMatchObject({ kind: "kept", home: legacyHome(), reason: expect.stringContaining("is running") });
    expect(fs.lstatSync(legacyHome()).isDirectory()).toBe(true);
    expect(backups).toHaveLength(0);
  });

  it("does not move a home it could not take a snapshot of", async () => {
    seedHome(legacyHome());
    const outcome = await renameHomeIfNeeded(legacyHome(), { ...deps, backup: async () => { throw new Error("disk full"); } });
    expect(outcome).toMatchObject({ kind: "kept", home: legacyHome(), reason: expect.stringContaining("disk full") });
    expect(fs.lstatSync(legacyHome()).isDirectory()).toBe(true);
    expect(fs.existsSync(currentHome())).toBe(false);
  });

  it("never moves a mount point, such as a container's volume", async () => {
    seedHome(legacyHome("jinn"));
    const outcome = await renameHomeIfNeeded(legacyHome("jinn"), { ...deps, isMountPoint: () => true });
    expect(outcome).toMatchObject({ kind: "kept", home: legacyHome("jinn"), reason: expect.stringContaining("mount point") });
  });

  it("refuses to choose between two homes that both exist", async () => {
    seedHome(legacyHome());
    seedHome(currentHome());
    const outcome = await renameHomeIfNeeded(legacyHome(), deps);
    expect(outcome).toMatchObject({ kind: "conflict", legacyHome: legacyHome(), currentHome: currentHome() });
    expect(fs.lstatSync(legacyHome()).isDirectory()).toBe(true);
    expect(inspectHome(legacyHome()).state).toBe("conflict");
  });

  it("leaves a home whose path never carried the codename", async () => {
    const custom = path.join(root, "company-home");
    seedHome(custom);
    expect(await renameHomeIfNeeded(custom, deps)).toEqual({ kind: "nothing", home: custom });
    expect(inspectHome(custom).state).toBe("not-named-for-codename");
  });

  it("starts a fresh instance where this build would create one", async () => {
    expect(await renameHomeIfNeeded(legacyHome("jinn-new"), deps)).toEqual({ kind: "nothing", home: currentHome("acme-new") });
    expect(inspectHome(legacyHome("jinn-new")).state).toBe("absent");
  });
});

describe("settling the environment", () => {
  it("rewrites an old home and instance name to the moved home, under every spelling", async () => {
    seedHome(legacyHome());
    const env: NodeJS.ProcessEnv = { JINN_HOME: legacyHome(), JINN_INSTANCE: "jinn-john" };
    const outcome = await settleInstanceEnv(env, deps);
    expect(outcome.kind).toBe("moved");
    expect(env).toMatchObject({ ACME_HOME: currentHome(), JINN_HOME: currentHome(), ACME_INSTANCE: "acme-john", JINN_INSTANCE: "acme-john" });
  });

  it("reads an old home reached through the link a move left as the one directory it is", async () => {
    seedHome(legacyHome());
    await renameHomeIfNeeded(legacyHome(), deps);
    const env: NodeJS.ProcessEnv = { JINN_HOME: legacyHome() };
    expect((await settleInstanceEnv(env, deps)).kind).toBe("nothing");
    expect(env.ACME_HOME).toBe(currentHome());
  });

  it("points the environment at the old path when the home had to stay there", async () => {
    seedHome(legacyHome());
    const env: NodeJS.ProcessEnv = { JINN_INSTANCE: "jinn-john" };
    const home = vi.spyOn(os, "homedir").mockReturnValue(root);
    try {
      const outcome = await settleInstanceEnv(env, { ...deps, gatewayRunning: () => true });
      expect(outcome.kind).toBe("kept");
      expect(env.ACME_HOME).toBe(legacyHome());
      expect(env.ACME_INSTANCE).toBe("acme-john");
    } finally {
      home.mockRestore();
    }
  });
});
