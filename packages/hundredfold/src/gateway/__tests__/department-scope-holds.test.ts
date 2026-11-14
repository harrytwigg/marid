import { beforeEach, describe, expect, it } from "vitest";
import { refreshOrg } from "../org-registry.js";
import { assignWorkItem } from "../../work-items/assignment.js";
import { DepartmentBoundaryError } from "../../work-items/department-scope.js";
import { createWorkItem, getWorkItem, listWorkItems, updateWorkItem, updateWorkItemConditional } from "../../work-items/store.js";
import { resetDepartmentFixtures, writeDepartmentFile, writeEmployeeFile } from "./department-fixtures.js";

/**
 * FR-015 at every SQL writer of `assignee` in the work-items layer: the same table of
 * (assignee, Todo department, may hold) is driven through each writer, so a writer that
 * skips the check fails its own row. A refusal is a boundary error and writes nothing.
 */

const OPERATOR = "@operator";

/** [assignee, the Todo's department, whether the assignee may hold it] */
const HOLDS: Array<[string, string | null, boolean]> = [
  ["side-dev", "side-project", true],
  ["side-dev", "engineering", false],
  ["side-dev", "other-side", false],
  ["side-dev", null, false],
  ["eng-dev", "side-project", true],
  ["eng-dev", "engineering", true],
  ["eng-dev", "other-side", false],
  ["other-dev", "other-side", true],
  ["other-dev", "side-project", false],
  [OPERATOR, "other-side", true],
  [OPERATOR, "side-project", true],
  ["ghost-employee", "side-project", true],
  ["ghost-employee", "other-side", false],
];

const fresh = (department: string | null) => createWorkItem({ title: "writer", ...(department ? { department } : {}) });

const WRITERS: Array<[string, (department: string | null, assignee: string) => string]> = [
  ["createWorkItem", (department, assignee) => createWorkItem({ title: "writer", assignee, ...(department ? { department } : {}) }).id],
  ["updateWorkItem", (department, assignee) => { const item = fresh(department); updateWorkItem(item.id, { assignee }, "operator"); return item.id; }],
  ["updateWorkItemConditional", (department, assignee) => {
    const item = fresh(department);
    updateWorkItemConditional(item.id, { assignee }, { expectedVersion: item.version, actor: "operator" });
    return item.id;
  }],
  ["assignWorkItem", (department, assignee) => { const item = fresh(department); assignWorkItem(item.id, assignee, null, "operator"); return item.id; }],
];

beforeEach(() => {
  resetDepartmentFixtures();
  writeDepartmentFile("side-project", "name: side-project\nscope: scoped\n");
  writeDepartmentFile("other-side", "name: other-side\nscope: dedicated\n");
  writeEmployeeFile("side-project", "side-dev");
  writeEmployeeFile("other-side", "other-dev");
  writeEmployeeFile("engineering", "eng-dev");
  refreshOrg();
});

describe.each(WRITERS)("%s", (_name, write) => {
  it.each(HOLDS)("%s on a Todo in %s: may hold = %s", (assignee, department, may) => {
    const before = listWorkItems({}).length;
    const held = () => listWorkItems({}).filter((row) => row.assignee === assignee).length;
    const heldBefore = held();
    if (may) {
      const id = write(department, assignee);
      expect(getWorkItem(id)?.assignee).toBe(assignee);
      return;
    }
    let refusal: unknown;
    try { write(department, assignee); } catch (error) { refusal = error; }
    expect(refusal).toBeInstanceOf(DepartmentBoundaryError);
    expect((refusal as DepartmentBoundaryError).code).toBe("department-boundary");
    expect((refusal as DepartmentBoundaryError).holders[0]?.assignee).toBe(assignee);
    // Nothing was written: no assignee anywhere, and a refused create left no Todo.
    expect(held()).toBe(heldBefore);
    expect(listWorkItems({}).length).toBe(_name === "createWorkItem" ? before : before + 1);
  });
});

describe("a sub-task is judged by its root", () => {
  const subtask = () => createWorkItem({ title: "child", parentId: createWorkItem({ title: "root", department: "engineering" }).id });

  it.each([
    ["updateWorkItem", (id: string) => updateWorkItem(id, { assignee: "side-dev" }, "operator")],
    ["updateWorkItemConditional", (id: string) => updateWorkItemConditional(id, { assignee: "side-dev" }, { expectedVersion: getWorkItem(id)!.version, actor: "operator" })],
    ["assignWorkItem", (id: string) => assignWorkItem(id, "side-dev", null, "operator")],
  ])("%s refuses a scoped employee on a sub-task whose root is elsewhere", (_name, write) => {
    const child = subtask();
    expect(() => write(child.id)).toThrow(DepartmentBoundaryError);
    expect(getWorkItem(child.id)?.assignee).toBeNull();
  });

  it("refuses it at create, naming the parent", () => {
    const root = createWorkItem({ title: "root", department: "engineering" });
    expect(() => createWorkItem({ title: "child", parentId: root.id, assignee: "side-dev" })).toThrow(new RegExp(`sub-task of ${root.id}`));
  });
});
