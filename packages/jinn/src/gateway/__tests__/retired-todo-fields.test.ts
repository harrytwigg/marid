import { describe, expect, it } from "vitest";
import { api, ctx, makeReq, makeRes, operatorHeaders, reg, store, toolHeaders } from "./helpers/work-items-route-harness.js";
import { buildWorkItemTools } from "../../mcp/work-item-tools.js";
import type { JinnMcpContext, JinnMcpTool } from "../../mcp/toolkit.js";

/**
 * `acceptance` and `verifyPolicy` were removed from Todos. Their columns stay so
 * old rows keep their data, but no surface reads or writes them, and a caller
 * still sending one is refused by name rather than having it silently dropped —
 * an agent whose criteria vanished without a word would believe they were saved.
 */

function mcpTool(name: string): JinnMcpTool {
  const found = buildWorkItemTools().find((tool) => tool.name === name);
  if (!found) throw new Error(`no tool ${name}`);
  return found;
}

/** The MCP tools reach the gateway over fetch; this records the body instead. */
function mcpContext() {
  const sent: unknown[] = [];
  const fetchFn = (async (_input: string | URL, init?: RequestInit) => {
    if (typeof init?.body === "string") sent.push(JSON.parse(init.body));
    return { status: 201, text: async () => JSON.stringify({ workItem: { id: "AAA-1", version: 4 } }) } as unknown as Response;
  }) as unknown as typeof fetch;
  return {
    sent,
    ctx: {
      // Never dialed — fetchFn answers every request.
      gatewayUrl: "http://gateway.invalid",
      fetchFn,
      callerSessionId: "session-test",
      sessionCapability: "cap-test",
    } satisfies JinnMcpContext,
  };
}

describe("retired Todo fields on the gateway route", () => {
  it("refuses them on create, naming where the criteria go instead", async () => {
    const caller = reg.createSession({ engine: "codex", source: "web", sourceRef: "retired-create", employee: "platform-worker" });
    for (const [extra, message] of [
      [{ acceptance: "Tests pass" }, "acceptance was removed from Todos: put acceptance criteria in body"],
      [{ verifyPolicy: { mode: "trust" } }, "verifyPolicy was removed from Todos: review is no longer configurable per Todo"],
      [{ acceptance: null, verifyPolicy: null }, "acceptance and verifyPolicy were removed from Todos"],
    ] as const) {
      const refused = makeRes();
      await api.handleApiRequest(makeReq("POST", "/api/work-items", { title: "Retired", ...extra }, toolHeaders(caller.id)), refused.res, ctx);
      expect(refused.status).toBe(400);
      expect(refused.body.error).toContain(message);
    }
  });

  it("refuses them on the metadata pen, for the operator too", async () => {
    const item = store.createWorkItem({ title: "Edit me" });
    for (const extra of [{ acceptance: "x" }, { acceptance: null }, { verifyPolicy: null }]) {
      const refused = makeRes();
      await api.handleApiRequest(
        makeReq("PATCH", `/api/work-items/${item.id}`, { expectedVersion: item.version, ...extra }, operatorHeaders),
        refused.res,
        ctx,
      );
      expect(refused.status).toBe(400);
      expect(JSON.stringify(refused.body)).toContain("removed from Todos");
    }
    expect(store.getWorkItem(item.id)?.version).toBe(item.version);
  });

  it("no longer returns them on a read", async () => {
    const caller = reg.createSession({ engine: "codex", source: "web", sourceRef: "retired-read", employee: "platform-worker" });
    const created = makeRes();
    await api.handleApiRequest(makeReq("POST", "/api/work-items", { title: "Plain" }, toolHeaders(caller.id)), created.res, ctx);
    expect(created.status).toBe(201);
    expect(created.body.workItem).not.toHaveProperty("acceptance");
    expect(created.body.workItem).not.toHaveProperty("verifyPolicy");
  });
});

describe("retired Todo fields on the MCP tools", () => {
  it("are absent from every tool schema", () => {
    for (const name of ["create_work_item", "update_work_item", "edit_work_item"]) {
      const properties = Object.keys((mcpTool(name).inputSchema as { properties: Record<string, unknown> }).properties);
      expect(properties).not.toContain("acceptance");
      expect(properties).not.toContain("verifyPolicy");
    }
  });

  it("are refused before anything is sent, on create, edit and update", async () => {
    for (const [tool, args] of [
      ["create_work_item", { title: "x", acceptance: "Tests pass" }],
      ["edit_work_item", { id: "AAA-1", body: "y", acceptance: "Tests pass" }],
      ["update_work_item", { id: "AAA-1", status: "executing", verifyPolicy: { mode: "verify" } }],
    ] as const) {
      const call = mcpContext();
      await expect(mcpTool(tool).handler(args as Record<string, unknown>, call.ctx)).rejects.toThrow("removed from Todos");
      expect(call.sent).toEqual([]);
    }
  });

  it("treat a null the model filled in as not set", async () => {
    const call = mcpContext();
    await mcpTool("create_work_item").handler({ title: "x", acceptance: null, verifyPolicy: null }, call.ctx);
    expect(call.sent).toEqual([{ title: "x" }]);
  });
});
