import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// A build whose one codename constant says "acme": every name derived from it follows.
vi.mock("../../shared/codename-constant.js", () => ({ CODENAME: "acme" }));

import { STAGE_RENAME_SCRIPT } from "../remote-stage-rename.js";
import { LEGACY_REMOTE_DEPARTMENTS_DIR, REMOTE_DEPARTMENTS_DIR, remoteDepartmentsRoots, scopedRemoteTargetProblem } from "../../shared/remote-department.js";
import { LEGACY_REMOTE_STAGE_MARKER, REMOTE_STAGE_MARKER, isLinkedInFarm } from "../../shared/remote-farm.js";
import { LEGACY_REMOTE_STAGE_DIR_NAME, REMOTE_STAGE_DIR_NAME, validateRemoteTarget } from "../../shared/remote-target.js";
import { isRemoteStagedHome } from "../../shared/local-db-guard.js";
import { evaluateWritePathPolicy } from "../../shared/command-policy.js";
import { claudeProjectSlug } from "../../shared/claude-project-slug.js";

let root: string;
beforeEach(() => { root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "remote-rename-"))); });
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

const touch = (file: string): void => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, "x"); };
const run = (...args: string[]): string => execFileSync("sh", ["-c", STAGE_RENAME_SCRIPT, "sh", ...args], { encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"] });

describe("the names a host's directories carry", () => {
  it("are the current codename's, with the legacy ones known", () => {
    expect(REMOTE_DEPARTMENTS_DIR).toBe(".acme-departments");
    expect(LEGACY_REMOTE_DEPARTMENTS_DIR).toBe(".jinn-departments");
    expect(REMOTE_STAGE_MARKER).toBe(".acme-remote-stage");
    expect(LEGACY_REMOTE_STAGE_MARKER).toBe(".jinn-remote-stage");
    expect(REMOTE_STAGE_DIR_NAME).toBe(".acme-remote-stage");
    expect(remoteDepartmentsRoots("/srv/work")).toEqual(["/srv/work/.acme-departments", "/srv/work/.jinn-departments"]);
  });

  it("keep recognising what an older gateway staged: its marker, its stage root, its stage directories", () => {
    for (const marker of [REMOTE_STAGE_MARKER, LEGACY_REMOTE_STAGE_MARKER]) {
      const home = path.join(root, marker);
      touch(path.join(home, marker));
      expect(isRemoteStagedHome(home)).toBe(true);
      expect(isLinkedInFarm([marker])).toBe(false);
    }
    expect(isRemoteStagedHome(root)).toBe(false);
    const remote = { root: "/srv/work", mount: "/mnt/home" };
    for (const name of [REMOTE_DEPARTMENTS_DIR, LEGACY_REMOTE_DEPARTMENTS_DIR]) {
      expect(scopedRemoteTargetProblem(`/srv/work/${name}/ops`, remote)).toContain("overlaps");
      expect(validateRemoteTarget({ remoteHost: "box", remoteUser: "u", remoteCwd: `/srv/work/${name}/ops/inner` }, remote as never)).toMatchObject({ error: expect.stringContaining(name) });
    }
  });

  it("keep the file policy treating a farm under either stage root as the mounted home's shape", () => {
    const options = { remoteMountRoot: "/mnt/home" };
    for (const name of [REMOTE_STAGE_DIR_NAME, LEGACY_REMOTE_STAGE_DIR_NAME]) {
      expect(evaluateWritePathPolicy(`/home/u/${name}/knowledge/x.md`, options).action).toBe("allow");
    }
    // The same shape under a name that is not a stage root is still a write outside the mount.
    expect(evaluateWritePathPolicy("/home/u/.acme-other/knowledge/x.md", options).action).toBe("block");
  });
});

describe("moving a host's stage directories", () => {
  const config = () => path.join(root, "claude");

  it("moves the container and the conversations filed under each stage directory, once", () => {
    touch(path.join(root, ".jinn-departments", "ops", "CLAUDE.md"));
    touch(path.join(root, ".jinn-departments", "dev", "CLAUDE.md"));
    touch(path.join(config(), "projects", claudeProjectSlug(path.join(root, ".jinn-departments", "ops")), "a.jsonl"));
    const out = run(path.join(root, ".jinn-departments"), path.join(root, ".acme-departments"), config(), path.join(root, "unused"));
    expect(out).toContain("transcripts=1");
    expect(fs.existsSync(path.join(root, ".jinn-departments"))).toBe(false);
    expect(fs.existsSync(path.join(root, ".acme-departments", "dev", "CLAUDE.md"))).toBe(true);
    expect(fs.existsSync(path.join(config(), "projects", claudeProjectSlug(path.join(root, ".acme-departments", "ops")), "a.jsonl"))).toBe(true);
    expect(run(path.join(root, ".jinn-departments"), path.join(root, ".acme-departments"), config())).toBe("");
  });

  it.runIf(fs.existsSync("/proc/self"))("leaves the container where it is while a process works inside it, and moves it once that has ended", async () => {
    touch(path.join(root, ".jinn-departments", "ops", "CLAUDE.md"));
    touch(path.join(config(), "projects", claudeProjectSlug(path.join(root, ".jinn-departments", "ops")), "a.jsonl"));
    const session = spawn("sleep", ["30"], { cwd: path.join(root, ".jinn-departments", "ops"), stdio: "ignore" });
    try {
      await new Promise((resolve) => session.once("spawn", resolve));
      expect(run(path.join(root, ".jinn-departments"), path.join(root, ".acme-departments"), config())).toContain("busy=");
      expect(fs.existsSync(path.join(root, ".jinn-departments", "ops", "CLAUDE.md"))).toBe(true);
      expect(fs.existsSync(path.join(root, ".acme-departments"))).toBe(false);
    } finally {
      session.kill();
      await new Promise((resolve) => session.once("exit", resolve));
    }
    expect(run(path.join(root, ".jinn-departments"), path.join(root, ".acme-departments"), config())).toContain("transcripts=1");
  });

  it("leaves both alone when the new container exists already", () => {
    touch(path.join(root, ".jinn-departments", "ops", "old"));
    touch(path.join(root, ".acme-departments", "ops", "new"));
    expect(run(path.join(root, ".jinn-departments"), path.join(root, ".acme-departments"), config())).toBe("");
    expect(fs.existsSync(path.join(root, ".jinn-departments", "ops", "old"))).toBe(true);
  });
});
