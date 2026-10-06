import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { claudeProjectSlug } from "../../engines/claude-transcript-path.js";
import { claudeProjectsDirFor } from "../../shared/claude-profile.js";
import { departmentStageDir } from "../department-scope/paths.js";
import { migrateLegacyStageDir } from "../department-stage/legacy-stage.js";
import { prepareDepartmentStage, resolvedStageDir } from "../department-stage/stage.js";
import { departmentStageRoot, departmentStagesContainer } from "../department-workdirs.js";
import { refreshOrg } from "../org-registry.js";
import { resetDepartmentFixtures, writeDepartmentFile, writeEmployeeFile, writeSkill } from "./department-fixtures.js";

/**
 * FR-020, FR-020a: each instance keeps its stage directories in a root of its own,
 * `<parent of home>/.jinn-departments/.instances/<basename of home>/`, so two instances under one
 * parent do not share a department's stage directory. A directory made at the old path,
 * `.jinn-departments/<slug>/`, is moved once, keeping its inode and its transcripts.
 */

const SLUG = "stage-root-dept";
const ID = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
const projects = () => claudeProjectsDirFor(null);
const legacyDir = () => path.join(departmentStagesContainer(), SLUG);

/** A stage directory as the old layout left it. */
function writeLegacyStage(dir: string): void {
  fs.mkdirSync(path.join(dir, ".claude/skills/review"), { recursive: true });
  fs.writeFileSync(path.join(dir, "CLAUDE.md"), "old generated file\n");
  fs.writeFileSync(path.join(dir, ".claude/skills/review/SKILL.md"), "old skill\n");
}

function writeTranscript(cwd: string, id = ID): string {
  const file = path.join(projects(), claudeProjectSlug(cwd), `${id}.jsonl`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, '{"type":"user"}\n');
  return file;
}

beforeEach(() => {
  resetDepartmentFixtures();
  fs.rmSync(legacyDir(), { recursive: true, force: true });
  fs.rmSync(departmentStageDir(SLUG), { recursive: true, force: true });
  fs.rmSync(projects(), { recursive: true, force: true });
  writeSkill("review");
  writeDepartmentFile(SLUG, `name: ${SLUG}\nscope: scoped\nskills: [review]\n`);
  writeEmployeeFile(SLUG, "stage-root-dev");
  refreshOrg();
});

describe("the stage root", () => {
  const savedHome = process.env.JINN_HOME;
  afterEach(() => {
    process.env.JINN_HOME = savedHome;
  });

  it("is keyed by the instance: <parent>/.jinn-departments/.instances/<basename of home>/", () => {
    const parent = path.join(os.tmpdir(), "instances");
    process.env.JINN_HOME = path.join(parent, ".jinn-yorio");
    expect(departmentStageRoot()).toBe(path.join(parent, ".jinn-departments", ".instances", ".jinn-yorio"));
    expect(departmentStagesContainer()).toBe(path.join(parent, ".jinn-departments"));
  });

  it("gives two instances under one parent a different stage directory for the same department", () => {
    const parent = path.join(os.tmpdir(), "instances");
    process.env.JINN_HOME = path.join(parent, ".jinn");
    const first = departmentStageDir("side-project");
    process.env.JINN_HOME = path.join(parent, ".jinn-test");
    const second = departmentStageDir("side-project");
    expect(first).toBe(path.join(parent, ".jinn-departments", ".instances", ".jinn", "side-project"));
    expect(second).toBe(path.join(parent, ".jinn-departments", ".instances", ".jinn-test", "side-project"));
    expect(first).not.toBe(second);
  });

  it("can never be a department's old-layout path, whatever the home is called", () => {
    // A slug cannot start with a dot, and the root is under a dot-named directory: a home called
    // like a department (here, undotted) never makes its root the same path as that department's old stage directory.
    process.env.JINN_HOME = path.join(os.tmpdir(), "instances", "alpha");
    expect(departmentStageRoot()).toBe(path.join(os.tmpdir(), "instances", ".jinn-departments", ".instances", "alpha"));
    expect(departmentStageRoot()).not.toBe(path.join(departmentStagesContainer(), "alpha"));
    expect(path.dirname(departmentStageRoot())).not.toBe(departmentStagesContainer());
  });

  it("is outside the home, and the stage directory sits directly in it", () => {
    expect(path.dirname(departmentStageDir(SLUG))).toBe(departmentStageRoot());
    expect(path.relative(process.env.JINN_HOME!, departmentStageDir(SLUG)).startsWith("..")).toBe(true);
  });
});

describe("a stage directory made at the old path", () => {
  it("is moved to the instance's root once, keeping its inode", () => {
    writeLegacyStage(legacyDir());
    const inode = fs.statSync(legacyDir()).ino;
    const stage = prepareDepartmentStage(SLUG);
    expect(stage).toBe(fs.realpathSync(departmentStageDir(SLUG)));
    expect(fs.statSync(stage).ino).toBe(inode);
    expect(fs.existsSync(legacyDir())).toBe(false);
    // And it was then synced in place: the generated file replaced the old one.
    expect(fs.readFileSync(path.join(stage, "CLAUDE.md"), "utf-8")).toContain("## Department scope");
  });

  it("stays put afterwards: the path and inode are stable across further syncs", () => {
    writeLegacyStage(legacyDir());
    const first = prepareDepartmentStage(SLUG);
    const inode = fs.statSync(first).ino;
    expect(prepareDepartmentStage(SLUG)).toBe(first);
    expect(prepareDepartmentStage(SLUG)).toBe(first);
    expect(fs.statSync(first).ino).toBe(inode);
  });

  it("is not moved again, and not touched, when a directory appears at the old path later", () => {
    writeLegacyStage(legacyDir());
    const stage = prepareDepartmentStage(SLUG);
    const inode = fs.statSync(stage).ino;
    writeLegacyStage(legacyDir());
    expect(migrateLegacyStageDir(SLUG)).toBe(false);
    prepareDepartmentStage(SLUG);
    expect(fs.statSync(stage).ino).toBe(inode);
    expect(fs.readFileSync(path.join(legacyDir(), "CLAUDE.md"), "utf-8")).toBe("old generated file\n");
  });

  it("takes its transcripts with it, so resume, fork and auto-compaction find them under the new key", () => {
    writeLegacyStage(legacyDir());
    const oldKey = fs.realpathSync(legacyDir());
    const old = writeTranscript(oldKey);
    const stage = prepareDepartmentStage(SLUG);
    const moved = path.join(projects(), claudeProjectSlug(stage), `${ID}.jsonl`);
    expect(fs.existsSync(moved)).toBe(true);
    expect(fs.readFileSync(moved, "utf-8")).toBe('{"type":"user"}\n');
    expect(fs.existsSync(old)).toBe(false);
    expect(fs.existsSync(path.dirname(old))).toBe(false);
  });

  it("merges the transcripts into a project directory the new key already has, keeping what is there", () => {
    writeLegacyStage(legacyDir());
    const oldKey = fs.realpathSync(legacyDir());
    writeTranscript(oldKey, ID);
    writeTranscript(oldKey, "11111111-1111-1111-1111-111111111111");
    const newKeyDir = path.join(projects(), claudeProjectSlug(path.join(fs.realpathSync(departmentStagesContainer()), ".instances", path.basename(departmentStageRoot()), SLUG)));
    fs.mkdirSync(newKeyDir, { recursive: true });
    fs.writeFileSync(path.join(newKeyDir, `${ID}.jsonl`), "newer\n");
    prepareDepartmentStage(SLUG);
    expect(fs.readFileSync(path.join(newKeyDir, `${ID}.jsonl`), "utf-8")).toBe("newer\n");
    expect(fs.existsSync(path.join(newKeyDir, "11111111-1111-1111-1111-111111111111.jsonl"))).toBe(true);
  });

  it("removes the incoming directories the old sync left beside it", () => {
    writeLegacyStage(legacyDir());
    const leftover = path.join(departmentStagesContainer(), `.${SLUG}.incoming-abc123`);
    fs.mkdirSync(leftover);
    prepareDepartmentStage(SLUG);
    expect(fs.existsSync(leftover)).toBe(false);
  });

  it("is left alone when it is not a stage directory: another instance's root has no CLAUDE.md", () => {
    fs.mkdirSync(path.join(legacyDir(), "some-department"), { recursive: true });
    expect(migrateLegacyStageDir(SLUG)).toBe(false);
    expect(fs.existsSync(path.join(legacyDir(), "some-department"))).toBe(true);
    prepareDepartmentStage(SLUG);
    expect(fs.existsSync(path.join(legacyDir(), "some-department"))).toBe(true);
    expect(fs.existsSync(path.join(departmentStageDir(SLUG), "CLAUDE.md"))).toBe(true);
  });

  it("is left alone when it is a link", () => {
    const elsewhere = fs.mkdtempSync(path.join(os.tmpdir(), "stage-root-link-"));
    writeLegacyStage(elsewhere);
    fs.mkdirSync(path.dirname(legacyDir()), { recursive: true });
    fs.symlinkSync(elsewhere, legacyDir());
    expect(migrateLegacyStageDir(SLUG)).toBe(false);
    expect(fs.lstatSync(legacyDir()).isSymbolicLink()).toBe(true);
    fs.unlinkSync(legacyDir());
    fs.rmSync(elsewhere, { recursive: true, force: true });
  });

  it("is not moved when the new path exists already", () => {
    writeLegacyStage(legacyDir());
    fs.mkdirSync(departmentStageDir(SLUG), { recursive: true });
    expect(migrateLegacyStageDir(SLUG)).toBe(false);
    expect(fs.readFileSync(path.join(legacyDir(), "CLAUDE.md"), "utf-8")).toBe("old generated file\n");
  });

  it.each([
    ["the namesake first", ["home", "other"]],
    ["the namesake last", ["other", "home"]],
  ])("moves every old directory, whatever order they are prepared in, when a department is named like the instance (%s)", (_label, order) => {
    // The test instance's home is called `home`, so a department of that name is the namesake.
    const slugs = ["home", "other"];
    for (const slug of slugs) {
      writeDepartmentFile(slug, `name: ${slug}\nscope: scoped\nskills: [review]\n`);
      writeEmployeeFile(slug, `stage-root-${slug}-dev`);
    }
    refreshOrg();
    const inodes = new Map<string, number>();
    for (const slug of slugs) {
      const old = path.join(departmentStagesContainer(), slug);
      fs.rmSync(old, { recursive: true, force: true });
      fs.rmSync(departmentStageDir(slug), { recursive: true, force: true });
      writeLegacyStage(old);
      inodes.set(slug, fs.statSync(old).ino);
    }
    for (const slug of order) {
      const stage = prepareDepartmentStage(slug);
      expect(stage).toBe(path.join(fs.realpathSync(departmentStageRoot()), slug));
      expect(fs.statSync(stage).ino).toBe(inodes.get(slug));
    }
    // Both are where they belong, directly in the root, neither nested in the other, and the root carries no instructions of its own.
    for (const slug of slugs) {
      expect(fs.readFileSync(path.join(departmentStageDir(slug), "CLAUDE.md"), "utf-8")).toContain("## Department scope");
      expect(fs.existsSync(path.join(departmentStageDir(slug), "home"))).toBe(false);
      expect(fs.existsSync(path.join(departmentStageDir(slug), "other"))).toBe(false);
    }
    expect(fs.readdirSync(departmentStageRoot()).filter((name) => !name.startsWith(".")).sort()).toEqual(["home", "other"]);
    expect(fs.existsSync(path.join(departmentStageRoot(), "CLAUDE.md"))).toBe(false);
    expect(fs.existsSync(path.join(departmentStagesContainer(), "home"))).toBe(false);
  });

  it("changes nothing for a department that never had one", () => {
    const stage = prepareDepartmentStage(SLUG);
    expect(stage).toBe(resolvedStageDir(SLUG));
    expect(fs.existsSync(legacyDir())).toBe(false);
  });
});
