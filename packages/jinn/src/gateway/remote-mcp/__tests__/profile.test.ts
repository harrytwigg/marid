import { describe, expect, it } from "vitest";
import { buildTools } from "../../../mcp/server.js";
import type { JinnMcpContext, JinnMcpTool } from "../../../mcp/toolkit.js";
import { buildRemoteMcpTools, REMOTE_MCP_LEDGER_TOOLS, REMOTE_MCP_READ_TOOLS, REMOTE_MCP_SESSION_TOOLS } from "../profile.js";
import { remoteMcpRouteAllowed } from "../rules.js";

/**
 * The profile and the gateway's route allow-list are two halves of one rule
 * (D4). If a profile tool calls a route the allow-list omits, the tool
 * is dead on the remote door; if the allow-list admits more than the profile
 * uses, the gateway guard is looser than the profile claims. This drives every
 * profile tool against a recording fetch and checks the routes it really calls.
 */

/** Tools the spec excludes from every option (FR-010, FR-011, Q2 classes T/X/D/A/C/P), less
 *  the four session-control tools admitted later. */
const NEVER = [
  "read_knowledge", "attach_to_work_item", "create_label", "decide_work_item_approval",
  "get_message_context", "search_messages", "spawn_session",
  "dispatch_work_item", "update_work_item",
  "set_work_item_dispatch",
  "archive_work_item", "stop_session",
  "send_connector_message", "request_work_item_approval",
  "escalate_work_item_approval", "arm_heartbeat", "stop_heartbeat", "publish_attachment", "land_on_work_item",
];

/** Realistic values for keys whose handlers validate format before calling the gateway. */
const BY_KEY: Record<string, unknown> = {
  id: "TST-1", srcId: "TST-1", dstId: "TST-2", parentId: "TST-1", rootId: "TST-1",
  path: "knowledge/remote-mcp/note.md", expectedRevision: "a".repeat(64),
  parentCommentId: "wic_0a1b2c3d4e5f", since: "2026-01-01T00:00:00Z", activeSince: "2026-01-01T00:00:00Z",
};

function sample(schema: Record<string, unknown>, key: string): unknown {
  if (key in BY_KEY) return BY_KEY[key];
  if (Array.isArray(schema.enum)) return schema.enum[0];
  if (schema.type === "number" || schema.type === "integer") return 1;
  if (schema.type === "boolean") return false;
  if (schema.type === "array") return ["x"];
  if (schema.type === "object") return {};
  return "x";
}

/** Required fields only: optional ones add format checks without adding routes. */
function sampleArgs(tool: JinnMcpTool): Record<string, unknown> {
  const props = (tool.inputSchema.properties ?? {}) as Record<string, Record<string, unknown>>;
  const required = (tool.inputSchema.required ?? []) as string[];
  const args: Record<string, unknown> = {};
  for (const key of required) args[key] = sample(props[key] ?? {}, key);
  if (tool.name === "label_work_item") args.labels = ["x"];
  if (tool.name === "read_file") args.path = "files/x.txt";
  // Tools that insist on at least one optional filter or field.
  if (tool.name === "find_employees") args.department = "x";
  if (tool.name === "search_sessions" || tool.name === "search_work_items") args.text = "x";
  if (tool.name === "update_note") args.body = "x";
  if (tool.name === "edit_work_item") args.title = "x";
  if (tool.name === "delegate_task") args.employee = "x";
  return args;
}

describe("remote MCP tool profile", () => {
  const all = new Set(buildTools({ notesEnabled: true }).map((tool) => tool.name));

  it("names only tools that exist", () => {
    for (const name of [...REMOTE_MCP_READ_TOOLS, ...REMOTE_MCP_LEDGER_TOOLS, ...REMOTE_MCP_SESSION_TOOLS]) expect(all.has(name), name).toBe(true);
  });

  it("carries the instance's knowledge wording on search_knowledge", () => {
    const search = (wording?: { guidance?: string }) =>
      buildRemoteMcpTools(false, wording).find((tool) => tool.name === "search_knowledge")!.description;
    expect(search({ guidance: "Use the state files." })).toBe("Search knowledge/ and docs/ markdown; snippets only. Use the state files.");
    expect(search()).toBe("Search knowledge/ and docs/ markdown; snippets only.");
  });

  it("serves the session-control tools", () => {
    const served = new Set(buildRemoteMcpTools(false).map((tool) => tool.name));
    for (const name of REMOTE_MCP_SESSION_TOOLS) expect(served.has(name), name).toBe(true);
  });

  it("tells the connector where to read an answer, not to wait for a wake", async () => {
    const byName = new Map(buildRemoteMcpTools(false).map((tool) => [tool.name, tool]));
    const fetchFn = (async () => new Response(JSON.stringify({ workItemId: "TST-9", sessionId: "s-2" }), {
      status: 201, headers: { "content-type": "application/json" },
    })) as typeof fetch;
    const ctx: JinnMcpContext = { gatewayUrl: "http://127.0.0.1:1", token: "t", callerSessionId: "s-1", sessionCapability: "cap", fetchFn };
    const sent = await byName.get("send_to_session")!.handler({ sessionId: "s-2", message: "status?" }, ctx) as { hint: string };
    expect(sent.hint).toContain('read_session { sessionId: "s-2" }');
    const delegated = await byName.get("delegate_task")!.handler({ task: "do it", employee: "qa-emp" }, ctx) as { hint: string; workItemId: string };
    expect(delegated.workItemId).toBe("TST-9");
    for (const hint of [sent.hint, delegated.hint]) expect(hint).not.toMatch(/END YOUR TURN|wakes you/);
    for (const name of ["send_to_session", "delegate_task"]) expect(byName.get(name)!.description).not.toMatch(/END YOUR TURN|never poll/);
  });

  it("lists attachment metadata only: no gateway disk path, no this-host read locations", async () => {
    const listTool = buildRemoteMcpTools(false).find((tool) => tool.name === "list_work_item_attachments")!;
    const row = { id: "wia_0a1b2c3d4e5f", sha256: "a".repeat(64), bytes: 3, storagePath: "/gw/attachments/aa/x" };
    const fetchFn = (async () => new Response(JSON.stringify({ attachments: [row] }), {
      status: 200, headers: { "content-type": "application/json" },
    })) as typeof fetch;
    const ctx: JinnMcpContext = { gatewayUrl: "http://127.0.0.1:1", token: "t", callerSessionId: "s-1", sessionCapability: "cap", fetchFn };
    const out = await listTool.handler({ id: "TST-9" }, ctx) as { attachments: Array<Record<string, unknown>>; hint: string };
    const { storagePath: _storagePath, ...metadata } = row;
    expect(out.attachments).toEqual([metadata]);
    expect(out.hint).toMatch(/not readable over this connector/);
    expect(out.hint).not.toMatch(/JINN_GATEWAY_TOKEN/);
  });

  it("refuses comment attachments before posting: this door cannot reach the attachment route (review C1)", async () => {
    const commentTool = buildRemoteMcpTools(false).find((tool) => tool.name === "comment_work_item")!;
    let calls = 0;
    const fetchFn = (async () => {
      calls++;
      return new Response("{}", { status: 201, headers: { "content-type": "application/json" } });
    }) as typeof fetch;
    const ctx: JinnMcpContext = { gatewayUrl: "http://127.0.0.1:1", token: "t", callerSessionId: "s-1", sessionCapability: "cap", fetchFn };
    await expect(commentTool.handler({ id: "TST-9", body: "see file", attachments: ["/etc/hostname"] }, ctx)).rejects.toThrow(
      /cannot be uploaded over this connector/,
    );
    // The upload itself is guarded too, for any caller on this door.
    const { uploadWorkItemAttachment } = await import("../../../mcp/work-item-attachments.js");
    await expect(uploadWorkItemAttachment({ ...ctx, hostLocations: false }, "TST-9", "/etc/hostname")).rejects.toThrow(
      /cannot be uploaded over this connector/,
    );
    expect(calls).toBe(0);
  });

  it("serves none of the excluded tools", () => {
    const served = new Set(buildRemoteMcpTools(true).map((tool) => tool.name));
    for (const name of NEVER) expect(served.has(name), name).toBe(false);
  });

  it("drops the note tools when Notes are disabled", () => {
    const served = buildRemoteMcpTools(false).map((tool) => tool.name);
    expect(served).not.toContain("create_note");
    expect(served).toContain("list_work_items");
  });

  it("every profile tool calls only routes the gateway admits for the connector", async () => {
    const offList: string[] = [];
    const silent: string[] = [];
    for (const tool of buildRemoteMcpTools(true)) {
      const calls: string[] = [];
      const fetchFn = (async (input: string | URL, init?: RequestInit) => {
        const url = new URL(String(input));
        calls.push(`${init?.method ?? "GET"} ${url.pathname}`);
        return new Response(JSON.stringify({}), { status: 200, headers: { "content-type": "application/json" } });
      }) as typeof fetch;
      const ctx: JinnMcpContext = {
        gatewayUrl: "http://127.0.0.1:1", token: "t", callerSessionId: "s-1", sessionCapability: "cap", fetchFn,
        activityOperation: { id: "op", toolName: tool.name },
      };
      let failure = "";
      try { await tool.handler(sampleArgs(tool), ctx); } catch (e) { failure = String(e).slice(0, 120); }
      if (calls.length === 0) silent.push(`${tool.name}: ${failure}`);
      for (const call of calls) {
        const [method, pathname] = call.split(" ") as [string, string];
        if (!remoteMcpRouteAllowed(method, pathname)) offList.push(`${tool.name}: ${call}`);
      }
    }
    expect(offList).toEqual([]);
    expect(silent).toEqual([]);
  });

  it("refuses the routes behind excluded tools", () => {
    for (const [method, path] of [
      ["GET", "/api/sessions/abc/transcript"], ["GET", "/api/knowledge/read"], ["POST", "/api/work-items/TST-1/status"],
      ["POST", "/api/sessions/abc/stop"], ["POST", "/api/work-items/TST-1/attachments"], ["POST", "/api/sessions"],
      ["POST", "/api/work-items/TST-1/approval/decide"], ["GET", "/api/experiments"], ["POST", "/api/experiments"],
      ["POST", "/api/labels"], ["POST", "/api/cron"], ["PUT", "/api/config"],
    ] as const) {
      expect(remoteMcpRouteAllowed(method, path), `${method} ${path}`).toBe(false);
    }
  });
});
