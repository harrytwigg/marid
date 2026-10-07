import { describe, it, expect, beforeAll } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ensureSessionCapability } from "../identity.js";
import type { JinnMcpContext, JinnMcpTool } from "../toolkit.js";
import { inProcessGatewayFetch, seedPlatformOrg } from "./helpers/in-process-gateway.js";

/* A Todo's start date through MCP: `startAt` on create_work_item and
 * edit_work_item, read back by get_work_item and list_work_items, driven
 * through the real API. */

process.env.JINN_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "jinn-mcp-start-date-home-"));

let buildWorkItemTools: typeof import("../work-item-tools.js").buildWorkItemTools;
let api: typeof import("../../gateway/api.js");
let registry: typeof import("../../sessions/registry.js");

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
  (await import("../../shared/db.js")).initDb();
});

type Detail = { workItem: { id: string; startAt: string | null; dueAt: string | null } };

async function read(ctx: JinnMcpContext, id: string): Promise<{ detail: string | null; row: string | null | undefined }> {
  const detail = (await tool("get_work_item").handler({ id }, ctx)) as Detail;
  const list = (await tool("list_work_items").handler({}, ctx)) as { workItems: Array<{ id: string; startAt?: string | null }> };
  return { detail: detail.workItem.startAt, row: list.workItems.find((row) => row.id === id)?.startAt };
}

describe("startAt through the Todo tools", () => {
  it("create, edit and clear round-trip through get_work_item and list_work_items", async () => {
    const ctx = ctxFor(registry.createSession({ engine: "codex", source: "web", sourceRef: "mcp-start-date", title: "dev", employee: "platform-dev" }).id);

    const created = (await tool("create_work_item").handler({ title: "starts later", startAt: "2026-11-02", dueAt: "2026-11-30" }, ctx)) as Detail;
    const id = created.workItem.id;
    expect(created.workItem.startAt).toBe("2026-11-02T00:00:00.000Z");
    expect(await read(ctx, id)).toEqual({ detail: "2026-11-02T00:00:00.000Z", row: "2026-11-02T00:00:00.000Z" });

    await tool("edit_work_item").handler({ id, startAt: "2026-11-09T09:30:00+01:00" }, ctx);
    expect(await read(ctx, id)).toEqual({ detail: "2026-11-09T08:30:00.000Z", row: "2026-11-09T08:30:00.000Z" });

    // Cleared: null on the detail, and gone from the list row, which carries dates only when set.
    await tool("edit_work_item").handler({ id, startAt: null }, ctx);
    expect(await read(ctx, id)).toEqual({ detail: null, row: undefined });
  });

  it("refuses a start date after the due date, on create and on either edit that would make one", async () => {
    const ctx = ctxFor(registry.createSession({ engine: "codex", source: "web", sourceRef: "mcp-start-order", title: "dev", employee: "platform-dev" }).id);
    await expect(tool("create_work_item").handler({ title: "backwards", startAt: "2026-12-02", dueAt: "2026-12-01" }, ctx))
      .rejects.toThrow(/startAt \(2026-12-02T00:00:00.000Z\) must not be after dueAt \(2026-12-01T00:00:00.000Z\)/);

    const created = (await tool("create_work_item").handler({ title: "ordered", startAt: "2026-12-01", dueAt: "2026-12-05" }, ctx)) as Detail;
    const id = created.workItem.id;
    await expect(tool("edit_work_item").handler({ id, startAt: "2026-12-06" }, ctx)).rejects.toThrow(/must not be after dueAt/);
    await expect(tool("edit_work_item").handler({ id, dueAt: "2026-11-30" }, ctx)).rejects.toThrow(/must not be after dueAt/);
    // Both moved in one edit is judged on the result, and a start on the due date is allowed.
    await tool("edit_work_item").handler({ id, startAt: "2026-12-10", dueAt: "2026-12-10" }, ctx);
    expect(await read(ctx, id)).toMatchObject({ detail: "2026-12-10T00:00:00.000Z" });
  });

  it("refuses a start date that is not an ISO timestamp", async () => {
    const ctx = ctxFor(registry.createSession({ engine: "codex", source: "web", sourceRef: "mcp-start-bad", title: "dev", employee: "platform-dev" }).id);
    await expect(tool("create_work_item").handler({ title: "bad", startAt: "next tuesday" }, ctx)).rejects.toThrow(/startAt must be an ISO 8601 timestamp/);
  });
});
