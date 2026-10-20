import { describe, it, expect } from "vitest";
import { buildWorkItemTools } from "../work-item-tools.js";
import type { JinnMcpContext } from "../toolkit.js";

/** Who may close, as update_work_item tells a caller, and that the tool leaves the refusal to the gateway. */

const update = buildWorkItemTools().find((t) => t.name === "update_work_item")!;

function stub(status: number, body: unknown) {
  const bodies: unknown[] = [];
  const fetchFn = (async (_url: string, init?: RequestInit) => {
    bodies.push(JSON.parse(String(init?.body)));
    return { status, text: async () => JSON.stringify(body) } as unknown as Response;
  }) as unknown as typeof fetch;
  const ctx = { gatewayUrl: "http://127.0.0.1:7777", fetchFn, callerSessionId: "session-test", sessionCapability: "cap-test" } as JinnMcpContext;
  return { bodies, ctx };
}

describe("update_work_item and closing a Todo", () => {
  it("names who may close, and still offers done", () => {
    expect(update.description).toMatch(/done: operator, closeTodos employee or parent owner; reason in note/);
    expect((update.inputSchema.properties as { status: { enum: string[] } }).status.enum).toContain("done");
  });

  it("forwards a close with no asOperator for the gateway's lane to decide", async () => {
    const { bodies, ctx } = stub(200, { workItem: { id: "JIN-1", status: "done" } });
    await update.handler({ id: "JIN-1", status: "done", note: "PR merged and deployed" }, ctx);
    expect(bodies).toEqual([{ status: "done", note: "PR merged and deployed" }]);
  });

  it("surfaces the gateway's refusal for an employee without the grant", async () => {
    const { ctx } = stub(403, { error: "closing Todo JIN-1 is the operator's decision" });
    await expect(update.handler({ id: "JIN-1", status: "done", note: "x" }, ctx)).rejects.toThrow(/operator's decision/);
  });
});
