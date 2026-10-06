import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { Readable } from "node:stream";
import type { ServerResponse } from "node:http";
import yaml from "js-yaml";
import { initDb } from "../../shared/db.js";
import { resolveJinnHome } from "../../shared/paths.js";
import type { JinnConfig } from "../../shared/types.js";
import { createWorkItem } from "../../work-items/store.js";
import { operatorOnlyControlPlaneRoute } from "../control-plane-routes.js";
import { departmentScopeOf, refreshDepartments } from "../department-registry.js";
import { refreshOrg } from "../org-registry.js";
import { resetDepartmentFixtures, writeDepartmentFile, writeEmployeeFile, writeSkill } from "./department-fixtures.js";

/** GET /api/departments, GET and PATCH /api/departments/:slug, driven through the real handler as the operator. */

type Api = typeof import("../api.js");
let api: Api;

const config = {
  gateway: { port: 7799, host: "127.0.0.1" },
  engines: { default: "claude", claude: { bin: "claude", model: "sonnet" } },
  models: { claude: { default: "sonnet", models: [{ id: "sonnet", supportsEffort: false }] } },
  connectors: {},
  logging: { file: false, stdout: false, level: "error" },
  mcp: { gateway: { enabled: true } },
} as unknown as JinnConfig;

const context = {
  getConfig: () => config,
  connectors: new Map(),
  startTime: Date.now(),
  gatewayAuthToken: "test-token",
  emit: () => {},
  reloadOrg: () => {},
  sessionManager: { getEngine: () => undefined, getEngines: () => new Map() },
} as unknown as import("../api.js").ApiContext;

function capture() {
  let status = 200;
  const chunks: Buffer[] = [];
  const res = {
    writeHead(next: number) {
      status = next;
      return this;
    },
    setHeader() {
      return this;
    },
    end(chunk?: Buffer | string) {
      if (chunk) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    },
  } as unknown as ServerResponse;
  return {
    res,
    get status() {
      return status;
    },
    get body(): any {
      const raw = Buffer.concat(chunks).toString("utf-8");
      return raw ? JSON.parse(raw) : undefined;
    },
  };
}

async function call(method: string, url: string, body?: unknown) {
  const request = Object.assign(Readable.from(body === undefined ? [] : [Buffer.from(JSON.stringify(body))]), {
    method,
    url,
    headers: { host: "localhost", authorization: "Bearer test-token", "content-type": "application/json" },
  });
  const out = capture();
  await api.handleApiRequest(request as unknown as Parameters<Api["handleApiRequest"]>[0], out.res, context);
  return { status: out.status, body: out.body };
}

const fileOf = (slug: string) => path.join(resolveJinnHome(), "org", slug, "department.yaml");
const read = (slug: string) => yaml.load(fs.readFileSync(fileOf(slug), "utf-8")) as Record<string, unknown>;

beforeAll(async () => {
  api = await import("../api.js");
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
    writeDepartmentFile("side-project", "name: side-project\nscope: [broken\n");
    refreshOrg();
    const row = (await call("GET", "/api/departments")).body.departments.find((entry: any) => entry.slug === "side-project");
    expect(row.scope).toBe("scoped");
    expect(row.definitionError).toMatch(/does not parse/);
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

  it("is 404 for a department that does not exist, and for a slug that is not one", async () => {
    expect((await call("GET", "/api/departments/nowhere")).status).toBe(404);
    expect((await call("GET", "/api/departments/..%2Fetc")).status).toBe(404);
  });
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
