import { beforeAll, describe, expect, it } from "vitest";
import { as, call, sessionOf, startScopedHarness } from "./department-scope-harness.js";

/**
 * PUT /api/work-items/:id/parent across department boundaries. side-project is
 * scoped, other-side dedicated, engineering open (see the harness).
 */

let workItems: Awaited<ReturnType<typeof startScopedHarness>>["workItems"];

beforeAll(async () => {
  ({ workItems } = await startScopedHarness());
});

const todoIn = (department: string, extra: Record<string, unknown> = {}) =>
  workItems.createWorkItem({ title: `in ${department}`, department, ...extra });

describe("PUT /api/work-items/:id/parent", () => {
  it("lets the operator re-home a sub-task inside a department and answers the new place", async () => {
    const a = todoIn("side-project");
    const b = todoIn("side-project");
    const child = workItems.createWorkItem({ title: "child", parentId: a.id });
    const moved = await call("PUT", `/api/work-items/${child.id}/parent`, { parentId: b.id });
    expect(moved.status).toBe(200);
    expect(moved.body).toMatchObject({ id: child.id, parentId: b.id, rootId: b.id, depth: 1, changed: true });
    const detached = await call("PUT", `/api/work-items/${child.id}/parent`, { parentId: null });
    expect(detached.body).toMatchObject({ parentId: null, rootId: child.id, depth: 0 });
  });

  it("refuses a bad body and an unknown Todo or parent", async () => {
    const item = todoIn("side-project");
    expect((await call("PUT", `/api/work-items/${item.id}/parent`, {})).status).toBe(400);
    expect((await call("PUT", `/api/work-items/${item.id}/parent`, { parentId: "nope" })).status).toBe(400);
    expect((await call("PUT", `/api/work-items/${item.id}/parent`, { parentId: "ZZZ-999" })).status).toBe(404);
    expect((await call("PUT", "/api/work-items/ZZZ-999/parent", { parentId: null })).status).toBe(404);
  });

  it("refuses to put a Todo across a scoped department's boundary, whatever the caller", async () => {
    const scoped = todoIn("side-project");
    const elsewhere = todoIn("other-side");
    const open = todoIn("engineering");
    const into = await call("PUT", `/api/work-items/${open.id}/parent`, { parentId: scoped.id });
    expect(into.status).toBe(409);
    expect(into.body).toMatchObject({ code: "department-boundary" });
    expect((await call("PUT", `/api/work-items/${scoped.id}/parent`, { parentId: elsewhere.id })).status).toBe(409);
    expect(workItems.getWorkItem(open.id)!.parentId).toBeNull();
  });

  it("holds a scoped session to its own department: a parent outside it reads as unknown", async () => {
    const dev = await sessionOf("side-dev");
    const mine = todoIn("side-project", { assignee: "side-dev" });
    const home = todoIn("side-project", { assignee: "side-dev" });
    const foreign = todoIn("other-side");
    const outside = await as(dev.id)("PUT", `/api/work-items/${mine.id}/parent`, { parentId: foreign.id });
    expect(outside.status).toBe(404);
    expect(outside.body).toEqual({ error: `parent Todo ${foreign.id} not found` });
    const hidden = await as(dev.id)("PUT", `/api/work-items/${foreign.id}/parent`, { parentId: null });
    expect(hidden.status).toBe(404);
    const inside = await as(dev.id)("PUT", `/api/work-items/${mine.id}/parent`, { parentId: home.id });
    expect(inside.status).toBe(200);
    expect(workItems.getWorkItem(mine.id)).toMatchObject({ parentId: home.id, rootId: home.id });
  });

  it("answers 409 for a move into an archived department, as create does", async () => {
    const { setDepartmentArchived } = await import("../../work-items/department-archive.js");
    const { initDb } = await import("../../shared/db.js");
    const root = todoIn("retired-side");
    const loose = workItems.createWorkItem({ title: "loose" });
    setDepartmentArchived(initDb(), "retired-side", true, "JIN");
    const refused = await call("PUT", `/api/work-items/${loose.id}/parent`, { parentId: root.id });
    expect(refused.status).toBe(409);
    expect(refused.body).toMatchObject({ code: "todo_department_archived", department: "retired-side" });
  });
});
