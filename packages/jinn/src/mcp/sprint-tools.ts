import { gatewayRequest, type JinnMcpTool } from "./toolkit.js";
import { requireString, requireTodoId } from "./work-item-args.js";
import { assertIdentity, gatewayFailure, mutationResult } from "./work-item-result.js";

/**
 * The sprint tools: read the registry, and move one Todo. Planning a sprint —
 * creating, starting, completing it — stays with the operator's board and the
 * HTTP routes; an agent that only files and moves work needs neither.
 *
 * `sprint: "none"` takes a Todo out of any sprint. It is a word rather than a
 * null because "none" is already reserved (no sprint may be named it) and a
 * string-only schema costs less manifest than a nullable one.
 */

const TODO_ID_SCHEMA = { type: "string", pattern: "^[A-Z]{3}-[1-9][0-9]*$" } as const;

const setSprint: JinnMcpTool = {
  name: "set_work_item_sprint",
  description: "Move a top-level Todo to a sprint; none removes it.",
  inputSchema: {
    type: "object",
    properties: { id: TODO_ID_SCHEMA, sprint: { type: "string" } },
    required: ["id", "sprint"],
  },
  handler: async (args, ctx) => {
    assertIdentity(ctx);
    const id = requireTodoId(args);
    const ref = requireString(args, "sprint", 200);
    const sprint = ref.trim().toLowerCase() === "none" ? null : ref;
    const { status, body } = await gatewayRequest(ctx, "PUT", `/api/work-items/${encodeURIComponent(id)}/sprint`, { sprint });
    if (status >= 400) throw gatewayFailure(`moving work item "${id}" between sprints`, status, body);
    return mutationResult(body, sprint === null ? "Todo is in no sprint." : "Todo moved; its sub-tasks follow it.");
  },
};

const sprintsList: JinnMcpTool = {
  name: "list_sprints",
  description: "List sprints, active first.",
  inputSchema: { type: "object", properties: {} },
  handler: async (_args, ctx) => {
    assertIdentity(ctx);
    const { status, body } = await gatewayRequest(ctx, "GET", "/api/sprints");
    if (status >= 400) throw gatewayFailure("listing sprints", status, body);
    return body;
  },
};

export function sprintTools(): JinnMcpTool[] {
  return [setSprint, sprintsList];
}
