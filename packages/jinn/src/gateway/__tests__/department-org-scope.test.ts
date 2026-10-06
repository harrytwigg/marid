import { beforeEach, describe, expect, it, vi } from "vitest";
import { logger } from "../../shared/logger.js";
import { departmentChangeRefusal } from "../org-department-check.js";
import { orgRegistry, refreshOrg } from "../org-registry.js";
import { departmentScopeOf } from "../department-registry.js";
import { resetDepartmentFixtures, writeDepartmentFile, writeEmployeeFile } from "./department-fixtures.js";

/** FR-007: an employee is scoped exactly when its resolved department is not open, and the three places that name it must agree. */

const roster = () => [...orgRegistry().keys()].filter((name) => !["todo-dispatcher", "todo-shaper"].includes(name)).sort();

beforeEach(() => {
  resetDepartmentFixtures();
  writeDepartmentFile("side-project", "name: side-project\nscope: scoped\n");
});

describe("an employee whose directory, immediate directory and department field agree", () => {
  it("loads in a scoped department, with and without the field", () => {
    writeEmployeeFile("side-project", "side-dev");
    writeEmployeeFile("side-project", "side-qa", { department: "side-project" });
    refreshOrg();
    expect(roster()).toEqual(["side-dev", "side-qa"]);
    expect(orgRegistry().get("side-dev")?.department).toBe("side-project");
  });

  it("loads in a dedicated department", () => {
    writeDepartmentFile("side-project", "name: side-project\nscope: dedicated\n");
    writeEmployeeFile("side-project", "side-dev");
    refreshOrg();
    expect(roster()).toEqual(["side-dev"]);
  });
});

describe("an employee whose places disagree about a non-open department", () => {
  it("is refused when its department field names a scoped department but its directory does not", () => {
    const error = vi.spyOn(logger, "error");
    writeEmployeeFile("engineering", "eng-dev", { department: "side-project" });
    refreshOrg();
    expect(roster()).toEqual([]);
    expect(error.mock.calls.map((call) => call[0]).join("\n")).toMatch(/eng-dev.yaml: its top-level directory "engineering".*"side-project" is not an open department/);
  });

  it("is refused when it sits in a scoped directory but its field names another department", () => {
    writeEmployeeFile("side-project", "side-dev", { department: "engineering" });
    refreshOrg();
    expect(roster()).toEqual([]);
  });

  it("is refused when a nested directory would resolve it to another department", () => {
    writeEmployeeFile("side-project/qa", "side-qa");
    refreshOrg();
    expect(roster()).toEqual([]);
  });

  it("is refused when a nested directory and the field both say the scoped department", () => {
    writeEmployeeFile("side-project/qa", "side-qa", { department: "side-project" });
    refreshOrg();
    expect(roster()).toEqual([]);
  });

  it("is refused when it sits straight under org/ and names a scoped department", () => {
    writeEmployeeFile("", "loose-dev", { department: "side-project" });
    refreshOrg();
    expect(roster()).toEqual([]);
  });

  it("keeps the rest of the org loading", () => {
    writeEmployeeFile("engineering", "eng-dev", { department: "side-project" });
    writeEmployeeFile("engineering", "eng-ok");
    writeEmployeeFile("side-project", "side-dev");
    refreshOrg();
    expect(roster()).toEqual(["eng-ok", "side-dev"]);
  });
});

describe("departments that are open keep today's behaviour", () => {
  it("lets the field and the directory disagree", () => {
    writeEmployeeFile("engineering", "eng-dev", { department: "platform" });
    writeEmployeeFile("engineering/qa", "eng-qa");
    refreshOrg();
    expect(roster()).toEqual(["eng-dev", "eng-qa"]);
    expect(orgRegistry().get("eng-dev")?.department).toBe("platform");
    expect(orgRegistry().get("eng-qa")?.department).toBe("qa");
  });

  it("lets a file straight under org/ load into the org department", () => {
    writeEmployeeFile("", "loose-dev");
    refreshOrg();
    expect(orgRegistry().get("loose-dev")?.department).toBe("org");
  });

  it("refuses nothing when no department.yaml exists", () => {
    resetDepartmentFixtures();
    writeEmployeeFile("engineering", "eng-dev", { department: "side-project" });
    refreshOrg();
    expect(roster()).toEqual(["eng-dev"]);
  });
});

describe("a refused department file", () => {
  it("still confines its members: the department stays scoped, so a mismatch is still refused", () => {
    refreshOrg();
    writeDepartmentFile("side-project", "name: side-project\nscope: [broken\n");
    writeEmployeeFile("engineering", "eng-dev", { department: "side-project" });
    refreshOrg();
    expect(roster()).toEqual([]);
  });

  it("counts as dedicated when it never loaded", () => {
    writeDepartmentFile("new-project", "name: wrong-name\nscope: scoped\n");
    writeEmployeeFile("engineering", "eng-dev", { department: "new-project" });
    refreshOrg();
    expect(departmentScopeOf("new-project")).toBe("dedicated");
    expect(roster()).toEqual([]);
  });
});

describe("changing an employee's department through the API", () => {
  const scopeOf = (slug: string) => (slug === "side-project" ? "scoped" : "open");

  it("is refused into or out of a non-open department", () => {
    expect(departmentChangeRefusal("eng-dev", "engineering", "side-project", scopeOf)).toMatch(/not an open department/);
    expect(departmentChangeRefusal("side-dev", "side-project", "engineering", scopeOf)).toMatch(/move the file by hand/);
  });

  it("is allowed between open departments, and when nothing changes", () => {
    expect(departmentChangeRefusal("eng-dev", "engineering", "platform", scopeOf)).toBeNull();
    expect(departmentChangeRefusal("eng-dev", "engineering", undefined, scopeOf)).toBeNull();
    expect(departmentChangeRefusal("side-dev", "side-project", "side-project", scopeOf)).toBeNull();
  });
});
