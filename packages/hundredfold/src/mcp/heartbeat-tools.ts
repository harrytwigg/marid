import { assertBoundCaller, gatewayRequest, HundredfoldMcpToolError, type HundredfoldMcpTool } from "./toolkit.js";

/**
 * Session-armed heartbeats: a session schedules its own future wake-ups so a
 * long run stays grounded instead of going quiet.
 *
 * Same admission rules as the other groups — each tool is a deterministic thin
 * wrapper over one gateway route, and every one of them acts on behalf of a
 * session, so all three fail closed when this server has no bound identity. The
 * OWNER is never an argument: the gateway takes it from the verified caller, so
 * a session can only ever arm, list and stop its own.
 *
 * Descriptions are deliberately terse — this group is paying its own way against
 * a fixed tool-manifest token budget (`__tests__/tool-manifest-budget.test.ts`).
 */
const armHeartbeat: HundredfoldMcpTool = {
  name: "arm_heartbeat",
  description: "Schedule a repeating reminder into your own session. Min 60s, max 5 armed.",
  inputSchema: {
    type: "object",
    properties: {
      message: { type: "string", description: "Delivered verbatim." },
      everySeconds: { type: "number" },
      maxFires: { type: "number" },
      expiresAt: { type: "number", description: "Epoch ms." },
    },
    required: ["message", "everySeconds"],
  },
  handler: async (args, ctx) => {
    assertBoundCaller(ctx);
    const { status, body } = await gatewayRequest(ctx, "POST", "/api/heartbeats", {
      message: args.message,
      everySeconds: args.everySeconds,
      ...(args.maxFires === undefined ? {} : { maxFires: args.maxFires }),
      ...(args.expiresAt === undefined ? {} : { expiresAt: args.expiresAt }),
    });
    if (status >= 400) throw gatewayFailure("arming a heartbeat", status, body);
    const heartbeat = body as { id: string; nextFireAt: number };
    return {
      id: heartbeat.id,
      nextFireAt: heartbeat.nextFireAt,
      hint: "Armed. Next: stop_heartbeat when it is no longer needed.",
    };
  },
};

const listHeartbeats: HundredfoldMcpTool = {
  name: "list_heartbeats",
  description: "List your armed heartbeats.",
  inputSchema: { type: "object", properties: {} },
  handler: async (_args, ctx) => {
    assertBoundCaller(ctx);
    const { status, body } = await gatewayRequest(ctx, "GET", "/api/heartbeats");
    if (status >= 400) throw gatewayFailure("listing heartbeats", status, body);
    const { heartbeats = [] } = (body ?? {}) as { heartbeats?: unknown[] };
    return { heartbeats, hint: "Next: stop_heartbeat with an id." };
  },
};

const stopHeartbeat: HundredfoldMcpTool = {
  name: "stop_heartbeat",
  description: "Disarm one heartbeat you armed.",
  inputSchema: {
    type: "object",
    properties: { id: { type: "string" } },
    required: ["id"],
  },
  handler: async (args, ctx) => {
    assertBoundCaller(ctx);
    const id = typeof args.id === "string" ? args.id.trim() : "";
    if (!id) throw new HundredfoldMcpToolError("id is required and must be a non-empty string");
    const { status, body } = await gatewayRequest(ctx, "DELETE", `/api/heartbeats/${encodeURIComponent(id)}`);
    if (status >= 400) throw gatewayFailure(`stopping heartbeat "${id}"`, status, body);
    return { action: "stopped", id, hint: "Disarmed. Nothing further will be delivered for it." };
  },
};

export function buildHeartbeatTools(): HundredfoldMcpTool[] {
  return [armHeartbeat, listHeartbeats, stopHeartbeat];
}

/** Pass the gateway's own words through so the agent can self-correct. */
function gatewayFailure(action: string, status: number, body: unknown): HundredfoldMcpToolError {
  const detail = typeof body === "object" && body !== null && "error" in body
    ? String((body as { error: unknown }).error)
    : typeof body === "string" ? body : JSON.stringify(body);
  return new HundredfoldMcpToolError(`${action} failed (${status}): ${detail}`);
}
