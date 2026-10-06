import { beforeEach, describe, expect, it, vi } from "vitest";
import { initDb } from "../../shared/db.js";
import { logger } from "../../shared/logger.js";
import { departmentRecord, departmentScopeOf, refreshDepartments } from "../department-registry.js";
import { orgRegistry, refreshOrg } from "../org-registry.js";
import { resetDepartmentFixtures, writeDepartmentFile, writeEmployeeFile } from "./department-fixtures.js";

const recorded = (slug: string) =>
  initDb().prepare("SELECT scope FROM department_scopes WHERE slug = ?").pluck().get(slug) as string | undefined;

/* A database that predates the scope table: since 0.26 the shipped template has described a
 * department.yaml that nothing read, so the files already on disk were never validated. */
describe("an instance upgraded with a department.yaml the new parser refuses", () => {
  const LEGACY = "name: engineering\ndisplayName: Engineering\ndescription: Builds: and ships\n";

  beforeEach(() => resetDepartmentFixtures({ upgraded: false }));

  it("keeps the department open instead of holding it dedicated, and says why", () => {
    const warn = vi.spyOn(logger, "warn");
    writeDepartmentFile("engineering", LEGACY);
    refreshDepartments();
    expect(departmentScopeOf("engineering")).toBe("open");
    expect(recorded("engineering")).toBe("open");
    expect(departmentRecord("engineering").definitionError).toMatch(/does not parse/);
    expect(warn.mock.calls.map((call) => call[0]).join("\n")).toMatch(/predates this version, so the department stays open/);
  });

  it("lets the employees and Todos of that department behave as they did before the upgrade", () => {
    writeDepartmentFile("engineering", "name: Engineering\n");
    writeEmployeeFile("engineering", "alice", { department: "platform" });
    refreshOrg();
    expect(orgRegistry().get("alice")?.department).toBe("platform");
  });

  it("still loads a legacy file that is valid, with its real scope", () => {
    writeDepartmentFile("engineering", "name: engineering\ndisplayName: Engineering\nscope: scoped\n");
    refreshDepartments();
    expect(departmentScopeOf("engineering")).toBe("scoped");
  });

  it("is done once: a new refused file after that first refresh is held dedicated", () => {
    refreshDepartments();
    writeDepartmentFile("new-lab", "name: wrong\nscope: scoped\n");
    refreshDepartments();
    expect(departmentScopeOf("new-lab")).toBe("dedicated");
  });

  it("does not fix a refused legacy file as open once it has recorded a scope", () => {
    writeDepartmentFile("engineering", "name: engineering\nscope: dedicated\n");
    refreshDepartments();
    writeDepartmentFile("engineering", LEGACY);
    refreshDepartments();
    expect(departmentScopeOf("engineering")).toBe("dedicated");
  });
});
