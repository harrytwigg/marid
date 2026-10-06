import { beforeEach, describe, expect, it } from "vitest";
import { refreshOrg } from "../org-registry.js";
import { assignWorkItem } from "../../work-items/assignment.js";
import { createWorkItem, getWorkItem } from "../../work-items/store.js";
import { DepartmentBoundaryError, setDepartmentScopeResolver } from "../../work-items/department-scope.js";
import { resetDepartmentFixtures, writeDepartmentFile, writeEmployeeFile } from "./department-fixtures.js";

/**
 * FR-003 and FR-004: assignment and sub-tasks never cross a non-open department's
 * boundary. The first case is the leak this feature closes: on `main`, assigning a
 * Todo in a department to an employee elsewhere moves the Todo to that employee's.
 */

function loadOrg(): void {
  writeEmployeeFile("engineering", "eng-dev");
  writeEmployeeFile("side-project", "side-dev");
  refreshOrg();
}

const todoIn = (department: string | null) => createWorkItem({ title: `in ${department ?? "the company"}`, department: department ?? undefined });
const assign = (id: string, assignee: string, assigneeDepartment: string | null) => assignWorkItem(id, assignee, assigneeDepartment, "operator");

beforeEach(() => resetDepartmentFixtures());

describe("assignment in a scoped department", () => {
  beforeEach(() => {
    writeDepartmentFile("side-project", "name: side-project\nscope: scoped\n");
    loadOrg();
  });

  it("keeps a Todo in its department when an employee elsewhere is assigned", () => {
    const item = todoIn("side-project");
    expect(assign(item.id, "eng-dev", "engineering")?.department).toBe("side-project");
    expect(getWorkItem(item.id)?.assignee).toBe("eng-dev");
  });

  it("keeps it for @operator, whose assignee department is none", () => {
    const item = todoIn("side-project");
    expect(assign(item.id, "@operator", null)?.department).toBe("side-project");
  });

  it("keeps it for an engine-only delegate that has no employee", () => {
    const item = todoIn("side-project");
    expect(assign(item.id, "codex", null)?.department).toBe("side-project");
  });

  it("keeps it for a member of the department", () => {
    const item = todoIn("side-project");
    expect(assign(item.id, "side-dev", "side-project")?.department).toBe("side-project");
  });

  it("judges a sub-task by its root and leaves its own department column alone", () => {
    const root = todoIn("side-project");
    const child = createWorkItem({ title: "child", parentId: root.id });
    expect(child.department).toBe("side-project");
    expect(assign(child.id, "eng-dev", "engineering")?.department).toBe("side-project");
  });

  it("does not move a sub-task whose own column already differs from its scoped root", () => {
    const root = todoIn("side-project");
    // A column an older build allowed: the sub-task is still in its root's scope (FR-002).
    setDepartmentScopeResolver(null);
    const stray = createWorkItem({ title: "stray", parentId: root.id, department: "engineering" });
    refreshOrg();
    expect(stray.department).toBe("engineering");
    expect(assign(stray.id, "eng-dev", "engineering")?.department).toBe("engineering");
    expect(assign(stray.id, "@operator", null)?.department).toBe("engineering");
  });
});

describe("assignment in a dedicated department", () => {
  it("keeps the department too", () => {
    writeDepartmentFile("side-project", "name: side-project\nscope: dedicated\n");
    loadOrg();
    const item = todoIn("side-project");
    expect(assign(item.id, "eng-dev", "engineering")?.department).toBe("side-project");
  });
});

describe("a refused department file", () => {
  it("keeps holding the department scoped, so an assignment still does not move the Todo", () => {
    writeDepartmentFile("side-project", "name: side-project\nscope: scoped\n");
    loadOrg();
    const item = todoIn("side-project");
    writeDepartmentFile("side-project", "name: side-project\nscope: [broken\n");
    refreshOrg();
    expect(assign(item.id, "eng-dev", "engineering")?.department).toBe("side-project");
  });
});

describe("open departments keep today's behaviour", () => {
  beforeEach(() => {
    writeDepartmentFile("side-project", "name: side-project\nscope: scoped\n");
    loadOrg();
  });

  it("moves a Todo into the assignee's department", () => {
    const item = todoIn("platform");
    expect(assign(item.id, "eng-dev", "engineering")?.department).toBe("engineering");
  });

  it("moves a company Todo into the assignee's department", () => {
    const item = todoIn(null);
    expect(assign(item.id, "eng-dev", "engineering")?.department).toBe("engineering");
  });

  it("clears the department for @operator", () => {
    const item = todoIn("platform");
    expect(assign(item.id, "@operator", null)?.department).toBeNull();
  });

  it("keeps an open Todo in its open department when the assignee is in a scoped one", () => {
    const item = todoIn("platform");
    expect(assign(item.id, "side-dev", "side-project")?.department).toBe("platform");
    expect(getWorkItem(item.id)?.assignee).toBe("side-dev");
  });

  it("keeps a company Todo out of a scoped department when its employee is assigned", () => {
    const item = todoIn(null);
    expect(assign(item.id, "side-dev", "side-project")?.department).toBeNull();
  });

  it("keeps a scoped Todo in its department when an open employee is assigned (the other direction)", () => {
    const item = todoIn("side-project");
    expect(assign(item.id, "eng-dev", "engineering")?.department).toBe("side-project");
  });

  it("behaves the same with no department.yaml anywhere", () => {
    resetDepartmentFixtures();
    writeEmployeeFile("engineering", "eng-dev");
    refreshOrg();
    const item = todoIn("side-project");
    expect(assign(item.id, "eng-dev", "engineering")?.department).toBe("engineering");
  });
});

describe("a sub-task's department (FR-004)", () => {
  beforeEach(() => {
    writeDepartmentFile("side-project", "name: side-project\nscope: scoped\n");
    loadOrg();
  });

  it("inherits a scoped root's department", () => {
    const root = todoIn("side-project");
    expect(createWorkItem({ title: "child", parentId: root.id }).department).toBe("side-project");
  });

  it("may name the root's department", () => {
    const root = todoIn("side-project");
    expect(createWorkItem({ title: "child", parentId: root.id, department: "side-project" }).department).toBe("side-project");
  });

  it("is refused when it names another department under a scoped root", () => {
    const root = todoIn("side-project");
    expect(() => createWorkItem({ title: "child", parentId: root.id, department: "engineering" })).toThrow(DepartmentBoundaryError);
    expect(() => createWorkItem({ title: "child", parentId: root.id, department: null as unknown as undefined })).toThrow(DepartmentBoundaryError);
  });

  it("is refused when it names a scoped department under a root elsewhere", () => {
    const root = todoIn("engineering");
    expect(() => createWorkItem({ title: "child", parentId: root.id, department: "side-project" })).toThrow(/stays in department "engineering"/);
    const company = todoIn(null);
    expect(() => createWorkItem({ title: "child", parentId: company.id, department: "side-project" })).toThrow(/stays in the company/);
  });

  it("is judged by the root for a grandchild", () => {
    const root = todoIn("side-project");
    const child = createWorkItem({ title: "child", parentId: root.id });
    expect(createWorkItem({ title: "grandchild", parentId: child.id }).department).toBe("side-project");
    expect(() => createWorkItem({ title: "grandchild", parentId: child.id, department: "engineering" })).toThrow(DepartmentBoundaryError);
  });

  it("follows the root when the parent's own column differs", () => {
    const root = todoIn("side-project");
    const child = createWorkItem({ title: "child", parentId: root.id });
    // Simulate an older build's stray column on the parent.
    setDepartmentScopeResolver(null);
    const stray = createWorkItem({ title: "stray", parentId: child.id, department: "engineering" });
    refreshOrg();
    expect(createWorkItem({ title: "under stray", parentId: stray.id }).department).toBe("side-project");
  });

  it("lets a top-level create name a scoped department (unscoped callers may)", () => {
    expect(createWorkItem({ title: "new", department: "side-project" }).department).toBe("side-project");
  });

  it("leaves sub-tasks between open departments alone", () => {
    const root = todoIn("platform");
    expect(createWorkItem({ title: "child", parentId: root.id, department: "engineering" }).department).toBe("engineering");
    expect(createWorkItem({ title: "child", parentId: root.id }).department).toBe("platform");
  });

  it("is enforced in the store, for a plugin (source connector) or cron create that passes a draft straight through", () => {
    const root = todoIn("side-project");
    expect(() => createWorkItem({ title: "plugin child", parentId: root.id, department: "engineering", source: "connector", sourceRef: "plugin:x:1" })).toThrow(DepartmentBoundaryError);
    expect(() => createWorkItem({ title: "cron child", parentId: root.id, department: "engineering", source: "cron", sourceRef: "cron:x:1" })).toThrow(DepartmentBoundaryError);
  });
});

describe("with no resolver injected", () => {
  it("treats every department as open", () => {
    setDepartmentScopeResolver(null);
    const root = createWorkItem({ title: "root", department: "side-project" });
    expect(createWorkItem({ title: "child", parentId: root.id, department: "engineering" }).department).toBe("engineering");
    expect(assign(root.id, "eng-dev", "engineering")?.department).toBe("engineering");
  });
});
