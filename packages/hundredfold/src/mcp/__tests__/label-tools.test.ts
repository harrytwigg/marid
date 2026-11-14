import { describe, it, expect } from "vitest";
import { labelTools } from "../label-tools.js";
import type { HundredfoldMcpContext, HundredfoldMcpTool } from "../toolkit.js";

/* `label_work_item` used to have one mode: replace. An agent told to drop a single
 * label had to re-send every other label from memory to keep it, and a Todo that
 * lost its arming label that way sits at its arming status forever — its lane
 * trigger filters on that label and can never fire again. */

interface SeenCall { url: string; method: string; body?: unknown }

function stub(responder: () => { status: number; body: unknown }) {
  const calls: SeenCall[] = [];
  const fetchFn = (async (input: string | URL, init?: RequestInit) => {
    calls.push({
      url: typeof input === "string" ? input : input.toString(),
      method: init?.method ?? "GET",
      body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined,
    });
    const { status, body } = responder();
    return { status, text: async () => JSON.stringify(body) } as unknown as Response;
  }) as unknown as typeof fetch;
  const ctx: HundredfoldMcpContext = {
    gatewayUrl: "http://127.0.0.1:7911", fetchFn, callerSessionId: "session-test", sessionCapability: "cap-test",
  };
  return { calls, ctx };
}

function tool(name: string): HundredfoldMcpTool {
  const found = labelTools().find((entry) => entry.name === name);
  if (!found) throw new Error(`no tool ${name}`);
  return found;
}

describe("label_work_item", () => {
  it("turns the mode into the route's own body, trimmed", async () => {
    const { calls, ctx } = stub(() => ({ status: 200, body: { labels: [{ id: "lbl_0a1b2c3d4e5f", name: "bug" }] } }));

    await tool("label_work_item").handler({ id: "JIN-7", labels: [" bug "] }, ctx);
    await tool("label_work_item").handler({ id: "JIN-7", labels: [" bug "], mode: "remove" }, ctx);
    await tool("label_work_item").handler({ id: "JIN-7", labels: ["perf"], mode: "add" }, ctx);

    expect(calls.map((call) => call.method)).toEqual(["PUT", "PUT", "PUT"]);
    expect(new URL(calls[0]!.url).pathname).toBe("/api/work-items/JIN-7/labels");
    // No mode is what replacing the whole set looks like; the other two name only
    // the labels they touch, so nothing else on the Todo can be lost.
    expect(calls.map((call) => call.body)).toEqual([{ labels: ["bug"] }, { remove: ["bug"] }, { add: ["perf"] }]);
  });

  it("says which hint applies, so a replace is never mistaken for a partial change", async () => {
    const { ctx } = stub(() => ({ status: 200, body: { labels: [] } }));

    const replaced = await tool("label_work_item").handler({ id: "JIN-7", labels: ["bug"] }, ctx) as { hint: string };
    const added = await tool("label_work_item").handler({ id: "JIN-7", labels: ["bug"], mode: "add" }, ctx) as { hint: string };

    expect(replaced.hint).toContain("Todo labels replaced.");
    expect(added.hint).toContain("every label you did not name is untouched");
  });

  it("refuses an unusable call without reaching the gateway", async () => {
    const { calls, ctx } = stub(() => ({ status: 500, body: { error: "must not run" } }));

    await expect(tool("label_work_item").handler({ id: "JIN-7" }, ctx)).rejects.toThrow(/labels must be an array/);
    await expect(tool("label_work_item").handler({ id: "JIN-7", labels: ["bug"], mode: "clear" }, ctx))
      .rejects.toThrow(/mode must be one of add, remove/);
    // An empty `labels` clears the set; an empty add or remove names nothing.
    await expect(tool("label_work_item").handler({ id: "JIN-7", labels: [], mode: "remove" }, ctx))
      .rejects.toThrow(/at least one label to remove/);
    expect(calls).toEqual([]);
  });
});
