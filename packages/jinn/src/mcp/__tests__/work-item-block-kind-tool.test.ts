import { describe, it, expect, beforeAll } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { JinnMcpContext, JinnMcpTool } from "../toolkit.js";

process.env.JINN_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "jinn-mcp-block-kind-"));

let buildWorkItemTools: typeof import("../work-item-tools.js").buildWorkItemTools;

beforeAll(async () => {
  ({ buildWorkItemTools } = await import("../work-item-tools.js"));
});

interface SeenCall { url: string; method: string; body?: unknown }

/** A gateway that always answers 200, so what the tool SENDS is the assertion. */
function stub() {
  const calls: SeenCall[] = [];
  const fetchFn = (async (input: string | URL, init?: RequestInit) => {
    calls.push({
      url: typeof input === "string" ? input : input.toString(),
      method: init?.method ?? "GET",
      body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined,
    });
    return { status: 200, text: async () => JSON.stringify({ workItem: { id: "JIN-1", status: "blocked" } }) } as unknown as Response;
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

/* The kind is what an agent chooses when it blocks, and choosing badly
 * routes work somewhere nobody asked for — so the tool declares the four and
 * refuses anything else before the gateway is called at all. */
describe("update_work_item — blockKind", () => {
  it("declares the four kinds as an enum on its schema", () => {
    expect(tool("update_work_item").inputSchema.properties.blockKind).toMatchObject({
      type: "string",
      enum: ["dependency", "needs_input", "capability", "transient"],
    });
  });

  it("forwards a known kind to the guarded status route", async () => {
    const { calls, ctx } = stub();

    await tool("update_work_item").handler({ id: "JIN-1", status: "blocked", blockKind: "dependency" }, ctx);
    await tool("update_work_item").handler({ id: "JIN-1", status: "blocked" }, ctx);

    expect(calls.map((c) => c.body)).toEqual([{ status: "blocked", blockKind: "dependency" }, { status: "blocked" }]);
    expect(calls[0].url).toBe("http://gateway.test/api/work-items/JIN-1/status");
  });

  it("refuses an unknown kind locally, without calling the gateway", async () => {
    const { calls, ctx } = stub();

    await expect(tool("update_work_item").handler({ id: "JIN-1", status: "blocked", blockKind: "waiting" }, ctx))
      .rejects.toThrow(/blockKind must be one of dependency, needs_input, capability, transient/);
    expect(calls).toEqual([]);
  });
});
