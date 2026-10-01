import { buildTools } from "../../mcp/server.js";
import type { KnowledgeSearchWording } from "../../mcp/knowledge-tools.js";
import type { JinnMcpTool } from "../../mcp/toolkit.js";

/**
 * The remote connector's closed tool profile (spec Q2 option B):
 * class R (company reads, no transcripts) and class L (ledger writes). Named
 * here, never derived: a tool added to `buildTools` stays off the remote door
 * until someone decides it belongs. research.md's route audit is the evidence
 * for every R and L name.
 */
export const REMOTE_MCP_READ_TOOLS = [
  "list_work_items", "get_work_item", "search_work_items", "get_work_item_tree", "list_work_item_comments",
  "list_work_item_attachments", "list_sessions", "search_sessions", "list_employees", "get_employee",
  "find_employees", "list_departments", "list_notes", "read_note", "search_knowledge", "list_workflows",
  "get_workflow", "list_workflow_runs", "get_workflow_run", "list_cron_jobs", "get_cron_run_history",
  "cost_report", "list_labels", "list_experiments", "get_experiment", "list_heartbeats", "list_files", "read_file",
] as const;

export const REMOTE_MCP_LEDGER_TOOLS = [
  "create_work_item", "edit_work_item", "comment_work_item", "label_work_item", "link_work_items",
  "unlink_work_items", "create_note", "update_note", "record_reading", "conclude_experiment",
] as const;

/**
 * Session control: the operator driving Jinn from the connector —
 * tail a session, prod it, hand an employee new work, reassign a Todo. The
 * existing tools, unchanged, because the gateway routes behind them already
 * carry the guards (lateral send cap and hop budget, roster validation).
 * `delegate_task` is the "dispatch to a named employee" verb: it mints the Todo
 * and starts that employee's session in one transaction.
 */
export const REMOTE_MCP_SESSION_TOOLS = ["read_session", "send_to_session", "delegate_task", "assign_work_item"] as const;

const PROFILE = new Set<string>([...REMOTE_MCP_READ_TOOLS, ...REMOTE_MCP_LEDGER_TOOLS, ...REMOTE_MCP_SESSION_TOOLS]);

/**
 * The shared hints and descriptions teach an engine session to end its turn and
 * be woken by the reply. Nothing wakes a connector client, and its anchor never
 * runs a turn, so on this door they say where the answer will be read instead.
 */
const REMOTE_MCP_DESCRIPTIONS: Record<string, string> = {
  delegate_task:
    "Hand a named employee TRACKED work: a new Todo, or an existing one by workItemId. Starts their session; " +
    "read progress with read_session or get_work_item. Use idempotencyKey for retries. Choose employee by role/persona fit.",
};

const REMOTE_MCP_HINTS: Partial<Record<string, (result: Record<string, unknown>) => string>> = {
  send_to_session: (result) =>
    `Queued. The session answers in its own transcript: read_session { sessionId: "${String(result.sessionId)}" } to see it.`,
  delegate_task: (result) =>
    `Todo ${String(result.workItemId ?? "?")} tracks this; session ${String(result.sessionId ?? "?")} is working it. ` +
    "Read progress with read_session or get_work_item.",
  list_work_item_attachments: () =>
    "Metadata only: attachment bytes are not readable over this connector. Open the Todo in the Jinn web UI to view or download them.",
};

/** Adapt a tool to this door. Every handler runs inside the gateway here, so
 *  every call carries `hostLocations: false`: a "read it on your host" field
 *  would name the gateway's disk and loopback port. */
function forRemoteDoor(tool: JinnMcpTool): JinnMcpTool {
  const hint = REMOTE_MCP_HINTS[tool.name];
  return {
    ...tool,
    description: REMOTE_MCP_DESCRIPTIONS[tool.name] ?? tool.description,
    handler: async (args, ctx) => {
      const result = await tool.handler(args, { ...ctx, hostLocations: false });
      return hint && result && typeof result === "object" && !Array.isArray(result)
        ? { ...(result as Record<string, unknown>), hint: hint(result as Record<string, unknown>) }
        : result;
    },
  };
}

/** The profile's tools, in `buildTools` order. Note tools appear only when Notes are enabled. */
export function buildRemoteMcpTools(notesEnabled: boolean, knowledge?: KnowledgeSearchWording): JinnMcpTool[] {
  return buildTools({ notesEnabled, workflowAttempt: false, knowledge }).filter((tool) => PROFILE.has(tool.name)).map(forRemoteDoor);
}
