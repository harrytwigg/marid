import { describe, expect, it } from "vitest";
import { api, ctx, emittedEvents, makeReq, makeRes, operatorHeaders, store, toolHeaders } from "./helpers/work-items-route-harness.js";
import { derivePrefixCandidate } from "../../work-items/departments.js";

// Archiving a department: it takes no new Todos from any path and leaves the
// listing, while every Todo already in it keeps its id and stays workable.
// The harness puts `platform-worker` in org department `platform`.

async function call(method: string, url: string, body?: unknown, headers: Record<string, string> = operatorHeaders) {
  const cap = makeRes();
  await api.handleApiRequest(makeReq(method, url, body, headers), cap.res, ctx);
  return cap;
}

type Row = { slug: string; prefix: string; selectable: boolean; archived: boolean; archivedAt: string | null };

async function listed(includeArchived = false): Promise<Map<string, Row>> {
  const res = await call("GET", includeArchived ? "/api/departments?includeArchived=true" : "/api/departments");
  expect(res.status).toBe(200);
  return new Map((res.body.departments as Row[]).map((row) => [row.slug, row]));
}

/** An agent session's capability headers; the route gate decides what it may do. */
const sessionCaller = () => toolHeaders("00000000-0000-4000-8000-00000000a5c1");

describe("archiving a department", () => {
  it("asks for confirmation while open Todos remain, then archives on confirm", async () => {
    const kept = (await call("POST", "/api/work-items", { title: "still open", department: "archive-me" })).body.workItem;
    const asked = await call("POST", "/api/departments/archive-me/archive", {});
    expect(asked.status).toBe(409);
    expect(asked.body.code).toBe("department-archive-confirm");
    expect(asked.body.openTodos).toBe(1);
    expect((await listed()).get("archive-me")?.archived).toBe(false);

    const done = await call("POST", "/api/departments/archive-me/archive", { confirm: true });
    expect(done.status).toBe(200);
    expect(done.body.department.archived).toBe(true);
    expect(emittedEvents).toContainEqual({ event: "company:changed", payload: { entity: "department", action: "archived", id: "archive-me" } });

    // The Todo it already held is untouched.
    const after = await call("GET", `/api/work-items/${kept.id}`);
    expect(after.status).toBe(200);
    expect(after.body.workItem.id).toBe(kept.id);
    expect(after.body.workItem.department).toBe("archive-me");
  });

  it("names the members an archive would leave behind", async () => {
    const asked = await call("POST", "/api/departments/platform/archive");
    expect(asked.status).toBe(409);
    expect(asked.body.members).toEqual(["platform-worker"]);
  });

  it("archives a department with nothing open and no members without asking", async () => {
    const done = store.createWorkItem({ title: "finished", department: "closed-out" });
    expect((await call("PUT", `/api/work-items/${done.id}/status`, { status: "cancelled" })).status).toBe(200);
    const res = await call("POST", "/api/departments/closed-out/archive");
    expect(res.status).toBe(200);
    expect(res.body.department.archived).toBe(true);
    // A slug nothing knows is not a department.
    expect((await call("POST", "/api/departments/never-heard-of/archive")).status).toBe(404);
  });

  it("leaves the default listing and reads as archived and unselectable when asked for", async () => {
    expect((await listed()).has("archive-me")).toBe(false);
    const row = (await listed(true)).get("archive-me");
    expect(row).toMatchObject({ archived: true, selectable: false });
    expect(row?.archivedAt).toEqual(expect.any(String));
  });

  it("refuses a create into it, with the department named", async () => {
    const refused = await call("POST", "/api/work-items", { title: "new work", department: "archive-me" });
    expect(refused.status).toBe(409);
    expect(refused.body.code).toBe("todo_department_archived");
    expect(refused.body.error).toContain('"archive-me" is archived');
  });

  it("refuses a sub-task under a Todo it holds, which would be a new Todo in it", async () => {
    const parent = store.listWorkItems({ department: "archive-me" })[0]!;
    const refused = await call("POST", "/api/work-items", { title: "child", parentId: parent.id });
    expect(refused.status).toBe(409);
    expect(refused.body.code).toBe("todo_department_archived");
  });

  it("refuses moving another Todo into it with the metadata pen", async () => {
    const elsewhere = store.createWorkItem({ title: "elsewhere", department: "still-open" });
    const refused = await call("PATCH", `/api/work-items/${elsewhere.id}`, { expectedVersion: elsewhere.version, department: "archive-me" });
    expect(refused.status).toBe(409);
    expect(refused.body.code).toBe("todo_department_archived");
    expect(store.getWorkItem(elsewhere.id)?.department).toBe("still-open");
  });

  it("keeps its Todos editable: title, status and comments", async () => {
    const item = store.listWorkItems({ department: "archive-me" })[0]!;
    const edited = await call("PATCH", `/api/work-items/${item.id}`, { expectedVersion: item.version, title: "renamed while archived" });
    expect(edited.status).toBe(200);
    const commented = await call("POST", `/api/work-items/${item.id}/comments`, { body: "still talking about it" });
    expect(commented.status).toBe(201);
    const moved = await call("PUT", `/api/work-items/${item.id}/status`, { status: "executing" });
    expect(moved.status).toBe(200);
    expect(moved.body.workItem.status).toBe("executing");
    // Listing by department still finds it.
    const found = await call("GET", "/api/work-items?department=archive-me");
    expect(found.body.workItems.map((row: { id: string }) => row.id)).toContain(item.id);
  });

  it("keeps a Todo where it is when its assignee's department is archived", async () => {
    await call("POST", "/api/departments/platform/archive", { confirm: true });
    const item = store.createWorkItem({ title: "assign me", department: "still-open" });
    const assigned = await call("POST", `/api/work-items/${item.id}/assign`, { assignee: "platform-worker" });
    expect(assigned.status).toBe(200);
    expect(assigned.body.workItem.assignee).toBe("platform-worker");
    expect(assigned.body.workItem.department).toBe("still-open");
  });

  it("mints a delegation to a member of an archived department with no department, as assignment would", async () => {
    const refused = await call("POST", "/api/delegations", { employee: "platform-worker", task: "do it", title: "delegated while archived", model: "gpt-5.5" });
    expect(refused.status).not.toBe(409);
    const minted = store.listWorkItems({}).find((item) => item.title === "delegated while archived");
    expect(minted?.department).toBeNull();
    expect(minted?.assignee).toBe("platform-worker");
  });

  it("keeps its prefix reserved from any new department", async () => {
    const prefix = (await listed(true)).get("archive-me")!.prefix;
    // A new slug that derives the same three letters.
    const twin = "archive-again";
    expect(derivePrefixCandidate(twin)).toBe(prefix);
    const created = store.createWorkItem({ title: "twin", department: twin });
    expect(created.id.startsWith(`${prefix}-`)).toBe(false);
  });

  it("is operator-only", async () => {
    const refused = await call("POST", "/api/departments/archive-me/unarchive", {}, sessionCaller());
    expect(refused.status).toBe(403);
    expect((await listed(true)).get("archive-me")?.archived).toBe(true);
  });

  it("un-archiving brings it back and takes new Todos again", async () => {
    const res = await call("POST", "/api/departments/archive-me/unarchive");
    expect(res.status).toBe(200);
    expect(res.body.department.archived).toBe(false);
    expect((await listed()).get("archive-me")).toMatchObject({ archived: false, selectable: true, archivedAt: null });
    const created = await call("POST", "/api/work-items", { title: "back in business", department: "archive-me" });
    expect(created.status).toBe(201);
    expect(created.body.workItem.department).toBe("archive-me");
  });

  it("refuses a confirm that is not a boolean", async () => {
    const res = await call("POST", "/api/departments/archive-me/archive", { confirm: "yes" });
    expect(res.status).toBe(400);
  });
});
