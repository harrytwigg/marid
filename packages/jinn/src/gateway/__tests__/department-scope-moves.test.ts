import { beforeEach, describe, expect, it } from "vitest";
import { refreshOrg } from "../org-registry.js";
import { createSession, getSession } from "../../sessions/registry.js";
import { DepartmentBoundaryError } from "../../work-items/department-scope.js";
import { createWorkItem, getWorkItem, linkSession, listWorkItemEvents, updateWorkItem, updateWorkItemConditional } from "../../work-items/store.js";
import { resetDepartmentFixtures, writeDepartmentFile, writeEmployeeFile } from "./department-fixtures.js";

/**
 * FR-004 and FR-015 on the metadata writers: the two dynamic update paths in the
 * store change a Todo's department and assignee directly, so the boundary is checked
 * there, for every caller. Also the create and link guards that back the routes.
 */

const conditional = (id: string, patch: Parameters<typeof updateWorkItem>[1]) =>
  updateWorkItemConditional(id, patch, { expectedVersion: getWorkItem(id)!.version, actor: "operator" });

const WRITERS = [
  ["updateWorkItem", (id: string, patch: Parameters<typeof updateWorkItem>[1]) => updateWorkItem(id, patch, "operator")],
  ["updateWorkItemConditional", (id: string, patch: Parameters<typeof updateWorkItem>[1]) => conditional(id, patch)],
] as const;

function loadOrg(scope: "scoped" | "dedicated" = "scoped"): void {
  writeDepartmentFile("side-project", `name: side-project\nscope: ${scope}\n`);
  writeEmployeeFile("engineering", "eng-dev");
  writeEmployeeFile("side-project", "side-dev");
  refreshOrg();
}

beforeEach(() => resetDepartmentFixtures());

describe.each(WRITERS)("%s and the department boundary", (_name, write) => {
  beforeEach(() => loadOrg());

  it("refuses moving a sub-task out of a non-open root", () => {
    const root = createWorkItem({ title: "root", department: "side-project" });
    const child = createWorkItem({ title: "child", parentId: root.id });
    expect(() => write(child.id, { department: "engineering" })).toThrow(DepartmentBoundaryError);
    expect(() => write(child.id, { department: null })).toThrow(/shares its root's department/);
    expect(getWorkItem(child.id)?.department).toBe("side-project");
  });

  it("refuses moving a sub-task of an open root into a non-open department", () => {
    const root = createWorkItem({ title: "root", department: "engineering" });
    const child = createWorkItem({ title: "child", parentId: root.id });
    expect(() => write(child.id, { department: "side-project" })).toThrow(DepartmentBoundaryError);
    expect(getWorkItem(child.id)?.department).toBe("engineering");
  });

  it("still lets a sub-task move between open departments", () => {
    const root = createWorkItem({ title: "root", department: "engineering" });
    const child = createWorkItem({ title: "child", parentId: root.id });
    expect(write(child.id, { department: "platform" })).toBeTruthy();
    expect(getWorkItem(child.id)?.department).toBe("platform");
  });

  it("moves a root's sub-tasks with it across the boundary, so the tree never straddles", () => {
    const root = createWorkItem({ title: "root", department: "side-project" });
    const child = createWorkItem({ title: "child", parentId: root.id });
    const grandchild = createWorkItem({ title: "grandchild", parentId: child.id });
    write(root.id, { department: "engineering" });
    expect([root, child, grandchild].map((item) => getWorkItem(item.id)?.department)).toEqual(["engineering", "engineering", "engineering"]);
    expect(listWorkItemEvents(child.id).some((event) => event.kind === "note" && event.detail?.movedWithRoot === root.id)).toBe(true);
  });

  it("refuses moving a root when a sub-task already sits elsewhere and would straddle, naming it", () => {
    const root = createWorkItem({ title: "root", department: "engineering" });
    const stray = createWorkItem({ title: "stray", parentId: root.id, department: "platform" });
    expect(() => write(root.id, { department: "side-project" })).toThrow(new RegExp(`${stray.id} \\(department "platform"\\)`));
    expect(getWorkItem(root.id)?.department).toBe("engineering");
    expect(getWorkItem(stray.id)?.department).toBe("platform");
  });

  it("leaves sub-tasks alone when a root moves between open departments", () => {
    const root = createWorkItem({ title: "root", department: "engineering" });
    const child = createWorkItem({ title: "child", parentId: root.id });
    write(root.id, { department: "platform" });
    expect(getWorkItem(child.id)?.department).toBe("engineering");
  });

  it("refuses a move that would strand a holder, and names the Todo and the holder", () => {
    const root = createWorkItem({ title: "root", department: "side-project", assignee: "side-dev" });
    const child = createWorkItem({ title: "child", parentId: root.id, assignee: "side-dev" });
    let error: unknown;
    try {
      write(root.id, { department: "engineering" });
    } catch (err) {
      error = err;
    }
    expect(error).toBeInstanceOf(DepartmentBoundaryError);
    expect((error as DepartmentBoundaryError).holders).toEqual([{ todo: root.id, assignee: "side-dev" }, { todo: child.id, assignee: "side-dev" }]);
    expect(getWorkItem(root.id)?.department).toBe("side-project");
  });

  it("does not count a holder the same write reassigns", () => {
    const root = createWorkItem({ title: "root", department: "side-project", assignee: "side-dev" });
    write(root.id, { department: "engineering", assignee: "eng-dev" });
    expect(getWorkItem(root.id)).toMatchObject({ department: "engineering", assignee: "eng-dev" });
  });

  it("refuses an assignee who may not hold the Todo", () => {
    const company = createWorkItem({ title: "company" });
    expect(() => write(company.id, { assignee: "side-dev" })).toThrow(/confined to department "side-project"/);
    expect(getWorkItem(company.id)?.assignee).toBeNull();
  });

  it("records an escalation on a Todo a bound session was working when it leaves the department", () => {
    const root = createWorkItem({ title: "root", department: "side-project" });
    const session = createSession({ engine: "claude", source: "web", sourceRef: `web:${root.id}`, employee: "side-dev" });
    expect(getSession(session.id)?.scopeDepartment).toBe("side-project");
    linkSession(root.id, session.id);
    write(root.id, { department: "engineering" });
    const escalation = listWorkItemEvents(root.id).find((event) => event.kind === "escalated");
    expect(escalation?.detail).toMatchObject({ reason: "left-department", department: "side-project", movedTo: "engineering", sessions: [session.id] });
  });
});

describe("a dedicated department", () => {
  beforeEach(() => loadOrg("dedicated"));

  it("refuses a move into it that would leave an unscoped employee holding one of its Todos", () => {
    const root = createWorkItem({ title: "root", department: "engineering", assignee: "eng-dev" });
    expect(() => updateWorkItem(root.id, { department: "side-project" }, "operator")).toThrow(/held by eng-dev/);
  });

  it("refuses an unscoped employee as the assignee", () => {
    const item = createWorkItem({ title: "dedicated", department: "side-project" });
    expect(() => conditional(item.id, { assignee: "eng-dev" })).toThrow(/dedicated department "side-project"/);
    expect(conditional(item.id, { assignee: "side-dev" })?.item.assignee).toBe("side-dev");
  });
});

describe("creates and links", () => {
  beforeEach(() => loadOrg());

  it("refuses a create that names an assignee who may not hold the Todo", () => {
    expect(() => createWorkItem({ title: "company", assignee: "side-dev" })).toThrow(DepartmentBoundaryError);
    const root = createWorkItem({ title: "root", department: "side-project" });
    expect(createWorkItem({ title: "child", parentId: root.id, assignee: "side-dev" }).assignee).toBe("side-dev");
  });

  it("binds only a scoped employee's session", () => {
    expect(createSession({ engine: "claude", source: "web", sourceRef: "web:a", employee: "eng-dev" }).scopeDepartment).toBeNull();
    expect(createSession({ engine: "claude", source: "web", sourceRef: "web:b" }).scopeDepartment).toBeNull();
    expect(createSession({ engine: "claude", source: "web", sourceRef: "web:c", employee: "side-dev" }).scopeDepartment).toBe("side-project");
  });

  it("refuses linking a bound session to a Todo outside its department, whatever the role", () => {
    const company = createWorkItem({ title: "company" });
    const session = createSession({ engine: "claude", source: "web", sourceRef: "web:d", employee: "side-dev" });
    expect(() => linkSession(company.id, session.id, null, "review")).toThrow(/bound to department "side-project"/);
    expect(getSession(session.id)?.workItemId).toBeNull();
  });

  it("refuses an execute link for an employee who may not hold the Todo, and allows a review link", () => {
    writeDepartmentFile("side-project", "name: side-project\nscope: dedicated\n");
    refreshOrg();
    const item = createWorkItem({ title: "dedicated", department: "side-project" });
    const reviewer = createSession({ engine: "claude", source: "web", sourceRef: "web:e", employee: "eng-dev" });
    expect(() => linkSession(item.id, reviewer.id)).toThrow(DepartmentBoundaryError);
    linkSession(item.id, reviewer.id, null, "review");
    expect(getSession(reviewer.id)?.workItemId).toBe(item.id);
  });
});
