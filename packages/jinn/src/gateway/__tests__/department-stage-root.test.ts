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
 * `<parent of home>/.jinn-departments/<basename of home>/`, so two instances under one
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

  it("is keyed by the instance: <parent>/.jinn-departments/<basename of home>/", () => {
    const parent = path.join(os.tmpdir(), "instances");
    process.env.JINN_HOME = path.join(parent, ".jinn-yorio");
    expect(departmentStageRoot()).toBe(path.join(parent, ".jinn-departments", ".jinn-yorio"));
    expect(departmentStagesContainer()).toBe(path.join(parent, ".jinn-departments"));
  });

  it("gives two instances under one parent a different stage directory for the same department", () => {
    const parent = path.join(os.tmpdir(), "instances");
    process.env.JINN_HOME = path.join(parent, ".jinn");
    const first = departmentStageDir("side-project");
    process.env.JINN_HOME = path.join(parent, ".jinn-test");
    const second = departmentStageDir("side-project");
    expect(first).toBe(path.join(parent, ".jinn-departments", ".jinn", "side-project"));
    expect(second).toBe(path.join(parent, ".jinn-departments", ".jinn-test", "side-project"));
    expect(first).not.toBe(second);
  });

  it("is outside the home, and the stage directory sits directly in it", () => {
    expect(path.relative(path.dirname(departmentStageRoot()), departmentStageDir(SLUG))).toBe(path.join(path.basename(departmentStageRoot()), SLUG));
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
    const newKeyDir = path.join(projects(), claudeProjectSlug(path.join(fs.realpathSync(departmentStagesContainer()), path.basename(departmentStageRoot()), SLUG)));
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

  it("moves a department named like the instance, whose old path is the new root's own", () => {
    const named = path.basename(departmentStageRoot());
    writeDepartmentFile(named, `name: ${named}\nscope: scoped\nskills: [review]\n`);
    writeEmployeeFile(named, "stage-root-namesake");
    refreshOrg();
    const old = path.join(departmentStagesContainer(), named);
    fs.rmSync(old, { recursive: true, force: true });
    writeLegacyStage(old);
    const inode = fs.statSync(old).ino;
    const stage = prepareDepartmentStage(named);
    expect(stage).toBe(path.join(fs.realpathSync(departmentStageRoot()), named));
    expect(fs.statSync(stage).ino).toBe(inode);
    // The root is not a stage directory: nothing in it carries instructions down to the sessions below.
    expect(fs.existsSync(path.join(departmentStageRoot(), "CLAUDE.md"))).toBe(false);
    expect(fs.existsSync(path.join(departmentStageRoot(), ".claude"))).toBe(false);
  });

  it("changes nothing for a department that never had one", () => {
    const stage = prepareDepartmentStage(SLUG);
    expect(stage).toBe(resolvedStageDir(SLUG));
    expect(fs.existsSync(legacyDir())).toBe(false);
  });
});
