import fs from "node:fs";
import path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { api, ctx, makeReq, makeRes, operatorHeaders, store } from "./helpers/work-items-route-harness.js";

// JIN-1: the routes under a closed `gateway.todoDepartments` policy. The
// harness's workers sit in org departments `platform` / `marketing`, neither
// of which is allowed — so any leak of the org department shows up here.
beforeAll(() => {
  fs.writeFileSync(
    path.join(process.env.JINN_HOME!, "config.yaml"),
    "engines:\n  default: claude\n  claude: {}\ngateway:\n  port: 7777\n  host: 127.0.0.1\n  todoDepartments:\n    allowed: [labs, jinn, general]\n    default: general\n",
    "utf8",
  );
});

async function call(method: string, url: string, body?: unknown) {
  const cap = makeRes();
  await api.handleApiRequest(makeReq(method, url, body, operatorHeaders), cap.res, ctx);
  return cap;
}

describe("Todo routes under gateway.todoDepartments", () => {
  it("create refuses an unlisted department and defaults an unclassified one", async () => {
    const stray = await call("POST", "/api/work-items", { title: "stray", department: "platform" });
    expect(stray.status).toBe(400);
    expect(String(stray.body.error)).toContain("labs, jinn, general");

    const unclassified = await call("POST", "/api/work-items", { title: "unclassified" });
    expect(unclassified.status).toBe(201);
    expect(unclassified.body.workItem.department).toBe("general");
  });

  it("assigning keeps the Todo's department rather than taking the assignee's", async () => {
    const created = await call("POST", "/api/work-items", { title: "client work", department: "labs" });
    const id = created.body.workItem.id as string;
    expect(id.startsWith("LAB-")).toBe(true);
    const assigned = await call("POST", `/api/work-items/${id}/assign`, { assignee: "platform-worker" });
    expect(assigned.status).toBe(200);
    expect(assigned.body.workItem.assignee).toBe("platform-worker");
    expect(assigned.body.workItem.department).toBe("labs");
  });

  it("the metadata pen answers an unlisted department with a typed 400", async () => {
    const item = store.createWorkItem({ title: "reclassify me", department: "general" });
    const refused = await call("PATCH", `/api/work-items/${item.id}`, { expectedVersion: item.version, department: "marketing" });
    expect(refused.status).toBe(400);
    expect(refused.body.code).toBe("todo_invalid_department");

    const moved = await call("PATCH", `/api/work-items/${item.id}`, { expectedVersion: item.version, department: "jinn" });
    expect(moved.status).toBe(200);
    expect(moved.body.workItem.department).toBe("jinn");
    expect(moved.body.workItem.id).toBe(item.id);
  });

  it("will not archive the default department every unclassified create lands in", async () => {
    const refused = await call("POST", "/api/departments/general/archive", { confirm: true });
    expect(refused.status).toBe(409);
    expect(refused.body.code).toBe("department-default");
  });

  it("an archived allowed department is unselectable and refuses creates", async () => {
    expect((await call("POST", "/api/departments/labs/archive", { confirm: true })).status).toBe(200);
    const listed = await call("GET", "/api/departments?includeArchived=true");
    const labs = (listed.body.departments as Array<{ slug: string; selectable: boolean; archived: boolean }>).find((d) => d.slug === "labs");
    expect(labs).toMatchObject({ selectable: false, archived: true });
    const refused = await call("POST", "/api/work-items", { title: "into labs", department: "labs" });
    expect(refused.status).toBe(409);
    expect(refused.body.code).toBe("todo_department_archived");
    expect((await call("POST", "/api/departments/labs/unarchive")).status).toBe(200);
  });

  it("the department listing offers every configured slug, used or not", async () => {
    const listed = await call("GET", "/api/departments");
    expect(listed.status).toBe(200);
    const bySlug = new Map((listed.body.departments as Array<{ slug: string; selectable: boolean }>).map((d) => [d.slug, d]));
    for (const slug of ["labs", "jinn", "general"]) expect(bySlug.get(slug)?.selectable).toBe(true);
    for (const d of bySlug.values()) {
      if (!["labs", "jinn", "general"].includes(d.slug)) expect(d.selectable).toBe(false);
    }
  });
});
