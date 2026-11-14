import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import { initDb } from "../../shared/db.js";
import { logger } from "../../shared/logger.js";
import { assignWorkItem } from "../../work-items/assignment.js";
import { createWorkItem } from "../../work-items/store.js";
import { departmentRecord, departmentScopeOf, refreshDepartments } from "../department-registry.js";
import { orgRegistry, refreshOrg } from "../org-registry.js";
import { resetDepartmentFixtures, writeDepartmentFile, writeEmployeeFile } from "./department-fixtures.js";

/* Since 0.26 the shipped template has described a department.yaml that nothing read, so an
 * instance may hold one the parser refuses. Upgrading must not confine anyone or drop an employee
 * for it. Only a refused file whose own text names a scope other than open is held dedicated. */

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
    expect(error.mock.calls.map((call) => call[0]).join("\n")).toMatch(/has no scope other than open, so the department stays open/);
  });

  it.each([
    ["an unquoted colon that does not parse", LEGACY, /does not parse/],
    ["a name that is not the directory's", "name: Engineering\n", /does not match the directory/],
  ])("keeps its employees on the roster and its Todos moving as they did: %s", (_label, text, why) => {
    writeDepartmentFile("engineering", text);
    writeEmployeeFile("engineering", "alice", { department: "platform" });
    refreshOrg();
    expect(departmentRecord("engineering").definitionError).toMatch(why);
    expect(departmentScopeOf("engineering")).toBe("open");
    expect(orgRegistry().get("alice")?.department).toBe("platform");
    const item = createWorkItem({ title: "in engineering", department: "engineering" });
    expect(assignWorkItem(item.id, "alice", "platform", "operator")?.department).toBe("platform");
  });

  it("is held dedicated when the same broken file says scope: dedicated", () => {
    writeDepartmentFile("engineering", `${LEGACY}scope: dedicated\n`);
    writeEmployeeFile("engineering", "alice", { department: "platform" });
    refreshOrg();
    expect(departmentScopeOf("engineering")).toBe("dedicated");
    expect(orgRegistry().has("alice")).toBe(false);
  });

  it("is held dedicated when the broken file mistypes its scope", () => {
    writeDepartmentFile("engineering", `${LEGACY}scope: scopd\n`);
    refreshDepartments();
    expect(departmentScopeOf("engineering")).toBe("dedicated");
  });

  it("stays open when the broken file says scope: open", () => {
    writeDepartmentFile("engineering", `${LEGACY}scope: open\n`);
    refreshDepartments();
    expect(departmentScopeOf("engineering")).toBe("open");
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

describe("a department.yaml that exists but cannot be read", () => {
  let unreadable: string | undefined;
  afterEach(() => {
    if (unreadable) fs.chmodSync(unreadable, 0o644);
    unreadable = undefined;
  });
  const lockOut = (text: string) => {
    unreadable = writeDepartmentFile("engineering", text);
    fs.chmodSync(unreadable, 0o000);
  };

  it.skipIf(process.getuid?.() === 0)("is held dedicated when no scope was recorded, and says why", () => {
    const error = vi.spyOn(logger, "error");
    lockOut("name: engineering\nscope: open\n");
    refreshDepartments();
    expect(departmentScopeOf("engineering")).toBe("dedicated");
    expect(departmentRecord("engineering").definitionError).toMatch(/cannot be read/);
    expect(recorded("engineering")).toBeUndefined();
    expect(error.mock.calls.map((call) => call[0]).join("\n")).toMatch(/cannot be known, so it is treated as dedicated/);
  });

  it.skipIf(process.getuid?.() === 0)("keeps a recorded scope", () => {
    writeDepartmentFile("engineering", "name: engineering\nscope: scoped\n");
    refreshDepartments();
    lockOut("name: engineering\nscope: scoped\n");
    refreshDepartments();
    expect(departmentScopeOf("engineering")).toBe("scoped");
    expect(departmentRecord("engineering").definitionError).toMatch(/cannot be read/);
  });
});
