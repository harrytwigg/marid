import { describe, it, expect, beforeAll } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import type { ServerResponse } from "node:http";
import { ensureSessionCapability } from "../../mcp/identity.js";
import { CALLER_SESSION_CAPABILITY_HEADER, CALLER_SESSION_HEADER, TOOL_CALL_HEADER, TOOL_CALL_HEADER_VALUE } from "../../mcp/identity.js";

/**
 * Route-level tests for sprints: the registry and lifecycle routes, moving a
 * Todo between sprints, and the `sprint` list filter and wire field. Drives
 * handleApiRequest directly against a throwaway JINN_HOME.
 */

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "jinn-sprint-route-"));
process.env.JINN_HOME = tmp;
fs.mkdirSync(path.join(tmp, "org"), { recursive: true });
// platform-lead manages platform-worker → platform-lead IS a manager;
// platform-worker and solo-worker have no reports.
fs.writeFileSync(
  path.join(tmp, "org", "platform-lead.yaml"),
  "name: platform-lead\ndisplayName: Platform Lead\ndepartment: platform\nrank: senior\nengine: codex\nmodel: default\npersona: Sprint-route-test manager.\n",
);
fs.writeFileSync(
  path.join(tmp, "org", "platform-worker.yaml"),
  "name: platform-worker\ndisplayName: Platform Worker\ndepartment: platform\nrank: employee\nengine: codex\nmodel: default\nreportsTo: platform-lead\npersona: Sprint-route-test worker.\n",
);
fs.writeFileSync(
  path.join(tmp, "org", "solo-worker.yaml"),
  "name: solo-worker\ndisplayName: Solo Worker\ndepartment: marketing\nrank: employee\nengine: codex\nmodel: default\npersona: Sprint-route-test loner.\n",
);

type Api = typeof import("../api.js");
type Reg = typeof import("../../sessions/registry.js");
type Store = typeof import("../../work-items/store.js");
let api: Api;
let reg: Reg;
let store: Store;
let db: import("better-sqlite3").Database;

function makeRes() {
  let status = 200;
  const chunks: Buffer[] = [];
  const res = {
    writeHead(s: number) {
      status = s;
      return this;
    },
    setHeader() {
      return this;
    },
    end(buf?: Buffer | string) {
      if (buf) chunks.push(Buffer.isBuffer(buf) ? buf : Buffer.from(buf));
    },
  } as unknown as ServerResponse;
  return {
    res,
    get status() {
      return status;
    },
    get body() {
      const raw = Buffer.concat(chunks).toString("utf-8");
      try {
        return JSON.parse(raw);
      } catch {
        return raw;
      }
    },
  };
}

function makeReq(method: string, urlPath: string, body?: unknown, headers: Record<string, string> = {}) {
  const payload = body !== undefined ? [Buffer.from(JSON.stringify(body))] : [];
  return Object.assign(Readable.from(payload), {
    method,
    url: urlPath,
    headers: { host: "localhost", "content-type": "application/json", ...headers },
  }) as unknown as Parameters<Api["handleApiRequest"]>[0];
}

const emittedEvents: Array<{ event: string; payload: Record<string, unknown> }> = [];

const ctx = {
  getConfig: () => ({ gateway: {}, engines: {} }),
  connectors: new Map(),
  startTime: Date.now(),
  gatewayAuthToken: "test-token",
  emit: (event: string, payload: Record<string, unknown>) => emittedEvents.push({ event, payload }),
  sessionManager: {
    getQueue: () => ({
      getPendingCount: () => 0,
      getTransportState: (_key: string, status: string) => status,
    }),
  },
} as unknown as import("../api.js").ApiContext;

const operatorHeaders = { authorization: "Bearer test-token" };

function toolHeaders(sessionId: string): Record<string, string> {
  return {
    [TOOL_CALL_HEADER]: TOOL_CALL_HEADER_VALUE,
    [CALLER_SESSION_HEADER]: sessionId,
    [CALLER_SESSION_CAPABILITY_HEADER]: ensureSessionCapability(sessionId),
  };
}

async function call(method: string, urlPath: string, body?: unknown, headers: Record<string, string> = {}) {
  const cap = makeRes();
  await api.handleApiRequest(makeReq(method, urlPath, body, headers), cap.res, ctx);
  return cap;
}

beforeAll(async () => {
  api = await import("../api.js");
  reg = await import("../../sessions/registry.js");
  store = await import("../../work-items/store.js");
  db = (await import("../../shared/db.js")).initDb();
});

describe("sprint registry routes", () => {
  it("lets the operator and managers plan sprints, and refuses everyone else", async () => {
    const created = await call("POST", "/api/sprints", { name: "Route Sprint 1", goal: "first", startsAt: "2026-10-05", endsAt: "2026-10-16" }, operatorHeaders);
    expect(created.status).toBe(201);
    expect(created.body.sprint).toMatchObject({ name: "Route Sprint 1", status: "planned", startsAt: "2026-10-05" });

    const manager = reg.createSession({ engine: "codex", source: "web", sourceRef: "spr-mgr", employee: "platform-lead" });
    const byManager = await call("POST", "/api/sprints", { name: "Manager Sprint" }, toolHeaders(manager.id));
    expect(byManager.status).toBe(201);

    const ic = reg.createSession({ engine: "codex", source: "web", sourceRef: "spr-ic", employee: "platform-worker" });
    const byIc = await call("POST", "/api/sprints", { name: "IC Sprint" }, toolHeaders(ic.id));
    expect(byIc.status).toBe(403);
    const startByIc = await call("POST", `/api/sprints/${created.body.sprint.id}/start`, undefined, toolHeaders(ic.id));
    expect(startByIc.status).toBe(403);

    const duplicate = await call("POST", "/api/sprints", { name: "route sprint 1" }, operatorHeaders);
    expect(duplicate.status).toBe(409);
    const noName = await call("POST", "/api/sprints", { goal: "x" }, operatorHeaders);
    expect(noName.status).toBe(400);
    const impossible = await call("POST", "/api/sprints", { name: "Impossible", startsAt: "2026-13-45" }, operatorHeaders);
    expect(impossible.status).toBe(400);
    expect(impossible.body.error).toMatch(/calendar date/);

    const listed = await call("GET", "/api/sprints");
    expect(listed.status).toBe(200);
    expect((listed.body.sprints as Array<{ name: string }>).map((s) => s.name)).toEqual(expect.arrayContaining(["Route Sprint 1", "Manager Sprint"]));
  });

  it("renames, starts, refuses a second start, and 404s an unknown sprint", async () => {
    const a = (await call("POST", "/api/sprints", { name: "Route Life A" }, operatorHeaders)).body.sprint;
    const b = (await call("POST", "/api/sprints", { name: "Route Life B" }, operatorHeaders)).body.sprint;
    const renamed = await call("PATCH", `/api/sprints/${a.id}`, { name: "Route Life A2", goal: null }, operatorHeaders);
    expect(renamed.status).toBe(200);
    expect(renamed.body.sprint.name).toBe("Route Life A2");

    // A sprint name works in the path too.
    expect((await call("POST", `/api/sprints/${encodeURIComponent("Route Life A2")}/start`, undefined, operatorHeaders)).status).toBe(200);
    const second = await call("POST", `/api/sprints/${b.id}/start`, undefined, operatorHeaders);
    expect(second.status).toBe(409);
    expect(second.body.error).toMatch(/still active/);
    expect((await call("POST", "/api/sprints/spr_000000000000/start", undefined, operatorHeaders)).status).toBe(404);

    const done = await call("POST", `/api/sprints/${a.id}/complete`, { carryTo: null }, operatorHeaders);
    expect(done.status).toBe(200);
    expect(done.body.sprint.status).toBe("closed");
  });
});

describe("moving Todos between sprints", () => {
  it("creates a sprint and moves a Todo between sprints, filtering the list to each", async () => {
    const one = (await call("POST", "/api/sprints", { name: "Board Sprint 1" }, operatorHeaders)).body.sprint;
    const two = (await call("POST", "/api/sprints", { name: "Board Sprint 2" }, operatorHeaders)).body.sprint;
    const todo = store.createWorkItem({ title: "board mover" });
    const child = store.createWorkItem({ title: "board mover child", parentId: todo.id });
    const bystander = store.createWorkItem({ title: "never sprinted" });

    emittedEvents.length = 0;
    const into = await call("PUT", `/api/work-items/${todo.id}/sprint`, { sprint: one.id }, operatorHeaders);
    expect(into.status).toBe(200);
    expect(into.body.sprint).toMatchObject({ id: one.id, name: "Board Sprint 1" });
    expect(emittedEvents.some((e) => e.event === "company:changed" && e.payload.id === todo.id && e.payload.action === "sprint-updated")).toBe(true);
    // Rows embed their sprint, so a move also tells other tabs a sprint changed.
    expect(emittedEvents.some((e) => e.event === "company:changed" && e.payload.entity === "sprint" && e.payload.action === "moved")).toBe(true);

    const inOne = await call("GET", `/api/work-items?sprint=${one.id}&rootsOnly=true`);
    expect((inOne.body.workItems as Array<{ id: string; sprint: unknown }>).map((w) => w.id)).toEqual([todo.id]);
    expect(inOne.body.workItems[0].sprint).toEqual({ id: one.id, name: "Board Sprint 1", status: "planned" });

    const moved = await call("PUT", `/api/work-items/${todo.id}/sprint`, { sprint: "Board Sprint 2" }, operatorHeaders);
    expect(moved.status).toBe(200);
    expect((await call("GET", `/api/work-items?sprint=${one.id}`)).body.workItems).toEqual([]);
    const inTwo = await call("GET", `/api/work-items?sprint=${encodeURIComponent("board sprint 2")}`);
    // The sub-task rides with its root.
    expect((inTwo.body.workItems as Array<{ id: string }>).map((w) => w.id).sort()).toEqual([todo.id, child.id].sort());

    const detail = await call("GET", `/api/work-items/${child.id}`);
    expect(detail.body.sprint).toMatchObject({ id: two.id });
    const none = await call("GET", "/api/work-items?sprint=none&limit=100");
    const noneIds = (none.body.workItems as Array<{ id: string }>).map((w) => w.id);
    expect(noneIds).toContain(bystander.id);
    expect(noneIds).not.toContain(todo.id);

    const childMove = await call("PUT", `/api/work-items/${child.id}/sprint`, { sprint: one.id }, operatorHeaders);
    expect(childMove.status).toBe(400);
    expect(childMove.body.error).toMatch(/sub-task/);
    const unknown = await call("PUT", `/api/work-items/${todo.id}/sprint`, { sprint: "Nope" }, operatorHeaders);
    expect(unknown.status).toBe(404);
    const badBody = await call("PUT", `/api/work-items/${todo.id}/sprint`, { sprint: 7 }, operatorHeaders);
    expect(badBody.status).toBe(400);
    const out = await call("PUT", `/api/work-items/${todo.id}/sprint`, { sprint: null }, operatorHeaders);
    expect(out.body.sprint).toBeNull();
  });

  it("lets the assignee move a Todo, and refuses a stranger", async () => {
    const sprint = (await call("POST", "/api/sprints", { name: "Standing Sprint" }, operatorHeaders)).body.sprint;
    const todo = store.createWorkItem({ title: "assigned mover", assignee: "platform-worker" });
    const assignee = reg.createSession({ engine: "codex", source: "web", sourceRef: "spr-assignee", employee: "platform-worker" });
    const stranger = reg.createSession({ engine: "codex", source: "web", sourceRef: "spr-stranger", employee: "solo-worker" });
    expect((await call("PUT", `/api/work-items/${todo.id}/sprint`, { sprint: sprint.id }, toolHeaders(stranger.id))).status).toBe(403);
    expect((await call("PUT", `/api/work-items/${todo.id}/sprint`, { sprint: sprint.id }, toolHeaders(assignee.id))).status).toBe(200);
  });

  it("completes the active sprint over HTTP, carrying unfinished work into the next and starting it", async () => {
    const current = (await call("POST", "/api/sprints", { name: "HTTP Carry From" }, operatorHeaders)).body.sprint;
    const next = (await call("POST", "/api/sprints", { name: "HTTP Carry To" }, operatorHeaders)).body.sprint;
    expect((await call("POST", `/api/sprints/${current.id}/start`, undefined, operatorHeaders)).status).toBe(200);
    const open = store.createWorkItem({ title: "carry me" });
    const finished = store.createWorkItem({ title: "leave me" });
    for (const t of [open, finished]) await call("PUT", `/api/work-items/${t.id}/sprint`, { sprint: current.id }, operatorHeaders);
    db.prepare("UPDATE work_items SET status = 'done' WHERE id = ?").run(finished.id);

    const missingCarry = await call("POST", `/api/sprints/${current.id}/complete`, {}, operatorHeaders);
    expect(missingCarry.status).toBe(400);

    emittedEvents.length = 0;
    const result = await call("POST", `/api/sprints/${current.id}/complete`, { carryTo: next.id, startNext: true }, operatorHeaders);
    expect(result.status).toBe(200);
    expect(emittedEvents.some((e) => e.payload.entity === "sprint" && e.payload.action === "completed" && e.payload.id === current.id)).toBe(true);
    expect(result.body).toMatchObject({ carried: [open.id], carriedTo: { id: next.id, status: "active" } });
    expect(emittedEvents.filter((e) => e.payload.action === "sprint-updated").map((e) => e.payload.id)).toEqual([open.id]);

    const active = await call("GET", "/api/work-items?sprint=active");
    expect((active.body.workItems as Array<{ id: string }>).map((w) => w.id)).toEqual([open.id]);
    const deleteActive = await call("DELETE", `/api/sprints/${next.id}`, undefined, operatorHeaders);
    expect(deleteActive.status).toBe(400);
  });
});
