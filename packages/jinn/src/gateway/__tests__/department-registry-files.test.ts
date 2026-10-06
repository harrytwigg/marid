import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { logger } from "../../shared/logger.js";
import { resolveJinnHome } from "../../shared/paths.js";
import { assignWorkItem } from "../../work-items/assignment.js";
import { createWorkItem } from "../../work-items/store.js";
import { departmentRecord, departmentScopeOf, refreshDepartments } from "../department-registry.js";
import { refreshOrg } from "../org-registry.js";
import { resetDepartmentFixtures, writeDepartmentFile, writeEmployeeFile } from "./department-fixtures.js";

/** What the filesystem can do to the department scan: a directory it cannot list, a file name in another case. */

beforeEach(() => resetDepartmentFixtures());
afterEach(() => vi.restoreAllMocks());

describe("a directory under org/ that cannot be listed", () => {
  let locked: string | undefined;
  afterEach(() => {
    if (locked) fs.chmodSync(locked, 0o755);
    locked = undefined;
  });

  it.skipIf(process.getuid?.() === 0)("does not stop the scan, so scopes still resolve and Todos can still be assigned", () => {
    writeDepartmentFile("side-project", "name: side-project\nscope: scoped\n");
    writeEmployeeFile("engineering", "eng-dev");
    expect(refreshOrg().registry.has("eng-dev")).toBe(true);
    locked = path.join(resolveJinnHome(), "org", "locked");
    fs.mkdirSync(locked, { recursive: true });
    fs.chmodSync(locked, 0o000);
    // The employee scan still fails on it, as it always has, and serves the last roster.
    const read = refreshOrg();
    expect(read.error).toMatch(/EACCES/);
    expect(read.registry.has("eng-dev")).toBe(true);
    expect(departmentScopeOf("side-project")).toBe("scoped");
    // Whether it holds a department.yaml cannot be known, so the department fails closed.
    expect(departmentScopeOf("locked")).toBe("dedicated");
    const item = createWorkItem({ title: "in side-project", department: "side-project" });
    expect(assignWorkItem(item.id, "eng-dev", "engineering", "operator")?.department).toBe("side-project");
  });
});

describe("a definition file named in another case", () => {
  it("is not read, as the log says, even on a filesystem that would open it", () => {
    const warn = vi.spyOn(logger, "warn");
    writeDepartmentFile("side-project", "name: side-project\nscope: scoped\n", "Department.yaml");
    refreshDepartments();
    expect(departmentScopeOf("side-project")).toBe("open");
    expect(departmentRecord("side-project").definitionFile).toBeNull();
    expect(warn.mock.calls.map((call) => call[0]).join("\n")).toMatch(/Department\.yaml is not read/);
  });
});
