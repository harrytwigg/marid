import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { initDb } from "../../shared/db.js";
import { resolveJinnHome } from "../../shared/paths.js";
import { createWorkItem } from "../../work-items/store.js";
import { refreshOrg } from "../org-registry.js";
import { call, loadApi } from "./departments-api-harness.js";
import { resetDepartmentFixtures, writeDepartmentFile, writeEmployeeFile, writeSkill } from "./department-fixtures.js";

/** GET /api/departments and GET /api/departments/:slug, driven through the real handler as the operator. */


beforeAll(async () => {
  await loadApi();
  initDb();
});
afterAll(async () => {
  (await import("../../shared/db.js")).__closeDbForTest();
});
beforeEach(() => {
  resetDepartmentFixtures();
  initDb().prepare("DELETE FROM departments").run();
});

describe("GET /api/departments", () => {
  it("carries the definition on each row", async () => {
    writeSkill("review");
    writeDepartmentFile("side-project", "name: side-project\ndisplayName: Side project\ndescription: Friend's project\nscope: scoped\nskills: [review]\n");
    writeEmployeeFile("side-project", "side-dev");
    writeEmployeeFile("side-project", "side-qa");
    refreshOrg();
    createWorkItem({ title: "company side", department: "platform" });
    const { status, body } = await call("GET", "/api/departments");
    expect(status).toBe(200);
    const rows = Object.fromEntries(body.departments.map((row: any) => [row.slug, row]));
    expect(rows["side-project"]).toMatchObject({
      scope: "scoped",
      displayName: "Side project",
      description: "Friend's project",
      members: ["side-dev", "side-qa"],
      definitionFile: "org/side-project/department.yaml",
      definitionError: null,
      todoCount: 0,
    });
    expect(rows["side-project"].prefix).toMatch(/^[A-Z]{3}$/);
    expect(rows.platform).toMatchObject({ scope: "open", displayName: null, members: [], definitionFile: null, definitionError: null, todoCount: 1 });
  });

  it("puts a scoped department on the board before its first Todo, and an open one only once it has Todos", async () => {
    writeDepartmentFile("side-project", "name: side-project\nscope: dedicated\n");
    writeDepartmentFile("quiet", "name: quiet\n");
    refreshOrg();
    const slugs = (await call("GET", "/api/departments")).body.departments.map((row: any) => row.slug);
    expect(slugs).toContain("side-project");
    expect(slugs).not.toContain("quiet");
  });

  it("reports a refused file and the scope the department keeps", async () => {
    writeDepartmentFile("side-project", "name: side-project\nscope: scoped\n");
    refreshOrg();
    await call("GET", "/api/departments"); // it is on the board, with its prefix, before the file breaks
    writeDepartmentFile("side-project", "name: side-project\nscope: [broken\n");
    refreshOrg();
    const row = (await call("GET", "/api/departments")).body.departments.find((entry: any) => entry.slug === "side-project");
    expect(row.scope).toBe("scoped");
    expect(row.definitionError).toMatch(/does not parse/);
  });

  it("does not mint a permanent prefix, on a read, for a department whose file was refused", async () => {
    writeDepartmentFile("new-lab", "name: wrong\nscope: scoped\n");
    refreshOrg();
    const slugs = (await call("GET", "/api/departments")).body.departments.map((row: any) => row.slug);
    expect(slugs).not.toContain("new-lab");
    expect(initDb().prepare("SELECT 1 FROM departments WHERE slug = 'new-lab'").get()).toBeUndefined();
  });

  it("answers with no definition for an instance that has no department.yaml", async () => {
    createWorkItem({ title: "plain", department: "platform" });
    const rows = (await call("GET", "/api/departments")).body.departments;
    expect(rows.every((row: any) => row.scope === "open" && row.definitionFile === null && row.definitionError === null)).toBe(true);
  });
});

describe("GET /api/departments/:slug", () => {
  it("returns one department in full", async () => {
    writeSkill("review");
    writeDepartmentFile("side-project", "name: side-project\nscope: scoped\nskills: [review, missing]\nsharedNotes: [docs/shared]\ninstructions: department+company\n");
    writeEmployeeFile("side-project", "side-dev");
    refreshOrg();
    createWorkItem({ title: "one", department: "side-project" });
    const { status, body } = await call("GET", "/api/departments/side-project");
    expect(status).toBe(200);
    expect(body.department).toMatchObject({
      slug: "side-project",
      scope: "scoped",
      skills: ["review"],
      sharedNotes: ["docs/shared"],
      instructions: "department+company",
      members: ["side-dev"],
      todoCount: 1,
      spendUsd: 0,
      workdirs: [],
      definitionError: null,
    });
    expect(body.department.warnings.join(" ")).toMatch(/missing/);
  });

  it("answers for a department directory that has no file and no Todos", async () => {
    fs.mkdirSync(path.join(resolveJinnHome(), "org", "quiet"), { recursive: true });
    const { status, body } = await call("GET", "/api/departments/quiet");
    expect(status).toBe(200);
    expect(body.department).toMatchObject({ slug: "quiet", scope: "open", definitionFile: null, todoCount: 0, prefix: null });
  });

  it("answers for any directory name the registry reads, so a badged department always has its panel", async () => {
    writeDepartmentFile("Data_Science", "name: Data_Science\nscope: scoped\n");
    refreshOrg();
    const row = (await call("GET", "/api/departments")).body.departments.find((entry: any) => entry.slug === "Data_Science");
    expect(row.scope).toBe("scoped");
    const panel = await call("GET", "/api/departments/Data_Science");
    expect(panel.status).toBe(200);
    expect(panel.body.department.scope).toBe("scoped");
  });

  it("answers for a department that exists only as an employee's department field, which the org tree groups", async () => {
    writeEmployeeFile("engineering", "researcher", { department: "research" });
    refreshOrg();
    const panel = await call("GET", "/api/departments/research");
    expect(panel.status).toBe(200);
    expect(panel.body.department).toMatchObject({ slug: "research", scope: "open", definitionFile: null });
  });

  it("is 404 for a department that does not exist, and for a slug that is not one", async () => {
    expect((await call("GET", "/api/departments/nowhere")).status).toBe(404);
    expect((await call("GET", "/api/departments/..%2Fetc")).status).toBe(404);
  });
});

