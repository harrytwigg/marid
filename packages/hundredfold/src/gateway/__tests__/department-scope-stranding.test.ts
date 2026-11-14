import { call, context, home, startScopedHarness } from "./department-scope-harness.js";
import fs from "node:fs";
import path from "node:path";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { initDb } from "../../shared/db.js";
import { createWorkItem, getWorkItem, listWorkItemEvents } from "../../work-items/store.js";
import { refreshOrg } from "../org-registry.js";
import { resetDepartmentFixtures, writeDepartmentFile, writeEmployeeFile } from "./department-fixtures.js";

/**
 * FR-015's stranding refusals: a change that would leave an open Todo with a holder who
 * may no longer hold it is refused with a 409, `code: "department-boundary"` and
 * `holders` naming each Todo and its holder. Nothing is written, in the registry or on disk.
 */

beforeAll(async () => { await startScopedHarness(); });
beforeEach(() => {
  // Each case starts with no open Todo held by anyone, so a refusal names only its own holders.
  initDb().prepare("UPDATE work_items SET status = 'cancelled' WHERE status NOT IN ('done', 'cancelled')").run();
  resetDepartmentFixtures();
  writeDepartmentFile("side-project", "name: side-project\nscope: scoped\n");
  writeDepartmentFile("other-side", "name: other-side\nscope: dedicated\n");
  writeEmployeeFile("side-project", "side-dev");
  writeEmployeeFile("side-project", "side-qa");
  writeEmployeeFile("other-side", "other-dev");
  writeEmployeeFile("engineering", "eng-dev");
  refreshOrg(context.getConfig());
});

const orgFile = (...parts: string[]) => path.join(home, "org", ...parts);
const read = (file: string) => fs.readFileSync(file, "utf-8");
const holding = (title: string, department: string, assignee: string, parentId?: string) => createWorkItem({ title, assignee, ...(parentId ? { parentId } : { department }) });

function expectStranding(response: { status: number; body: any }, holders: Array<{ todo: string; assignee: string }>, change: RegExp) {
  expect(response.status).toBe(409);
  expect(response.body.code).toBe("department-boundary");
  expect(response.body.holders).toEqual(holders);
  expect(response.body.error).toMatch(change);
  for (const holder of holders) expect(response.body.error).toContain(`${holder.todo} (held by ${holder.assignee})`);
}

describe("a Todo's department change", () => {
  it("is refused when it would strand the Todo's own holder and a sub-task's, and writes nothing", async () => {
    const root = holding("root", "side-project", "side-dev");
    const child = holding("child", "side-project", "side-qa", root.id);
    const before = { root: getWorkItem(root.id)!, child: getWorkItem(child.id)!, events: listWorkItemEvents(root.id).length };
    const refused = await call("PATCH", `/api/work-items/${root.id}`, { department: "engineering", expectedVersion: getWorkItem(root.id)!.version });
    expectStranding(refused, [{ todo: root.id, assignee: "side-dev" }, { todo: child.id, assignee: "side-qa" }], new RegExp(`moving ${root.id} to department "engineering" would strand`));
    expect(getWorkItem(root.id)).toEqual(before.root);
    expect(getWorkItem(child.id)).toEqual(before.child);
    expect(listWorkItemEvents(root.id)).toHaveLength(before.events);
  });

  it("goes through once the holders are reassigned", async () => {
    const root = holding("root", "side-project", "side-dev");
    await call("PATCH", `/api/work-items/${root.id}`, { assignee: "eng-dev", expectedVersion: root.version });
    const moved = await call("PATCH", `/api/work-items/${root.id}`, { department: "engineering", expectedVersion: getWorkItem(root.id)!.version });
    expect(moved.status).toBe(200);
    expect(getWorkItem(root.id)?.department).toBe("engineering");
  });
});

describe("a department's scope change", () => {
  it("is refused when it would strand an outside holder (scoped to dedicated), and the file is untouched", async () => {
    const item = holding("held", "side-project", "eng-dev");
    const file = orgFile("side-project", "department.yaml");
    const text = read(file);
    expectStranding(await call("PATCH", "/api/departments/side-project", { scope: "dedicated" }), [{ todo: item.id, assignee: "eng-dev" }], /making side-project dedicated would strand/i);
    expect(read(file)).toBe(text);
    const row = (await call("GET", "/api/departments")).body.departments.find((department: { slug: string }) => department.slug === "side-project");
    expect(row.scope).toBe("scoped");
  });

  it("is refused when it would strand a member of the department that is newly confined (open to scoped)", async () => {
    const company = createWorkItem({ title: "company work", assignee: "eng-dev" });
    expectStranding(await call("PATCH", "/api/departments/engineering", { scope: "scoped" }), [{ todo: company.id, assignee: "eng-dev" }], /making engineering scoped would strand/i);
    expect(fs.existsSync(orgFile("engineering", "department.yaml"))).toBe(false);
  });

  it("goes through once nothing would be stranded, and counts only Todos still open", async () => {
    const item = holding("held", "side-project", "eng-dev");
    await call("POST", `/api/work-items/${item.id}/status`, { status: "cancelled", note: "not needed" });
    const changed = await call("PATCH", "/api/departments/side-project", { scope: "dedicated" });
    expect(changed.status).toBe(200);
  });
});

describe("an employee's move", () => {
  it("is refused when it would confine a holder of Todos elsewhere (open to scoped), and the file is untouched", async () => {
    const item = createWorkItem({ title: "company work", assignee: "eng-dev" });
    const file = orgFile("engineering", "eng-dev.yaml");
    const text = read(file);
    expectStranding(await call("PATCH", "/api/org/employees/eng-dev", { department: "side-project" }), [{ todo: item.id, assignee: "eng-dev" }], /moving eng-dev to side-project would strand/i);
    expect(read(file)).toBe(text);
  });

  it("is refused when it would take a dedicated department's last holder out of it", async () => {
    const item = holding("held", "other-side", "other-dev");
    const file = orgFile("other-side", "other-dev.yaml");
    const text = read(file);
    expectStranding(await call("PATCH", "/api/org/employees/other-dev", { department: "engineering" }), [{ todo: item.id, assignee: "other-dev" }], /moving other-dev to engineering would strand/i);
    expect(read(file)).toBe(text);
  });
});
