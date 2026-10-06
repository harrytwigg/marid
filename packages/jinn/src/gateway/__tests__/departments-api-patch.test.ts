import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import yaml from "js-yaml";
import { initDb } from "../../shared/db.js";
import { resolveJinnHome } from "../../shared/paths.js";
import { operatorOnlyControlPlaneRoute } from "../control-plane-routes.js";
import { departmentScopeOf, refreshDepartments } from "../department-registry.js";
import { refreshOrg } from "../org-registry.js";
import { call, loadApi } from "./departments-api-harness.js";
import { resetDepartmentFixtures, writeDepartmentFile, writeEmployeeFile, writeSkill } from "./department-fixtures.js";

/** PATCH /api/departments/:slug, and the employee PATCH that must not cross a scope boundary. */

const fileOf = (slug: string) => path.join(resolveJinnHome(), "org", slug, "department.yaml");
const read = (slug: string) => yaml.load(fs.readFileSync(fileOf(slug), "utf-8")) as Record<string, unknown>;

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

describe("PATCH /api/departments/:slug", () => {
  it("is operator-only", () => {
    expect(operatorOnlyControlPlaneRoute("PATCH", "/api/departments/side-project")).toBe("department update");
    expect(operatorOnlyControlPlaneRoute("GET", "/api/departments/side-project")).toBeNull();
  });

  it("creates department.yaml in an existing department directory, and the scan reads it back", async () => {
    fs.mkdirSync(path.join(resolveJinnHome(), "org", "side-project"), { recursive: true });
    const { status, body } = await call("PATCH", "/api/departments/side-project", { displayName: "Side project", description: "Friend's project" });
    expect(status).toBe(200);
    expect(read("side-project")).toEqual({ name: "side-project", displayName: "Side project", description: "Friend's project" });
    expect(body.department).toMatchObject({ displayName: "Side project", definitionFile: "org/side-project/department.yaml" });
    refreshDepartments();
    expect(departmentScopeOf("side-project")).toBe("open");
  });

  it("merges into the existing file, keeps keys it does not know, and round-trips every field through the scan", async () => {
    writeSkill("review");
    writeDepartmentFile("side-project", "name: side-project\nscope: scoped\nowner: someone\n");
    refreshOrg();
    const patch = { displayName: "Side", skills: ["review"], sharedNotes: ["knowledge/shared"], instructions: "department+company", workdirs: [] };
    const { status, body } = await call("PATCH", "/api/departments/side-project", patch);
    expect(status).toBe(200);
    expect(read("side-project")).toMatchObject({ name: "side-project", scope: "scoped", owner: "someone", ...patch });
    expect(body.department).toMatchObject({ scope: "scoped", displayName: "Side", skills: ["review"], sharedNotes: ["knowledge/shared"], instructions: "department+company" });
    const again = await call("GET", "/api/departments/side-project");
    expect(again.body.department).toEqual(body.department);
  });

  it("removes a text field with null", async () => {
    writeDepartmentFile("side-project", "name: side-project\ndisplayName: Side\n");
    await call("PATCH", "/api/departments/side-project", { displayName: null });
    expect(read("side-project")).not.toHaveProperty("displayName");
  });

  it("writes atomically: no temp file is left behind", async () => {
    writeDepartmentFile("side-project", "name: side-project\n");
    await call("PATCH", "/api/departments/side-project", { description: "x" });
    expect(fs.readdirSync(path.dirname(fileOf("side-project"))).filter((name) => name.endsWith(".tmp"))).toEqual([]);
  });

  it("refuses a non-open scope until scoped employees are enforced", async () => {
    writeDepartmentFile("side-project", "name: side-project\n");
    for (const scope of ["scoped", "dedicated"]) {
      const { status, body } = await call("PATCH", "/api/departments/side-project", { scope });
      expect(status).toBe(400);
      expect(body.error).toMatch(/not available yet/);
    }
    expect(read("side-project")).toEqual({ name: "side-project" });
  });

  it("opens a scoped department when told scope: open", async () => {
    writeDepartmentFile("side-project", "name: side-project\nscope: scoped\n");
    refreshOrg();
    expect(departmentScopeOf("side-project")).toBe("scoped");
    const { status, body } = await call("PATCH", "/api/departments/side-project", { scope: "open" });
    expect(status).toBe(200);
    expect(body.department.scope).toBe("open");
    expect(departmentScopeOf("side-project")).toBe("open");
  });

  it("refuses a bad body and writes nothing", async () => {
    writeDepartmentFile("side-project", "name: side-project\n");
    const before = fs.readFileSync(fileOf("side-project"), "utf-8");
    const bad: Array<[string, unknown, RegExp]> = [
      ["an unknown field", { name: "other" }, /unknown field/],
      ["a bad scope", { scope: "sealed" }, /scope must be/],
      ["a bad list", { skills: "review" }, /list of text/],
      ["a bad instructions mode", { instructions: "all" }, /instructions must be/],
      ["a missing skill", { skills: ["no-such-skill"] }, /not an installed skill/],
      ["a bad shared-notes path", { sharedNotes: ["../secrets"] }, /outside knowledge/],
    ];
    for (const [, body, why] of bad) {
      const out = await call("PATCH", "/api/departments/side-project", body);
      expect(out.status).toBe(400);
      expect(out.body.error).toMatch(why);
    }
    expect((await call("PATCH", "/api/departments/side-project", [])).status).toBe(400);
    expect(fs.readFileSync(fileOf("side-project"), "utf-8")).toBe(before);
  });

  it("does not refuse an edit because of an entry it did not touch", async () => {
    writeDepartmentFile("side-project", "name: side-project\nscope: scoped\nskills: [missing]\n");
    const { status } = await call("PATCH", "/api/departments/side-project", { description: "x" });
    expect(status).toBe(200);
    expect(read("side-project")).toMatchObject({ description: "x", skills: ["missing"] });
  });

  it("refuses to rewrite a file that does not parse, and leaves it for the operator", async () => {
    writeDepartmentFile("side-project", "name: side-project\nscope: [broken\n");
    const out = await call("PATCH", "/api/departments/side-project", { description: "x" });
    expect(out.status).toBe(409);
    expect(out.body.error).toMatch(/fix it by hand/);
    expect(fs.readFileSync(fileOf("side-project"), "utf-8")).toContain("[broken");
  });

  it("is 404 when the department has no directory", async () => {
    expect((await call("PATCH", "/api/departments/nowhere", { description: "x" })).status).toBe(404);
  });
});

describe("PATCH /api/org/employees/:name across a scope boundary", () => {
  it("refuses a department change into or out of a scoped department, and leaves the file alone", async () => {
    writeDepartmentFile("side-project", "name: side-project\nscope: scoped\n");
    const file = writeEmployeeFile("engineering", "eng-dev");
    writeEmployeeFile("side-project", "side-dev");
    refreshOrg();
    const before = fs.readFileSync(file, "utf-8");
    const into = await call("PATCH", "/api/org/employees/eng-dev", { department: "side-project" });
    expect(into.status).toBe(409);
    expect(into.body.error).toMatch(/move the file by hand/);
    const out = await call("PATCH", "/api/org/employees/side-dev", { department: "engineering" });
    expect(out.status).toBe(409);
    expect(fs.readFileSync(file, "utf-8")).toBe(before);
    expect((await call("PATCH", "/api/org/employees/eng-dev", { department: "platform" })).status).toBe(200);
  });
});
