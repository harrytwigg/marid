import { describe, it, expect, beforeAll } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ensureSessionCapability } from "../identity.js";
import type { JinnMcpContext, JinnMcpTool } from "../toolkit.js";
import { inProcessGatewayFetch, seedPlatformOrg } from "./helpers/in-process-gateway.js";

/* Sprints through MCP: no tools of their own, only `sprint` on list_work_items
 * (the filter) and on edit_work_item (the move), driven through the real API. */

process.env.JINN_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "jinn-mcp-sprints-home-"));

let buildWorkItemTools: typeof import("../work-item-tools.js").buildWorkItemTools;
let api: typeof import("../../gateway/api.js");
let registry: typeof import("../../sessions/registry.js");
let store: typeof import("../../work-items/store.js");

function tool(name: string): JinnMcpTool {
  const found = buildWorkItemTools().find((t) => t.name === name);
  if (!found) throw new Error(`no tool ${name}`);
  return found;
}

function ctxFor(callerSessionId: string): JinnMcpContext {
  return {
    gatewayUrl: "http://gateway.test",
    fetchFn: inProcessGatewayFetch(api),
    callerSessionId,
    sessionCapability: ensureSessionCapability(callerSessionId),
  };
}

beforeAll(async () => {
  seedPlatformOrg(process.env.JINN_HOME!);
  ({ buildWorkItemTools } = await import("../work-item-tools.js"));
  api = await import("../../gateway/api.js");
  registry = await import("../../sessions/registry.js");
  store = await import("../../work-items/store.js");
  (await import("../../shared/db.js")).initDb();
});

describe("sprints through the Todo tools", () => {
  it("edit_work_item { sprint } moves a Todo between sprints through the real API, and list_work_items filters by it", async () => {
    const dev = registry.createSession({ engine: "codex", source: "web", sourceRef: "mcp-sprint-dev", title: "dev", employee: "platform-dev" });
    const devCtx = ctxFor(dev.id);
    const { createSprint, startSprint } = await import("../../work-items/sprints.js");
    const one = createSprint({ name: "MCP Sprint 1" });
    createSprint({ name: "MCP Sprint 2" });
    startSprint(one.id);
    const todo = store.createWorkItem({ title: "mcp sprint mover", assignee: "platform-dev" });

    // `active` names the running sprint; a content edit and a move ride one call.
    const moved = (await tool("edit_work_item").handler({ id: todo.id, title: "mcp sprint mover (edited)", sprint: "active" }, devCtx)) as {
      sprint: { name: string };
    };
    expect(moved.sprint.name).toBe("MCP Sprint 1");
    expect(store.getWorkItem(todo.id)!.title).toBe("mcp sprint mover (edited)");
    const inActive = (await tool("list_work_items").handler({ sprint: "active" }, devCtx)) as { workItems: Array<{ id: string }> };
    expect(inActive.workItems.map((w) => w.id)).toContain(todo.id);

    // By name, between sprints, then out with null.
    await tool("edit_work_item").handler({ id: todo.id, sprint: "mcp sprint 2" }, devCtx);
    const inTwo = (await tool("list_work_items").handler({ sprint: "MCP Sprint 2" }, devCtx)) as { workItems: Array<{ id: string }> };
    expect(inTwo.workItems.map((w) => w.id)).toEqual([todo.id]);
    await tool("edit_work_item").handler({ id: todo.id, sprint: null }, devCtx);
    const detail = (await tool("get_work_item").handler({ id: todo.id }, devCtx)) as { sprint: unknown };
    expect(detail.sprint).toBeNull();

    // An unknown sprint is refused naming the open ones, so a model can recover.
    await expect(tool("edit_work_item").handler({ id: todo.id, sprint: "Ghost" }, devCtx)).rejects.toThrow(/open sprints: .*MCP Sprint 1/);
  });


  it("edit_work_item with a refused move saves nothing, and returns post-move state when both halves land", async () => {
    const dev = registry.createSession({ engine: "codex", source: "web", sourceRef: "mcp-sprint-half", title: "dev", employee: "platform-dev" });
    const devCtx = ctxFor(dev.id);
    const { createSprint } = await import("../../work-items/sprints.js");
    createSprint({ name: "MCP Half Sprint" });
    const todo = store.createWorkItem({ title: "half edit", assignee: "platform-dev" });

    // A typo in the sprint name: the move is refused first, so the title stays.
    await expect(tool("edit_work_item").handler({ id: todo.id, title: "should not land", sprint: "MCP Hlaf Sprint" }, devCtx))
      .rejects.toThrow(/nothing was saved/);
    expect(store.getWorkItem(todo.id)!.title).toBe("half edit");

    // Both halves land: the row-shaped sprint and the version after both writes.
    const both = (await tool("edit_work_item").handler({ id: todo.id, title: "both landed", sprint: "MCP Half Sprint" }, devCtx)) as {
      workItem: { version: number; title: string };
      sprint: Record<string, unknown>;
    };
    expect(both.workItem.title).toBe("both landed");
    expect(both.workItem.version).toBe(store.getWorkItem(todo.id)!.version);
    expect(Object.keys(both.sprint).sort()).toEqual(["id", "name", "status"]);

    // A move alone reports the version it left, so the next CAS edit does not conflict.
    const out = (await tool("edit_work_item").handler({ id: todo.id, sprint: null }, devCtx)) as { sprint: unknown; version: number };
    expect(out.sprint).toBeNull();
    expect(out.version).toBe(store.getWorkItem(todo.id)!.version);
  });

  it("edit_work_item says the move landed when the content edit after it fails", async () => {
    const calls: string[] = [];
    const fetchFn = (async (input: string | URL, init?: RequestInit) => {
      const method = init?.method ?? "GET";
      calls.push(`${method} ${new URL(String(input)).pathname}`);
      const reply = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
      if (method === "PUT") return reply(200, { sprint: { id: "spr_0123456789ab", name: "Stub Sprint", status: "active" }, version: 4 });
      if (method === "GET") return reply(200, { workItem: { id: "TST-1", version: 4 } });
      return reply(400, { error: "title must not be empty" });
    }) as typeof fetch;
    const ctx: JinnMcpContext = { gatewayUrl: "http://gateway.test", fetchFn, callerSessionId: "s-1", sessionCapability: "cap" };
    await expect(tool("edit_work_item").handler({ id: "TST-1", title: "x", sprint: "Stub Sprint" }, ctx))
      .rejects.toThrow(/TST-1 was moved to sprint "Stub Sprint"; the content edit then failed: .*title must not be empty/);
    expect(calls).toEqual(["PUT /api/work-items/TST-1/sprint", "GET /api/work-items/TST-1", "PATCH /api/work-items/TST-1"]);
  });
});
