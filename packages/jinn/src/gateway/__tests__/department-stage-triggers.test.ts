import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { departmentStageDir } from "../department-scope/paths.js";
import { refreshDepartments } from "../department-registry.js";
import { isDepartmentInstructionsPath, startWatchers, stopWatchers } from "../watcher.js";
import { gatewayWatchCallbacks } from "../watch-callbacks.js";
import { resolveJinnHome } from "../../shared/paths.js";
import { resetDepartmentFixtures, writeDepartmentFile, writeSkill } from "./department-fixtures.js";

/** FR-020a: the stage directory is synced at boot and on a skill, department-scan or instructions change. */

const SLUG = "triggers-dept";
const stage = (rel: string) => path.join(departmentStageDir(SLUG), rel);
const read = (rel: string) => fs.readFileSync(stage(rel), "utf-8");
const callbacks = () => gatewayWatchCallbacks({ reloadConfig: vi.fn(), getConfig: () => ({}), reloadOrg: vi.fn(), emit: vi.fn() });
const instructionsFile = () => path.join(resolveJinnHome(), "knowledge", "departments", SLUG, "INSTRUCTIONS.md");

beforeEach(() => {
  resetDepartmentFixtures();
  fs.rmSync(departmentStageDir(SLUG), { recursive: true, force: true });
  fs.rmSync(path.join(resolveJinnHome(), "knowledge", "departments"), { recursive: true, force: true });
  writeSkill("review");
  writeDepartmentFile(SLUG, `name: ${SLUG}\nscope: scoped\nskills: [review]\n`);
  writeDepartmentFile("triggers-open", "name: triggers-open\n");
  refreshDepartments();
});
afterEach(async () => {
  await stopWatchers();
  setStageDirty();
});
const setStageDirty = () => fs.rmSync(departmentStageDir(SLUG), { recursive: true, force: true });

describe("at boot", () => {
  it("syncs the stage directory of every scoped department, and none for an open one", () => {
    callbacks();
    expect(fs.existsSync(stage(".claude/skills/review/SKILL.md"))).toBe(true);
    expect(fs.existsSync(stage("CLAUDE.md"))).toBe(true);
    expect(fs.existsSync(departmentStageDir("triggers-open"))).toBe(false);
  });
});

describe("on a trigger", () => {
  it("a skill change refreshes the copies", () => {
    const hooks = callbacks();
    fs.writeFileSync(path.join(resolveJinnHome(), "skills", "review", "SKILL.md"), "changed skill\n");
    hooks.onSkillsChange();
    expect(read(".claude/skills/review/SKILL.md")).toBe("changed skill\n");
  });

  it("an instructions change regenerates CLAUDE.md", () => {
    const hooks = callbacks();
    fs.mkdirSync(path.dirname(instructionsFile()), { recursive: true });
    fs.writeFileSync(instructionsFile(), "Work to the plan.\n");
    hooks.onDepartmentInstructionsChange();
    expect(read("CLAUDE.md").startsWith("Work to the plan.\n")).toBe(true);
  });

  it("a department scan change (a new allow-list) syncs that department, and the directory keeps its inode", () => {
    callbacks();
    const inode = fs.statSync(departmentStageDir(SLUG)).ino;
    writeSkill("plan");
    writeDepartmentFile(SLUG, `name: ${SLUG}\nscope: scoped\nskills: [review, plan]\n`);
    refreshDepartments();
    expect(fs.existsSync(stage(".claude/skills/plan/SKILL.md"))).toBe(true);
    expect(fs.statSync(departmentStageDir(SLUG)).ino).toBe(inode);
  });

  it("a failed sync is logged and does not throw into the watcher", () => {
    const root = path.dirname(departmentStageDir(SLUG));
    fs.rmSync(root, { recursive: true, force: true });
    fs.writeFileSync(root, "not a directory");
    try {
      expect(() => callbacks().onSkillsChange()).not.toThrow();
    } finally {
      fs.unlinkSync(root);
    }
  });
});

describe("the instructions watcher", () => {
  const departments = path.join("/home", "knowledge", "departments");
  it("walks knowledge/departments and the way down to it, and nothing else", () => {
    for (const p of ["/home/knowledge", departments, path.join(departments, "x"), path.join(departments, "x", "INSTRUCTIONS.md")]) {
      expect(isDepartmentInstructionsPath(p, departments), p).toBe(true);
    }
    for (const p of ["/home/knowledge/state.md", "/home/knowledge/employees", "/home/knowledge/departmentsX", "/home/docs"]) {
      expect(isDepartmentInstructionsPath(p, departments), p).toBe(false);
    }
  });

  it("fires for an INSTRUCTIONS.md edit and not for a note a scoped session wrote beside it", async () => {
    fs.mkdirSync(path.dirname(instructionsFile()), { recursive: true });
    const onDepartmentInstructionsChange = vi.fn();
    startWatchers({ onConfigReload: vi.fn(), onCronReload: vi.fn(), onOrgChange: vi.fn(), onSkillsChange: vi.fn(), onPluginsChange: vi.fn(), onDepartmentInstructionsChange });
    await new Promise((resolve) => setTimeout(resolve, 400));
    fs.writeFileSync(path.join(path.dirname(instructionsFile()), "state.md"), "# State\n");
    await new Promise((resolve) => setTimeout(resolve, 1200));
    expect(onDepartmentInstructionsChange).not.toHaveBeenCalled();
    fs.writeFileSync(instructionsFile(), "new instructions\n");
    await vi.waitFor(() => expect(onDepartmentInstructionsChange).toHaveBeenCalledTimes(1), { timeout: 5000, interval: 100 });
  }, 15_000);
});

describe("folder trust for the stage directory", () => {
  it("is seeded in the gateway's profile whenever the directory is generated, once a seeder is registered", async () => {
    const { prepareDepartmentStage, setStageTrustSeeder } = await import("../department-stage/stage.js");
    const { seedTrust } = await import("../../shared/claude-settings.js");
    const claudeJson = path.join(fs.mkdtempSync(path.join(resolveJinnHome(), "..", "claude-json-")), ".claude.json");
    setStageTrustSeeder((dir) => seedTrust(claudeJson, dir));
    try {
      const dir = prepareDepartmentStage(SLUG);
      const data = JSON.parse(fs.readFileSync(claudeJson, "utf-8"));
      expect(data.projects[dir].hasTrustDialogAccepted).toBe(true);
      expect(data.projects[dir].hasCompletedProjectOnboarding).toBe(true);
    } finally {
      setStageTrustSeeder(null);
      fs.rmSync(path.dirname(claudeJson), { recursive: true, force: true });
    }
  });

  it("a failing seeder is logged and does not stop the sync", async () => {
    const { prepareDepartmentStage, setStageTrustSeeder } = await import("../department-stage/stage.js");
    setStageTrustSeeder(() => { throw new Error("disk full"); });
    try {
      expect(() => prepareDepartmentStage(SLUG)).not.toThrow();
      expect(fs.existsSync(stage("CLAUDE.md"))).toBe(true);
    } finally {
      setStageTrustSeeder(null);
    }
  });
});

describe("the prompt's skill line", () => {
  it("names only the skills the stage directory holds: a skill the generator refused is not offered", async () => {
    const { departmentScopeSections } = await import("../../sessions/context/department-scope.js");
    const { refreshOrg } = await import("../org-registry.js");
    const { writeEmployeeFile } = await import("./department-fixtures.js");
    writeEmployeeFile(SLUG, "triggers-dev");
    writeSkill("risky");
    fs.symlinkSync(path.join(resolveJinnHome(), "skills", "review", "SKILL.md"), path.join(resolveJinnHome(), "skills", "risky", "link.md"));
    writeDepartmentFile(SLUG, `name: ${SLUG}\nscope: scoped\nskills: [review, risky]\n`);
    refreshOrg();
    const line = () => departmentScopeSections({ employee: { name: "triggers-dev" } })[0]?.content ?? "";
    // Before the directory exists the allow-list is all there is to go on.
    expect(line()).toContain("Company skills available to you: review, risky");
    const { prepareDepartmentStage } = await import("../department-stage/stage.js");
    prepareDepartmentStage(SLUG);
    expect(line()).toContain("Company skills available to you: review (in `.claude/skills/`)");
    expect(line()).not.toContain("risky");
  });

  it("names none when every listed skill was refused, although the generator then writes no .claude/skills", async () => {
    const { departmentScopeSections } = await import("../../sessions/context/department-scope.js");
    const { refreshOrg } = await import("../org-registry.js");
    const { writeEmployeeFile } = await import("./department-fixtures.js");
    const { prepareDepartmentStage } = await import("../department-stage/stage.js");
    writeEmployeeFile(SLUG, "triggers-dev");
    writeSkill("risky");
    fs.symlinkSync(path.join(resolveJinnHome(), "skills", "review", "SKILL.md"), path.join(resolveJinnHome(), "skills", "risky", "link.md"));
    writeDepartmentFile(SLUG, `name: ${SLUG}\nscope: scoped\nskills: [risky]\n`);
    refreshOrg();
    prepareDepartmentStage(SLUG);
    expect(fs.existsSync(stage(".claude"))).toBe(false);
    const content = departmentScopeSections({ employee: { name: "triggers-dev" } })[0]?.content ?? "";
    expect(content).toContain("No company skills are offered to this department.");
    expect(content).not.toContain("risky");
  });
});

describe("a stage root that has been replaced by a link", () => {
  it("is refused, so a scoped session never starts in the instance home and nothing there is deleted", async () => {
    const { prepareDepartmentStage } = await import("../department-stage/stage.js");
    const { spawnCwd } = await import("../../sessions/session-cwd.js");
    const home = resolveJinnHome();
    fs.mkdirSync(path.join(home, "docs"), { recursive: true });
    fs.writeFileSync(path.join(home, "docs", "keep.md"), "company doc");
    const root = path.dirname(departmentStageDir(SLUG));
    fs.rmSync(root, { recursive: true, force: true });
    fs.symlinkSync(home, root);
    try {
      expect(() => prepareDepartmentStage(SLUG)).toThrow(/could not be prepared.*is a symbolic link/);
      expect(() => spawnCwd({ employee: "x", scopeDepartment: SLUG })).toThrow(/could not be prepared/);
      writeDepartmentFile("docs", "name: docs\nscope: scoped\n");
      refreshDepartments();
      expect(() => prepareDepartmentStage("docs")).toThrow(/is a symbolic link/);
      expect(fs.readFileSync(path.join(home, "docs", "keep.md"), "utf-8")).toBe("company doc");
      expect(fs.existsSync(path.join(home, SLUG))).toBe(false);
    } finally {
      fs.unlinkSync(root);
    }
  });
});
