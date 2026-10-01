import { describe, it, expect, beforeAll } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { JinnMcpContext, JinnMcpTool } from "../toolkit.js";

process.env.JINN_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "jinn-mcp-cascade-"));

let buildWorkItemTools: typeof import("../work-item-tools.js").buildWorkItemTools;

beforeAll(async () => {
  ({ buildWorkItemTools } = await import("../work-item-tools.js"));
});

interface SeenCall { url: string; body?: unknown }

/** A gateway that answers with whatever the test hands it, so both what the
 *  tool SENDS and what it does with the answer are assertable. */
function stub(status = 200, payload: unknown = { workItem: { id: "JIN-1", status: "done" } }) {
  const calls: SeenCall[] = [];
  const fetchFn = (async (input: string | URL, init?: RequestInit) => {
    calls.push({
      url: typeof input === "string" ? input : input.toString(),
      body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined,
    });
    return { status, text: async () => JSON.stringify(payload) } as unknown as Response;
  }) as unknown as typeof fetch;
  return {
    calls,
    ctx: { gatewayUrl: "http://gateway.test", fetchFn, callerSessionId: "sess-1", sessionCapability: "cap-1" } satisfies JinnMcpContext,
  };
}

function tool(name: string): JinnMcpTool {
  const t = buildWorkItemTools().find((t) => t.name === name);
  if (!t) throw new Error(`no tool ${name}`);
  return t;
}

/* PLA-96: the route owns who may close a tree, so the tool's only job is to
 * carry the ask there intact — and to hand the refusal back unsoftened. */
describe("update_work_item — cascade close", () => {
  it("declares cascade as a boolean, and no longer declares the retired acknowledgement", () => {
    expect(tool("update_work_item").inputSchema.properties.cascade).toMatchObject({ type: "boolean" });
    expect(tool("update_work_item").inputSchema.properties).not.toHaveProperty("acknowledgeEscalated");
  });

  it("forwards it to the guarded status route, and sends it only when asked", async () => {
    const { calls, ctx } = stub();

    await tool("update_work_item").handler({ id: "JIN-1", status: "done", cascade: true }, ctx);
    await tool("update_work_item").handler({ id: "JIN-1", status: "done" }, ctx);

    expect(calls.map((c) => c.body)).toEqual([
      { status: "done", cascade: true },
      { status: "done" },
    ]);
    expect(calls[0].url).toBe("http://gateway.test/api/work-items/JIN-1/status");
  });

  it("forwards cascade to the archive route, refuses a non-boolean, and sends it only when asked", async () => {
    const { calls, ctx } = stub(200, { workItem: { id: "JIN-1", status: "cancelled" }, archived: true });

    await tool("archive_work_item").handler({ id: "JIN-1", note: "obsolete", cascade: true }, ctx);
    await tool("archive_work_item").handler({ id: "JIN-1", note: "obsolete" }, ctx);

    expect(calls.map((c) => c.body)).toEqual([
      { note: "obsolete", cascade: true },
      { note: "obsolete" },
    ]);
    expect(calls[0].url).toBe("http://gateway.test/api/work-items/JIN-1/archive");
    await expect(tool("archive_work_item").handler({ id: "JIN-1", cascade: "yes" }, ctx)).rejects.toThrow(/cascade must be a boolean/);
    expect(calls).toHaveLength(2);
  });

  it("surfaces the route's refusal to a session that may not cascade", async () => {
    const { ctx } = stub(403, { error: "closing a Todo's open descendants with it is an operator-surface decision" });

    await expect(tool("update_work_item").handler({ id: "JIN-1", status: "done", cascade: true }, ctx))
      .rejects.toThrow(/operator-surface decision/);
  });
});
