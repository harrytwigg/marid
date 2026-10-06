import fs from "node:fs";
import path from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { refreshOrg } from "../../gateway/org-registry.js";
import { departmentStageDir } from "../../gateway/department-scope/paths.js";
import { prepareDepartmentStage, resolvedStageDir } from "../../gateway/department-stage/stage.js";
import { resetDepartmentFixtures, writeDepartmentFile, writeEmployeeFile, writeSkill } from "../../gateway/__tests__/department-fixtures.js";
import { JINN_HOME } from "../../shared/paths.js";
import { sessionScopeDepartment, spawnCwd, transcriptCwd } from "../session-cwd.js";

/** FR-020, FR-020b: a scoped session's cwd is its department's stage directory, prepared before every spawn. */

const SLUG = "cwd-helper-dept";
const stage = () => resolvedStageDir(SLUG);
const unscoped = { employee: "cwd-helper-eng", scopeDepartment: null };
const scoped = { employee: "cwd-helper-dev", scopeDepartment: SLUG };

beforeEach(() => {
  resetDepartmentFixtures();
  fs.rmSync(departmentStageDir(SLUG), { recursive: true, force: true });
  writeSkill("review");
  writeSkill("not-offered");
  writeDepartmentFile(SLUG, `name: ${SLUG}\nscope: scoped\nskills: [review]\n`);
  writeEmployeeFile(SLUG, "cwd-helper-dev");
  writeEmployeeFile("engineering", "cwd-helper-eng");
  refreshOrg();
});

describe("the stage directory", () => {
  it("lives beside the Jinn home, outside it, in a root of this instance's own", () => {
    expect(departmentStageDir(SLUG)).toBe(path.join(path.dirname(JINN_HOME), ".jinn-departments", ".instances", path.basename(JINN_HOME), SLUG));
    expect(path.relative(JINN_HOME, departmentStageDir(SLUG)).startsWith("..")).toBe(true);
  });

  it("holds the allowed skills and the generated CLAUDE.md, and nothing else", () => {
    prepareDepartmentStage(SLUG);
    const listing = fs.readdirSync(stage(), { recursive: true }).map(String).sort();
    expect(listing).toEqual([".claude", ".claude/skills", ".claude/skills/review", ".claude/skills/review/SKILL.md", "CLAUDE.md"]);
  });

  it("is returned by its realpath, and keeps its inode when synced again", () => {
    const first = prepareDepartmentStage(SLUG);
    const inode = fs.statSync(first).ino;
    fs.writeFileSync(path.join(first, "CLAUDE.md"), "edited by the session");
    expect(prepareDepartmentStage(SLUG)).toBe(first);
    expect(first).toBe(fs.realpathSync(departmentStageDir(SLUG)));
    expect(fs.statSync(first).ino).toBe(inode);
    expect(fs.readFileSync(path.join(first, "CLAUDE.md"), "utf-8")).toContain("## Department scope");
  });

  it("picks up an allow-list change and an instructions edit on the next sync", () => {
    prepareDepartmentStage(SLUG);
    const notes = path.join(JINN_HOME, "knowledge", "departments", SLUG);
    fs.mkdirSync(notes, { recursive: true });
    fs.writeFileSync(path.join(notes, "INSTRUCTIONS.md"), "Keep to the plan.\n");
    writeDepartmentFile(SLUG, `name: ${SLUG}\nscope: scoped\nskills: [not-offered]\n`);
    refreshOrg();
    prepareDepartmentStage(SLUG);
    expect(fs.existsSync(path.join(stage(), ".claude/skills/review"))).toBe(false);
    expect(fs.existsSync(path.join(stage(), ".claude/skills/not-offered/SKILL.md"))).toBe(true);
    expect(fs.readFileSync(path.join(stage(), "CLAUDE.md"), "utf-8").startsWith("Keep to the plan.")).toBe(true);
  });
});

describe("the cwd of a local session", () => {
  it("is the Jinn home for an unscoped session, and for no session at all", () => {
    expect(spawnCwd(unscoped)).toBe(JINN_HOME);
    expect(spawnCwd(undefined)).toBe(JINN_HOME);
    expect(sessionScopeDepartment(unscoped)).toBeNull();
    expect(transcriptCwd(unscoped)).toBe(JINN_HOME);
  });

  it("is the stage directory for a session bound to a scoped department", () => {
    expect(spawnCwd(scoped)).toBe(stage());
    expect(fs.existsSync(path.join(stage(), "CLAUDE.md"))).toBe(true);
  });

  it("is the stage directory for a scoped employee's session that has no binding yet", () => {
    expect(spawnCwd({ employee: "cwd-helper-dev" })).toBe(stage());
  });

  it("syncs before it answers, so an edit made since the last spawn is reverted", () => {
    spawnCwd(scoped);
    fs.writeFileSync(path.join(stage(), "CLAUDE.md"), "edited");
    fs.writeFileSync(path.join(stage(), "scratch.txt"), "left behind");
    spawnCwd(scoped);
    expect(fs.readFileSync(path.join(stage(), "CLAUDE.md"), "utf-8")).toContain("## Department scope");
    expect(fs.existsSync(path.join(stage(), "scratch.txt"))).toBe(false);
  });

  it("never falls back to the Jinn home when the stage directory cannot be prepared", () => {
    // A file where the stage root belongs: nothing can be created under it.
    const root = path.dirname(departmentStageDir(SLUG));
    fs.rmSync(root, { recursive: true, force: true });
    fs.writeFileSync(root, "not a directory");
    try {
      expect(() => spawnCwd(scoped)).toThrow(/stage directory for department "cwd-helper-dept" could not be prepared/);
    } finally {
      fs.rmSync(root, { force: true });
    }
  });

  it("answers a transcript lookup without creating or syncing anything", () => {
    fs.rmSync(departmentStageDir(SLUG), { recursive: true, force: true });
    expect(transcriptCwd(scoped)).toBe(departmentStageDir(SLUG));
    expect(fs.existsSync(departmentStageDir(SLUG))).toBe(false);
  });
});
