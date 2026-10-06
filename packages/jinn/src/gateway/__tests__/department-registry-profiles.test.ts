import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { resolveJinnHome } from "../../shared/paths.js";
import { departmentRecord, refreshDepartments } from "../department-registry.js";
import { orgRegistry, refreshOrg } from "../org-registry.js";
import { resetDepartmentFixtures, writeDepartmentFile, writeEmployeeFile } from "./department-fixtures.js";

/** FR-033: no department working directory may be, contain or sit inside an employee's Claude profile. */

beforeEach(() => resetDepartmentFixtures());

describe("an employee's Claude profile (FR-033)", () => {
  // Beside the instance home: the test temp directory sits inside it, which is a protected tree.
  const repo = fs.realpathSync(fs.mkdtempSync(path.join(path.dirname(resolveJinnHome()), "jinn-department-profile-")));
  const profile = path.join(repo, "profile");
  beforeAll(() => {
    fs.mkdirSync(path.join(profile, "projects"), { recursive: true });
    fs.mkdirSync(path.join(repo, "app"), { recursive: true });
    execFileSync("git", ["init", "-q", repo], { stdio: "ignore" });
  });
  afterAll(() => fs.rmSync(repo, { recursive: true, force: true }));
  const workdirs = `workdirs: ['${repo}', '${profile}', '${path.join(profile, "projects")}', '${path.join(repo, "app")}']`;

  it("is kept when no employee runs on it", () => {
    writeDepartmentFile("side-project", `name: side-project\nscope: scoped\n${workdirs}\n`);
    refreshDepartments();
    expect(departmentRecord("side-project").definition?.workdirs).toEqual([repo, profile, path.join(profile, "projects"), path.join(repo, "app")]);
  });

  it.each([
    ["an employee that loads", "engineering", {}],
    ["an employee the scan refuses", "side-project", { department: "engineering" }],
  ])("is dropped, with what contains it, when %s runs on it", (_label, directory, extra) => {
    writeDepartmentFile("side-project", `name: side-project\nscope: scoped\n${workdirs}\n`);
    writeEmployeeFile(directory, "friend", { ...extra, claudeConfigDir: profile });
    refreshOrg();
    expect(orgRegistry().has("friend")).toBe(directory === "engineering");
    const record = departmentRecord("side-project");
    expect(record.definition?.workdirs).toEqual([path.join(repo, "app")]);
    expect(record.warnings.filter((warning) => warning.startsWith("workdirs:"))).toHaveLength(3);
  });
});
