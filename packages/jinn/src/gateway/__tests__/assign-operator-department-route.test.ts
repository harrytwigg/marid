import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { call, startRouteHarness, stopRouteHarness } from "./todo-route-harness.js";

/**
 * Assignment over the route: an employee brings their department, the operator
 * has none and so leaves the Todo on its board. The harness roster holds one
 * employee, in `platform`.
 */

beforeAll(async () => { await startRouteHarness(); });
afterAll(stopRouteHarness);

const departmentOf = async (id: string) => (await call("GET", `/api/work-items/${id}`)).body.workItem.department;

describe("POST /api/work-items/:id/assign and the Todo's department", () => {
  it("leaves a Todo on its board when the operator is assigned", async () => {
    const created = await call("POST", "/api/work-items", { title: "board todo", department: "engineering" });
    const id = created.body.workItem.id;
    expect(await departmentOf(id)).toBe("engineering");

    const assigned = await call("POST", `/api/work-items/${id}/assign`, { assignee: "@operator" });

    expect(assigned.status).toBe(200);
    expect(assigned.body.workItem).toMatchObject({ assignee: "@operator", department: "engineering" });
    expect(await departmentOf(id)).toBe("engineering");
  });

  it("moves a Todo into an employee's department, as before", async () => {
    const created = await call("POST", "/api/work-items", { title: "moves to employee", department: "engineering" });
    const id = created.body.workItem.id;

    const assigned = await call("POST", `/api/work-items/${id}/assign`, { assignee: "route-worker" });

    expect(assigned.status).toBe(200);
    expect(assigned.body.workItem).toMatchObject({ assignee: "route-worker", department: "platform" });
    expect(await departmentOf(id)).toBe("platform");
  });

  it("keeps the employee's department when the Todo then goes to the operator", async () => {
    const created = await call("POST", "/api/work-items", { title: "employee then operator", department: "engineering" });
    const id = created.body.workItem.id;
    await call("POST", `/api/work-items/${id}/assign`, { assignee: "route-worker" });

    await call("POST", `/api/work-items/${id}/assign`, { assignee: "@operator" });

    expect(await departmentOf(id)).toBe("platform");
  });

  it("leaves a Todo with no department without one for the operator", async () => {
    const created = await call("POST", "/api/work-items", { title: "company todo" });
    const id = created.body.workItem.id;

    await call("POST", `/api/work-items/${id}/assign`, { assignee: "@operator" });

    expect(await departmentOf(id)).toBeNull();
  });
});
