import { describe, it, expect, beforeAll, beforeEach, afterAll } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import yaml from "js-yaml";
import { Readable } from "node:stream";
import type { ServerResponse } from "node:http";
import { CALLER_SESSION_CAPABILITY_HEADER, CALLER_SESSION_HEADER, ensureSessionCapability, TOOL_CALL_HEADER, TOOL_CALL_HEADER_VALUE } from "../../mcp/identity.js";

/**
 * Route-level tests for projects: the registry routes and their YAML writes, a
 * Todo created in a project straight after the project, the `project` list
 * filter and wire field, and moving a Todo between projects. Drives
 * handleApiRequest directly against a throwaway JINN_HOME.
 */

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "jinn-projects-api-"));
process.env.JINN_HOME = tmp;
fs.mkdirSync(path.join(tmp, "org"), { recursive: true });
fs.writeFileSync(
  path.join(tmp, "org", "platform-worker.yaml"),
  "name: platform-worker\ndisplayName: Platform Worker\ndepartment: platform\nrank: employee\nengine: codex\nmodel: default\npersona: Projects-route-test worker.\n",
);

type Api = typeof import("../api.js");
let api: Api;
let reg: typeof import("../../sessions/registry.js");
let db: import("better-sqlite3").Database;
const emitted: Array<{ event: string; payload: Record<string, unknown> }> = [];
const projectsDir = path.join(tmp, "projects");

function makeRes() {
  let status = 200;
  const chunks: Buffer[] = [];
  const res = {
    writeHead(s: number) { status = s; return this; },
    setHeader() { return this; },
    end(buf?: Buffer | string) { if (buf) chunks.push(Buffer.isBuffer(buf) ? buf : Buffer.from(buf)); },
  } as unknown as ServerResponse;
  return {
    res,
    get status() { return status; },
    get body() {
      const raw = Buffer.concat(chunks).toString("utf-8");
      try { return JSON.parse(raw); } catch { return raw; }
    },
  };
}

const ctx = {
  getConfig: () => ({ gateway: {}, engines: {} }),
  connectors: new Map(),
  startTime: Date.now(),
  gatewayAuthToken: "test-token",
  emit: (event: string, payload: Record<string, unknown>) => emitted.push({ event, payload }),
  sessionManager: { getQueue: () => ({ getPendingCount: () => 0, getTransportState: (_k: string, status: string) => status }) },
} as unknown as import("../api.js").ApiContext;

const operator = { authorization: "Bearer test-token" };

async function call(method: string, urlPath: string, body?: unknown, headers: Record<string, string> = operator) {
  const cap = makeRes();
  const req = Object.assign(Readable.from(body !== undefined ? [Buffer.from(JSON.stringify(body))] : []), {
    method, url: urlPath, headers: { host: "localhost", "content-type": "application/json", ...headers },
  }) as unknown as Parameters<Api["handleApiRequest"]>[0];
  await api.handleApiRequest(req, cap.res, ctx);
  return cap;
}

const newProject = async (name: string, extra: Record<string, unknown> = {}) => {
  const created = await call("POST", "/api/projects", { name, ...extra });
  expect(created.status).toBe(201);
  return created.body.project as { id: string; name: string; file: string };
};
const newTodo = async (title: string, extra: Record<string, unknown> = {}) => call("POST", "/api/work-items", { title, ...extra });
const ids = (page: { body: { workItems: Array<{ id: string }> } }) => page.body.workItems.map((w) => w.id).sort();
const events = (id: string, kind: string) =>
  (db.prepare("SELECT detail FROM work_item_events WHERE work_item_id = ? AND kind = ?").all(id, kind) as Array<{ detail: string | null }>)
    .map((row) => (row.detail ? JSON.parse(row.detail) : null));

beforeAll(async () => {
  api = await import("../api.js");
  reg = await import("../../sessions/registry.js");
  db = (await import("../../shared/db.js")).initDb();
});
beforeEach(async () => {
  fs.rmSync(projectsDir, { recursive: true, force: true });
  (await import("../project-registry.js")).resetProjectRegistryForTests();
});
afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));

describe("project registry routes", () => {
  it("lists nothing, and creates no directory, when no project exists", async () => {
    const listed = await call("GET", "/api/projects");
    expect(listed.body).toEqual({ projects: [] });
    expect(fs.existsSync(projectsDir)).toBe(false);
  });

  it("writes a new YAML file with a generated id, seeds its state note, and loads it before responding", async () => {
    const project = await newProject("Garden Planner", { description: "Allotment layouts" });
    expect(project.id).toMatch(/^prj_[0-9a-f]{12}$/);
    expect(project.file).toBe("projects/garden-planner.yaml");
    const onDisk = yaml.load(fs.readFileSync(path.join(tmp, project.file), "utf-8")) as Record<string, unknown>;
    expect(onDisk).toMatchObject({ id: project.id, name: "Garden Planner", archived: false, dedicated: false, instructions: "project" });
    expect(fs.readFileSync(path.join(tmp, "knowledge/projects", project.id, "state.md"), "utf-8")).toMatch(/^# Garden Planner — Current State\n\n## Current Workings\n/);
    expect(fs.readdirSync(projectsDir).filter((f) => f.endsWith(".tmp"))).toEqual([]);
    expect((await call("GET", `/api/projects/${project.id}`)).body.project).toMatchObject({ name: "Garden Planner", known: true, todoCount: 0, members: [], dedicated: false });
    expect(emitted.at(-1)).toMatchObject({ event: "company:changed", payload: { entity: "project", action: "created", id: project.id } });
  });

  it("refuses a duplicate or reserved name, and a bad shape", async () => {
    await newProject("Boat Club");
    expect((await call("POST", "/api/projects", { name: "boat club" })).status).toBe(409);
    expect((await call("POST", "/api/projects", { name: "None" })).status).toBe(400);
    expect((await call("POST", "/api/projects", {})).status).toBe(400);
    expect((await call("POST", "/api/projects", { name: "X", extra: 1 })).status).toBe(400);
    expect((await call("POST", "/api/projects", { name: "Y", skills: ["no-such-skill"] })).status).toBe(400);
  });

  it("round-trips a PATCH through the scan, keeping the id and any keys the file carried", async () => {
    const project = await newProject("Boat Club");
    const file = path.join(tmp, project.file);
    fs.writeFileSync(file, fs.readFileSync(file, "utf-8") + "custom: kept\n");
    const patched = await call("PATCH", `/api/projects/${project.id}`, { name: "Sailing Club", description: "Regattas", archived: true });
    expect(patched.status).toBe(200);
    expect(patched.body.project).toMatchObject({ id: project.id, name: "Sailing Club", description: "Regattas", archived: true });
    expect(yaml.load(fs.readFileSync(file, "utf-8"))).toMatchObject({ id: project.id, custom: "kept", name: "Sailing Club" });
    expect((await call("PATCH", "/api/projects/prj_000000000000", { description: "x" })).status).toBe(404);
    const other = await newProject("Choir");
    expect((await call("PATCH", `/api/projects/${other.id}`, { name: "sailing club" })).status).toBe(409);
  });

  it("refuses a PATCH, with a 400, while the file on disk has a YAML syntax error", async () => {
    const project = await newProject("Syntax Slip");
    const file = path.join(tmp, project.file);
    const broken = "id: [unclosed\nname: Syntax Slip\n";
    fs.writeFileSync(file, broken);
    const patched = await call("PATCH", `/api/projects/${project.id}`, { description: "x" });
    expect(patched.status).toBe(400);
    expect(patched.body.error).toMatch(/fix the YAML first/);
    expect(fs.readFileSync(file, "utf-8")).toBe(broken);
    expect((await call("GET", `/api/projects/${project.id}`)).body.project.name).toBe("Syntax Slip"); // last good definition still served
  });

  it("refuses a PATCH, with a 400, when the file's id was edited to something else", async () => {
    const project = await newProject("Renumbered");
    const file = path.join(tmp, project.file);
    const edited = fs.readFileSync(file, "utf-8").replace(project.id, "prj_not-an-id");
    fs.writeFileSync(file, edited);
    const patched = await call("PATCH", `/api/projects/${project.id}`, { description: "x" });
    expect(patched.status).toBe(400);
    expect(patched.body.error).toMatch(/fix the YAML first/);
    expect(fs.readFileSync(file, "utf-8")).toBe(edited);
  });

  it("refuses writes to dedicated, but loads and preserves a hand-edited one", async () => {
    expect((await call("POST", "/api/projects", { name: "Locked", dedicated: true })).status).toBe(400);
    const project = await newProject("Hand Edited");
    const patchedDedicated = await call("PATCH", `/api/projects/${project.id}`, { dedicated: true });
    expect(patchedDedicated.status).toBe(400);
    expect(patchedDedicated.body.error).toMatch(/dedicated/);
    const file = path.join(tmp, project.file);
    fs.writeFileSync(file, fs.readFileSync(file, "utf-8").replace("dedicated: false", "dedicated: true"));
    expect((await call("PATCH", `/api/projects/${project.id}`, { description: "still dedicated" })).body.project).toMatchObject({ dedicated: true });
    expect((await call("PATCH", `/api/projects/${project.id}`, { dedicated: true })).status).toBe(200); // no change
  });

  it("is operator-only for writes: an employee session is refused", async () => {
    const session = reg.createSession({ engine: "codex", source: "web", sourceRef: "proj-ic", employee: "platform-worker" });
    const asEmployee = { [TOOL_CALL_HEADER]: TOOL_CALL_HEADER_VALUE, [CALLER_SESSION_HEADER]: session.id, [CALLER_SESSION_CAPABILITY_HEADER]: ensureSessionCapability(session.id) };
    const project = await newProject("Choir");
    expect((await call("POST", "/api/projects", { name: "Nope" }, asEmployee)).status).toBe(403);
    expect((await call("PATCH", `/api/projects/${project.id}`, { description: "x" }, asEmployee)).status).toBe(403);
    const todo = (await newTodo("Operator todo")).body.workItem;
    expect((await call("PUT", `/api/work-items/${todo.id}/project`, { project: project.id }, asEmployee)).status).toBe(403);
    expect((await call("GET", "/api/projects", undefined, asEmployee)).status).toBe(200);
  });
});

describe("Todos in a project", () => {
  it("lets a Todo be created in a project straight after the project is created", async () => {
    const project = await newProject("Garden Planner");
    const created = await newTodo("Plan the beds", { project: project.id });
    expect(created.status).toBe(201);
    expect(created.body.project).toMatchObject({ id: project.id, name: "Garden Planner", known: true });
    const id = created.body.workItem.id;
    expect(events(id, "created")[0]).toMatchObject({ project: project.id });
    expect(events(id, "project_changed")).toEqual([]);
    expect((await call("GET", `/api/work-items/${id}`)).body.project).toMatchObject({ id: project.id });
    expect((await call("GET", `/api/projects/${project.id}`)).body.project.todoCount).toBe(1);
  });

  it("filters the list by project, none, and an unknown id, and returns everything with no filter", async () => {
    const project = await newProject("Garden Planner");
    const a = (await newTodo("In A", { project: project.id })).body.workItem.id;
    const b = (await newTodo("In A too", { project: project.id })).body.workItem.id;
    const c = (await newTodo("Company level")).body.workItem.id;
    expect(ids(await call("GET", `/api/work-items?project=${project.id}`))).toEqual([a, b].sort());
    expect(ids(await call("GET", "/api/work-items?project=none"))).toContain(c);
    expect(ids(await call("GET", "/api/work-items?project=none"))).not.toContain(a);
    expect(ids(await call("GET", "/api/work-items?project=prj_ffffffffffff"))).toEqual([]);
    expect(ids(await call("GET", "/api/work-items"))).toEqual(expect.arrayContaining([a, b, c]));
    expect((await call("GET", "/api/work-items?project=garden")).status).toBe(400);
    const listed = (await call("GET", "/api/work-items")).body.workItems as Array<{ id: string; project: unknown }>;
    expect(listed.find((w) => w.id === c)?.project).toBeNull();
    expect(listed.find((w) => w.id === a)?.project).toMatchObject({ id: project.id });
  });

  it("makes a sub-task follow its root, and refuses one that names its own project", async () => {
    const project = await newProject("Garden Planner");
    const other = await newProject("Boat Club");
    const root = (await newTodo("Root", { project: project.id })).body.workItem.id;
    const sub = await newTodo("Sub", { parentId: root });
    expect(sub.status).toBe(201);
    const subId = sub.body.workItem.id;
    expect((await call("GET", `/api/work-items/${subId}`)).body.project).toMatchObject({ id: project.id });
    expect(ids(await call("GET", `/api/work-items?project=${project.id}`))).toEqual([root, subId].sort());
    expect((await newTodo("Sub with project", { parentId: root, project: other.id })).status).toBe(400);
    const moved = await call("PUT", `/api/work-items/${subId}/project`, { project: other.id });
    expect(moved.status).toBe(400);
    expect(moved.body.error).toContain(root);
    expect((await call("PUT", `/api/work-items/${root}/project`, { project: other.id })).status).toBe(200);
    expect((await call("GET", `/api/work-items/${subId}`)).body.project).toMatchObject({ id: other.id });
  });

  it("moves a Todo between projects and out, writing one project_changed event per real change", async () => {
    const a = await newProject("Garden Planner");
    const b = await newProject("Boat Club");
    const id = (await newTodo("Movable")).body.workItem.id;
    const moved = await call("PUT", `/api/work-items/${id}/project`, { project: a.id });
    expect(moved.body.project).toMatchObject({ id: a.id });
    await call("PUT", `/api/work-items/${id}/project`, { project: a.id }); // no change
    await call("PUT", `/api/work-items/${id}/project`, { project: b.id });
    const cleared = await call("PUT", `/api/work-items/${id}/project`, { project: null });
    expect(cleared.body.project).toBeNull();
    expect(events(id, "project_changed")).toEqual([{ from: null, to: a.id }, { from: a.id, to: b.id }, { from: b.id, to: null }]);
    expect((await call("GET", `/api/work-items/${id}`)).body.project).toBeNull();
    expect((await call("PUT", `/api/work-items/${id}/project`, {})).status).toBe(400);
    expect((await call("PUT", "/api/work-items/ZZZ-999999/project", { project: a.id })).status).toBe(404);
  });

  it("refuses new members for an archived or unknown project, and keeps its Todos readable", async () => {
    const project = await newProject("Garden Planner");
    const inside = (await newTodo("Already in", { project: project.id })).body.workItem.id;
    const outside = (await newTodo("Outside")).body.workItem.id;
    await call("PATCH", `/api/projects/${project.id}`, { archived: true });
    expect((await newTodo("New in archived", { project: project.id })).status).toBe(400);
    expect((await call("PUT", `/api/work-items/${outside}/project`, { project: project.id })).status).toBe(400);
    expect((await newTodo("New in unknown", { project: "prj_ffffffffffff" })).status).toBe(400);
    expect((await call("PUT", `/api/work-items/${outside}/project`, { project: "prj_ffffffffffff" })).status).toBe(400);
    expect(ids(await call("GET", `/api/work-items?project=${project.id}`))).toEqual([inside]);
    expect((await call("PUT", `/api/work-items/${inside}/project`, { project: null })).status).toBe(200); // may leave
  });

  it("reads Todos of a deleted project as an unknown project, not as an error", async () => {
    const project = await newProject("Garden Planner");
    const id = (await newTodo("Orphaned", { project: project.id })).body.workItem.id;
    fs.rmSync(path.join(tmp, project.file));
    (await import("../project-registry.js")).refreshProjects();
    expect((await call("GET", `/api/work-items/${id}`)).body.project).toEqual({ id: project.id, name: project.id, archived: true, known: false });
  });

  it("treats an idempotent create as the same create only when it names the same project", async () => {
    const a = await newProject("Garden Planner");
    const b = await newProject("Boat Club");
    const first = await newTodo("Keyed", { project: a.id, idempotencyKey: "key-1" });
    expect(first.status).toBe(201);
    expect((await newTodo("Keyed", { project: a.id, idempotencyKey: "key-1" })).status).toBe(200);
    expect((await newTodo("Keyed", { project: b.id, idempotencyKey: "key-1" })).status).toBe(409);
  });
});
