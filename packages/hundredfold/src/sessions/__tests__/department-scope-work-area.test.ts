import { beforeEach, describe, expect, it } from "vitest";
import { refreshOrg } from "../../gateway/org-registry.js";
import { resetDepartmentFixtures, writeDepartmentFile, writeEmployeeFile } from "../../gateway/__tests__/department-fixtures.js";
import { departmentScopeSections } from "../context/department-scope.js";

/**
 * A scoped remote session's cwd is the department's shared stage directory, so its prompt
 * says so and names the employee's own work area (FR-061). A local scoped session's does not.
 */

const STAGE_LINE = "Your working directory is the department's stage directory";

beforeEach(() => {
  resetDepartmentFixtures();
  writeDepartmentFile("side-project", "name: side-project\nscope: scoped\n");
  writeEmployeeFile("side-project", "prompt-side-dev");
  refreshOrg();
});

describe("departmentScopeSections", () => {
  it("tells a scoped remote employee its working directory is the stage directory, and where its work goes", () => {
    const [section] = departmentScopeSections({ employee: { name: "prompt-side-dev", remoteHost: "build-box", remoteCwd: "/srv/root/work" } });
    expect(section!.content).toContain("This session is scoped to department **side-project**");
    expect(section!.content).toContain("You run on build-box.");
    expect(section!.content).toContain(STAGE_LINE);
    expect(section!.content).toContain("`/srv/root/work`");
  });

  it("does not say it of a local scoped employee", () => {
    const [section] = departmentScopeSections({ employee: { name: "prompt-side-dev" } });
    expect(section!.content).toContain("## Department scope");
    expect(section!.content).not.toContain(STAGE_LINE);
    expect(section!.content).not.toContain("You run on");
  });
});
