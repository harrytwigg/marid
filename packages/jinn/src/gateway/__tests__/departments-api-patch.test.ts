import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import yaml from "js-yaml";
import { initDb } from "../../shared/db.js";
import { resolveJinnHome } from "../../shared/paths.js";
import { operatorOnlyControlPlaneRoute } from "../control-plane-routes.js";
import { departmentScopeOf, refreshDepartments } from "../department-registry.js";
import { refreshOrg } from "../org-registry.js";
import { assignWorkItem } from "../../work-items/assignment.js";
import { createWorkItem } from "../../work-items/store.js";
import { call, loadApi, takeOrgReloads } from "./departments-api-harness.js";
import { resetDepartmentFixtures, writeDepartmentFile, writeEmployeeFile, writeSkill } from "./department-fixtures.js";

/** PATCH /api/departments/:slug, and the employee PATCH that must not cross a scope boundary. */

// Counts every org re-scan, the harness's reload hook included, so a handler that re-scans beside the hook is caught.
vi.mock("../org-registry.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../org-registry.js")>();
  return { ...actual, refreshOrg: vi.fn(actual.refreshOrg) };
});

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

  it("reloads the gateway's org once after a write, and not after a refused one", async () => {
    writeDepartmentFile("side-project", "name: side-project\n");
    refreshOrg();
    takeOrgReloads();
    vi.mocked(refreshOrg).mockClear();
    expect((await call("PATCH", "/api/departments/side-project", { displayName: "Side" })).status).toBe(200);
    expect(takeOrgReloads()).toBe(1);
    expect(refreshOrg).toHaveBeenCalledTimes(1);
    vi.mocked(refreshOrg).mockClear();
    expect((await call("PATCH", "/api/departments/side-project", { instructions: "nonsense" })).status).toBe(400);
    expect(takeOrgReloads()).toBe(0);
    expect(refreshOrg).not.toHaveBeenCalled();
  });

  it("refuses a working directory an employee's Claude profile lives in, and writes nothing", async () => {
    // Beside the instance home: the test temp directory sits inside it, which is a protected tree.
    const repo = fs.realpathSync(fs.mkdtempSync(path.join(path.dirname(resolveJinnHome()), "jinn-department-profile-")));
    try {
      fs.mkdirSync(path.join(repo, "profile"));
      execFileSync("git", ["init", "-q", repo], { stdio: "ignore" });
      writeDepartmentFile("side-project", "name: side-project\n");
      expect((await call("PATCH", "/api/departments/side-project", { workdirs: [repo] })).status).toBe(200);
      writeEmployeeFile("engineering", "friend", { claudeConfigDir: path.join(repo, "profile") });
      const before = fs.readFileSync(fileOf("side-project"), "utf-8");
      const refused = await call("PATCH", "/api/departments/side-project", { workdirs: [repo, path.join(repo, "profile")] });
      expect(refused.status).toBe(400);
      expect(refused.body.error).toMatch(/workdirs: dropped/);
      expect(fs.readFileSync(fileOf("side-project"), "utf-8")).toBe(before);
    } finally {
      fs.rmSync(repo, { recursive: true, force: true });
    }
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

  it("sets a non-open scope now that scoped employees are enforced", async () => {
    writeDepartmentFile("side-project", "name: side-project\n");
    for (const scope of ["scoped", "dedicated"] as const) {
      const { status, body } = await call("PATCH", "/api/departments/side-project", { scope });
      expect(status).toBe(200);
      expect(body.department.scope).toBe(scope);
      expect(read("side-project")).toEqual({ name: "side-project", scope });
    }
  });

  it("refuses a scope change that would strand a holder, names them, and writes nothing (FR-015)", async () => {
    writeDepartmentFile("side-project", "name: side-project\nscope: scoped\n");
    writeEmployeeFile("engineering", "eng-dev");
    writeEmployeeFile("side-project", "side-dev");
    refreshOrg();
    const held = createWorkItem({ title: "held", department: "side-project", assignee: "eng-dev" });
    const { status, body } = await call("PATCH", "/api/departments/side-project", { scope: "dedicated" });
    expect(status).toBe(409);
    expect(body).toMatchObject({ code: "department-boundary", holders: [{ todo: held.id, assignee: "eng-dev" }] });
    expect(body.error).toMatch(new RegExp(`${held.id} \\(held by eng-dev\\)`));
    expect(read("side-project")).toEqual({ name: "side-project", scope: "scoped" });
    assignWorkItem(held.id, "side-dev", "side-project", "operator");
    expect((await call("PATCH", "/api/departments/side-project", { scope: "dedicated" })).status).toBe(200);
  });

  it("refuses scoping an open department whose members hold Todos elsewhere", async () => {
    writeDepartmentFile("side-project", "name: side-project\n");
    writeEmployeeFile("side-project", "side-dev");
    refreshOrg();
    const held = createWorkItem({ title: "company", assignee: "side-dev" });
    const { status, body } = await call("PATCH", "/api/departments/side-project", { scope: "scoped" });
    expect(status).toBe(409);
    expect(body.holders).toEqual([{ todo: held.id, assignee: "side-dev" }]);
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
