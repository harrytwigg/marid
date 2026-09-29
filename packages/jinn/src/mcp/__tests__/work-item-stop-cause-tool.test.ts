import { describe, it, expect, beforeAll } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { PARKED_UNTIL_NEEDS_STOP, UNBLOCK_HINT_ERROR } from "../../work-items/stop-cause.js";
import { parseStatusUpdateFields } from "../../gateway/work-item-status-fields.js";
import type { JinnMcpContext, JinnMcpTool } from "../toolkit.js";

process.env.JINN_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "jinn-mcp-stop-cause-"));

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
    return { status: 200, text: async () => JSON.stringify({ workItem: { id: "JIN-1", status: "escalated" } }) } as unknown as Response;
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

/* PLA-157: a duplicated hint validator could accept at one boundary what the
 * other refuses, so both boundaries import the same one — and this proves it by
 * putting the same value through each and comparing the message. */
describe("update_work_item — stop cause", () => {
  const hint = { what: "sign the renewal", who: "the operator" };

  it("declares both fields, so an agent can see how to say why it stopped", () => {
    const props = tool("update_work_item").inputSchema.properties as Record<string, { type: string }>;
    expect(props.parkedUntil).toMatchObject({ type: "string" });
    expect(props.unblockHint).toMatchObject({ type: "object" });
  });

  it("forwards a hint and a park to the guarded status route", async () => {
    const { calls, ctx } = stub();
    const parkedUntil = "2026-09-01T10:00:00.000Z";

    await tool("update_work_item").handler({ id: "JIN-1", status: "escalated", unblockHint: hint }, ctx);
    await tool("update_work_item").handler({ id: "JIN-1", status: "blocked", parkedUntil }, ctx);

    expect(calls.map((c) => c.body)).toEqual([{ status: "escalated", unblockHint: hint }, { status: "blocked", parkedUntil }]);
    expect(calls[0].url).toBe("http://gateway.test/api/work-items/JIN-1/status");
  });

  it("refuses an unknown hint key locally, without calling the gateway", async () => {
    const { calls, ctx } = stub();

    await expect(tool("update_work_item").handler({ id: "JIN-1", status: "escalated", unblockHint: { ...hint, when: "soon" } }, ctx))
      .rejects.toThrow(UNBLOCK_HINT_ERROR);
    expect(calls).toEqual([]);
  });

  it("refuses an unreadable park locally", async () => {
    const { calls, ctx } = stub();

    await expect(tool("update_work_item").handler({ id: "JIN-1", status: "blocked", parkedUntil: "when the quota resets" }, ctx))
      .rejects.toThrow(/parkedUntil must be an ISO-8601 timestamp/);
    expect(calls).toEqual([]);
  });

  it.each([
    ["a backlog move", { status: "backlog" }],
    ["a dependency block", { status: "blocked", blockKind: "dependency" }],
  ])("refuses a park on %s locally, in the route's own words", async (_label, move) => {
    const { calls, ctx } = stub();
    const args = { id: "JIN-1", note: "date-gated", parkedUntil: "2026-10-01T00:00:00.000Z", ...move };

    const route = parseStatusUpdateFields(args, move.status, false);
    const mcp = await tool("update_work_item").handler(args, ctx).catch((err: Error) => err);

    expect(route).toMatchObject({ ok: false, status: 400, error: PARKED_UNTIL_NEEDS_STOP });
    expect((mcp as Error).message).toBe(PARKED_UNTIL_NEEDS_STOP);
    expect(calls).toEqual([]);
  });

  it("gives the unknown key the same message the HTTP route gives it", async () => {
    const { ctx } = stub();
    const bad = { ...hint, when: "soon" };

    const route = parseStatusUpdateFields({ status: "escalated", note: "n", unblockHint: bad }, "escalated", false);
    const mcp = await tool("update_work_item").handler({ id: "JIN-1", status: "escalated", unblockHint: bad }, ctx).catch((err: Error) => err);

    expect(route).toMatchObject({ ok: false, status: 400 });
    // Equal, not merely containing: a trailing full stop on one lane is exactly
    // the drift one shared validator is supposed to make impossible.
    expect((mcp as Error).message).toBe((route as { error: string }).error);
  });
});
