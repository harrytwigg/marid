import { beforeEach, describe, expect, it, vi } from "vitest";
import { initDb } from "../../shared/db.js";
import { logger } from "../../shared/logger.js";
import { assignWorkItem } from "../../work-items/assignment.js";
import { createWorkItem } from "../../work-items/store.js";
import { departmentRecord, departmentScopeOf, refreshDepartments } from "../department-registry.js";
import { orgRegistry, refreshOrg } from "../org-registry.js";
import { resetDepartmentFixtures, writeDepartmentFile, writeEmployeeFile } from "./department-fixtures.js";

/* Since 0.26 the shipped template has described a department.yaml that nothing read, so an
 * instance may hold one the parser refuses. Upgrading must not confine anyone or drop an employee
 * for it. Only a refused file whose own text asks for a non-open scope is held dedicated. */

const recorded = (slug: string) =>
  initDb().prepare("SELECT scope FROM department_scopes WHERE slug = ?").pluck().get(slug) as string | undefined;

const LEGACY = "name: engineering\ndisplayName: Engineering\ndescription: Builds: and ships\n";

beforeEach(() => resetDepartmentFixtures());

describe("an upgraded instance with an old department.yaml the parser refuses", () => {
  it("stays open, says why in the log, and records nothing", () => {
    const error = vi.spyOn(logger, "error");
    writeDepartmentFile("engineering", LEGACY);
    refreshDepartments();
    expect(departmentScopeOf("engineering")).toBe("open");
    expect(recorded("engineering")).toBeUndefined();
    expect(departmentRecord("engineering").definitionError).toMatch(/does not parse/);
    expect(error.mock.calls.map((call) => call[0]).join("\n")).toMatch(/does not ask for one, so the department stays open/);
  });

  it("keeps its employees on the roster and its Todos moving as they did", () => {
    writeDepartmentFile("engineering", "name: Engineering\n");
    writeEmployeeFile("engineering", "alice", { department: "platform" });
    refreshOrg();
    expect(orgRegistry().get("alice")?.department).toBe("platform");
    const item = createWorkItem({ title: "in engineering", department: "engineering" });
    expect(assignWorkItem(item.id, "alice", "platform", "operator")?.department).toBe("platform");
  });

  it("is held dedicated when the same broken file asks for confinement", () => {
    writeDepartmentFile("engineering", `${LEGACY}scope: dedicated\n`);
    writeEmployeeFile("engineering", "alice", { department: "platform" });
    refreshOrg();
    expect(departmentScopeOf("engineering")).toBe("dedicated");
    expect(orgRegistry().has("alice")).toBe(false);
  });

  it("still loads a valid old file with its real scope", () => {
    writeDepartmentFile("engineering", "name: engineering\ndisplayName: Engineering\nscope: scoped\n");
    refreshDepartments();
    expect(departmentScopeOf("engineering")).toBe("scoped");
  });

  it("does not open a department that has a recorded scope when its file breaks", () => {
    writeDepartmentFile("engineering", "name: engineering\nscope: dedicated\n");
    refreshDepartments();
    writeDepartmentFile("engineering", LEGACY);
    refreshDepartments();
    expect(departmentScopeOf("engineering")).toBe("dedicated");
  });
});
