import { gatewayRequest, type HundredfoldMcpTool } from "./toolkit.js";
import { optionalString, requireLabelChange, requireString, requireTodoId } from "./work-item-args.js";
import { assertIdentity, gatewayFailure, mutationResult } from "./work-item-result.js";

/**
 * The label tools: the shared tag registry, and a Todo's own set.
 *
 * `label_work_item` carries a mode because replace-only was a trap. An agent told
 * to drop one label had to re-send every other label from memory to keep it, and
 * a Todo that lost its arming label that way sits at its arming status forever —
 * its lane trigger filters on that label and can never fire again. `add` and
 * `remove` touch only the labels named, so the rest cannot be lost.
 */

const TODO_ID_SCHEMA = { type: "string", pattern: "^[A-Z]{3}-[1-9][0-9]*$" } as const;

const label: HundredfoldMcpTool = {
  name: "label_work_item",
  description: "Set Todo labels; mode add/remove keeps the rest.",
  inputSchema: {
    type: "object",
    properties: {
      id: TODO_ID_SCHEMA,
      labels: { type: "array", items: { type: "string" } },
      mode: { type: "string", enum: ["add", "remove"] },
    },
    required: ["id", "labels"],
  },
  handler: async (args, ctx) => {
    assertIdentity(ctx);
    const id = requireTodoId(args);
    const change = requireLabelChange(args);
    const { status, body } = await gatewayRequest(ctx, "PUT", `/api/work-items/${encodeURIComponent(id)}/labels`, change);
    if (status >= 400) throw gatewayFailure(`labelling work item "${id}"`, status, body);
    return mutationResult(body, change.labels
      ? "Todo labels replaced."
      : "Todo labels updated; every label you did not name is untouched.");
  },
};

const labelCreate: HundredfoldMcpTool = {
  name: "create_label",
  description: "Create a Todo label; operator or manager only.",
  inputSchema: {
    type: "object",
    properties: {
      name: { type: "string" },
      color: { type: "string" },
      department: { type: "string" },
    },
    required: ["name"],
  },
  handler: async (args, ctx) => {
    assertIdentity(ctx);
    const payload: Record<string, unknown> = { name: requireString(args, "name") };
    for (const key of ["color", "department"] as const) {
      const v = optionalString(args, key);
      if (v !== undefined) payload[key] = v;
    }
    const { status, body } = await gatewayRequest(ctx, "POST", "/api/labels", payload);
    if (status >= 400) throw gatewayFailure("creating label", status, body);
    return { ...(body as Record<string, unknown>), hint: "Next: label_work_item { id, labels }, or pass labels to create_work_item." };
  },
};

const labelsList: HundredfoldMcpTool = {
  name: "list_labels",
  description: "List Todo labels.",
  inputSchema: { type: "object", properties: {} },
  handler: async (_args, ctx) => {
    assertIdentity(ctx);
    const { status, body } = await gatewayRequest(ctx, "GET", "/api/labels");
    if (status >= 400) throw gatewayFailure("listing labels", status, body);
    return body;
  },
};

export function labelTools(): HundredfoldMcpTool[] {
  return [label, labelCreate, labelsList];
}
