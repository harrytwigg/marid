import fs from "node:fs";
import path from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { resolveJinnHome } from "../../shared/paths.js";
import { refreshOrg } from "../org-registry.js";
import { DepartmentBoundaryError } from "../../work-items/department-scope.js";
import { createWorkItem } from "../../work-items/store.js";
import { resetDepartmentFixtures, writeDepartmentFile, writeEmployeeFile } from "./department-fixtures.js";

/**
 * FR-001 and FR-015's fallbacks, seen through who may hold a Todo: a department.yaml the
 * scan refuses keeps the department's last good scope; one that never loaded is held
 * dedicated when it asks for a scope other than `open`, and open when it does not.
 */

const holds = (assignee: string, department: string) => {
  try {
    createWorkItem({ title: "fallback", department, assignee });
    return true;
  } catch (error) {
    if (error instanceof DepartmentBoundaryError) return false;
    throw error;
  }
};

const FILE = (slug: string) => path.join(resolveJinnHome(), "org", slug, "department.yaml");

beforeEach(() => {
  resetDepartmentFixtures();
  writeEmployeeFile("engineering", "eng-dev");
});

describe("a refused department.yaml with a recorded last good scope", () => {
  // What shows a department is still `dedicated`: an outsider cannot hold its Todos. What
  // shows it is still `scoped`: its own member cannot hold a Todo elsewhere.
  const confined = (scope: string) => (scope === "dedicated" ? !holds("eng-dev", "kept-project") : !holds("kept-dev", "engineering"));

  it.each(["dedicated", "scoped"])("keeps %s, whatever the broken file says", (scope) => {
    writeDepartmentFile("kept-project", `name: kept-project\nscope: ${scope}\n`);
    writeEmployeeFile("kept-project", "kept-dev");
    refreshOrg();
    expect(confined(scope)).toBe(true);
    for (const broken of ["name: someone-else\nscope: open\n", "scope: [unclosed\n", "name: kept-project\nscope: scopd\n"]) {
      writeDepartmentFile("kept-project", broken);
      refreshOrg();
      expect({ broken, confined: confined(scope) }).toEqual({ broken, confined: true });
    }
  });

  it("keeps it when the file is deleted, until a file says `scope: open`", () => {
    writeDepartmentFile("gone-project", "name: gone-project\nscope: dedicated\n");
    refreshOrg();
    fs.rmSync(FILE("gone-project"));
    refreshOrg();
    expect(holds("eng-dev", "gone-project")).toBe(false);
    writeDepartmentFile("gone-project", "name: gone-project\nscope: open\n");
    refreshOrg();
    expect(holds("eng-dev", "gone-project")).toBe(true);
  });
});

describe("a refused department.yaml that never loaded", () => {
  it.each([
    ["a mistyped scope", "name: typo-project\nscope: scopd\n"],
    ["a quoted scope other than open", "name: typo-project\nscope: 'Open '\n"],
    ["a scope that is a list", "name: typo-project\nscope: [scoped]\n"],
    ["a file that does not parse but asks for a scope", "scope: scoped\nname: [unclosed\n"],
  ])("is held dedicated: %s", (_why, text) => {
    writeDepartmentFile("typo-project", text);
    refreshOrg();
    expect(holds("eng-dev", "typo-project")).toBe(false);
    writeEmployeeFile("typo-project", "typo-dev");
    refreshOrg();
    expect(holds("typo-dev", "typo-project")).toBe(true);
  });

  it.each([
    ["no scope key", "name: someone-else\ndescription: an old template\n"],
    ["`scope: open`", "name: someone-else\nscope: open\n"],
    ["an empty scope", "name: someone-else\nscope:\n"],
    ["scope named only in a description", "name: someone-else\ndescription: 'scope: scoped'\n"],
    ["a file that does not parse and has no scope line", "name: [unclosed\n"],
  ])("leaves the department open: %s", (_why, text) => {
    writeDepartmentFile("plain-project", text);
    refreshOrg();
    expect(holds("eng-dev", "plain-project")).toBe(true);
    writeEmployeeFile("plain-project", "plain-dev");
    refreshOrg();
    expect(holds("plain-dev", "plain-project")).toBe(true);
    expect(holds("plain-dev", "engineering")).toBe(true);
  });
});
