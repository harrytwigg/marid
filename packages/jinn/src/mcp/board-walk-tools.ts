import { assertBoundCaller, gatewayRequest, JinnMcpToolError, type JinnMcpTool } from "./toolkit.js";

/**
 * The board walk's toolset: the whole tool surface of the walk's turn, served
 * in place of the company belt (server.ts `toolsFor`). The model reads the
 * board and decides on each Todo through these; the gateway checks every
 * decision and carries it out (board-walk/turn.ts). There is no general write
 * here, and the gateway answers only the running walk's own session.
 */

const DECISION_ACTIONS = ["release", "park", "flag", "leave"];
const VERDICTS = ["ready", "gated", "stuck", "unclear"];

const GATE_SCHEMA = {
  type: "object",
  properties: {
    kind: { type: "string", enum: ["date", "blocker", "pr", "issue"] },
    date: { type: "string", description: "For a date gate: YYYY-MM-DD." },
    quote: { type: "string", description: "For a date gate: the Todo's own words naming the date, copied exactly." },
    id: { type: "string", description: "For a blocker gate: the blocking Todo's id." },
    url: { type: "string", description: "For a pr or issue gate: its GitHub URL." },
  },
  required: ["kind"],
};

const DECISION_SCHEMA: JinnMcpTool["inputSchema"] = {
  type: "object",
  properties: {
    id: { type: "string" },
    verdict: { type: "string", enum: VERDICTS },
    action: { type: "string", enum: DECISION_ACTIONS },
    reason: { type: "string", description: "One or two plain sentences." },
    until: { type: "string", description: "For park: when it returns to the queue, ISO-8601." },
    gates: { type: "array", items: GATE_SCHEMA, description: "For release: every gate that is now met." },
  },
  required: ["id", "verdict", "action", "reason"],
};

/** One tool: its arguments go to the gateway as they are, and the gateway's
 *  answer comes back as the result text, or as an error the model can read. */
function walkTool(name: string, description: string, inputSchema: JinnMcpTool["inputSchema"]): JinnMcpTool {
  return {
    name,
    description,
    inputSchema,
    handler: async (args, ctx) => {
      assertBoundCaller(ctx);
      const { status, body } = await gatewayRequest(ctx, "POST", `/api/board-walk/turn/${name}`, args);
      const reply = (body ?? {}) as { ok?: boolean; text?: unknown; error?: unknown };
      const text = typeof reply.text === "string" ? reply.text : typeof reply.error === "string" ? reply.error : `the gateway answered ${status}`;
      if (status !== 200 || reply.ok !== true) throw new JinnMcpToolError(text);
      return text;
    },
  };
}

export function buildBoardWalkTools(): JinnMcpTool[] {
  return [
    walkTool(
      "walk_board",
      "The open Todos, one line each, highest priority first, with what this tick has already decided. Page with offset.",
      { type: "object", properties: { offset: { type: "integer", minimum: 0 }, limit: { type: "integer", minimum: 1, maximum: 100 } } },
    ),
    walkTool(
      "walk_todo",
      "One open Todo in full: its facts, relations, the real state of linked pull requests and issues, its body and newest comments.",
      { type: "object", properties: { id: { type: "string" } }, required: ["id"] },
    ),
    walkTool(
      "walk_decide",
      "Your decision on one Todo, with your reason. The gateway checks it and carries it out at once, and says what it did.",
      DECISION_SCHEMA,
    ),
    walkTool(
      "walk_start",
      "Start one backlog Todo through the Todo Dispatcher, with why this one, now.",
      {
        type: "object",
        properties: {
          id: { type: "string" },
          reason: { type: "string" },
          engine: { type: "string", description: "Optional preference passed to the Dispatcher." },
          model: { type: "string", description: "Optional preference passed to the Dispatcher." },
        },
        required: ["id", "reason"],
      },
    ),
    walkTool(
      "walk_finish",
      "Once, last: a one-sentence summary of the tick, and why you started what you started or why you started nothing.",
      {
        type: "object",
        properties: { summary: { type: "string" }, dispatchReason: { type: "string" } },
        required: ["summary", "dispatchReason"],
      },
    ),
  ];
}
