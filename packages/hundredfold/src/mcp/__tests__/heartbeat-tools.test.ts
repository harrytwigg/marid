import { describe, it, expect } from "vitest";
import { buildHeartbeatTools } from "../heartbeat-tools.js";
import { HundredfoldMcpToolError, type HundredfoldMcpContext, type HundredfoldMcpTool } from "../toolkit.js";

/**
 * UNIT tier for the heartbeats tool group: each tool against a stub fetch —
 * exact route/method/body, and the fail-closed refusal when this server has no
 * bound caller identity. The tools driving the REAL routes and store live in
 * gateway/__tests__/heartbeat-routes.test.ts.
 */

function tool(name: string): HundredfoldMcpTool {
  const found = buildHeartbeatTools().find((candidate) => candidate.name === name);
  if (!found) throw new Error(`no tool ${name}`);
  return found;
}

/* ── Unit tier ──────────────────────────────────────────────────────────────── */

interface SeenCall {
  url: string;
  method: string;
  body?: unknown;
}

function stub(responder: (call: SeenCall) => { status: number; body: unknown }, callerSessionId?: string) {
  const calls: SeenCall[] = [];
  const fetchFn = (async (input: string | URL, init?: RequestInit) => {
    const call: SeenCall = {
      url: typeof input === "string" ? input : input.toString(),
      method: init?.method ?? "GET",
      body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined,
    };
    calls.push(call);
    const { status, body } = responder(call);
    return { status, text: async () => JSON.stringify(body) } as unknown as Response;
  }) as unknown as typeof fetch;
  const ctx: HundredfoldMcpContext = {
    gatewayUrl: "http://gateway.test",
    fetchFn,
    callerSessionId,
    sessionCapability: callerSessionId ? "cap-test" : undefined,
  };
  return { calls, ctx };
}

describe("heartbeat tools — registry + schemas", () => {
  it("exposes the 3 tools with flat object schemas and required args", () => {
    const tools = buildHeartbeatTools();
    expect(tools.map((t) => t.name)).toEqual(["arm_heartbeat", "list_heartbeats", "stop_heartbeat"]);
    expect(tools.map((t) => t.inputSchema.required ?? [])).toEqual([
      ["message", "everySeconds"],
      [],
      ["id"],
    ]);
  });

  it("never accepts an owner as an argument", () => {
    for (const t of buildHeartbeatTools()) {
      expect(Object.keys(t.inputSchema.properties)).not.toContain("ownerSessionId");
      expect(Object.keys(t.inputSchema.properties)).not.toContain("sessionId");
    }
  });

  it("arms through POST /api/heartbeats with only the caller's stated fields", async () => {
    const { calls, ctx } = stub(() => ({ status: 201, body: { id: "hb-1", nextFireAt: 42 } }), "session-a");
    const result = await tool("arm_heartbeat").handler(
      { message: "ping", everySeconds: 90, maxFires: 3 },
      ctx,
    );
    expect(calls[0]!.method).toBe("POST");
    expect(calls[0]!.url).toBe("http://gateway.test/api/heartbeats");
    expect(calls[0]!.body).toEqual({ message: "ping", everySeconds: 90, maxFires: 3 });
    expect(result).toMatchObject({ id: "hb-1", nextFireAt: 42 });
  });

  it("stops through DELETE /api/heartbeats/:id", async () => {
    const { calls, ctx } = stub(() => ({ status: 200, body: { status: "stopped" } }), "session-a");
    const result = await tool("stop_heartbeat").handler({ id: "hb-1" }, ctx);
    expect(calls[0]!.method).toBe("DELETE");
    expect(calls[0]!.url).toBe("http://gateway.test/api/heartbeats/hb-1");
    expect(result).toMatchObject({ action: "stopped", id: "hb-1" });
  });

  it("passes a refused limit through in the gateway's own words", async () => {
    const { ctx } = stub(() => ({ status: 422, body: { error: "everySeconds is 5, below the 60-second floor." } }), "session-a");
    await expect(tool("arm_heartbeat").handler({ message: "ping", everySeconds: 5 }, ctx))
      .rejects.toThrow(/everySeconds is 5, below the 60-second floor/);
  });

  it("fails closed on every tool when the server has no bound caller identity", async () => {
    for (const [name, args] of [
      ["arm_heartbeat", { message: "ping", everySeconds: 60 }],
      ["list_heartbeats", {}],
      ["stop_heartbeat", { id: "hb-1" }],
    ] as const) {
      const { calls, ctx } = stub(() => ({ status: 200, body: {} }));
      await expect(tool(name).handler(args, ctx)).rejects.toThrow(HundredfoldMcpToolError);
      expect(calls).toHaveLength(0); // refused locally, before any round trip
    }
  });
});
