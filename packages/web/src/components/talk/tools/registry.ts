import { CHAT_MESSAGE_SEARCH_TOOL } from "./chat-message-search"
import { CHAT_COMPOSER_TOOLS } from "./chat-composer-tools"
import { afterNextPaint, nowMs, recordToolTiming } from "./budget"
import { CONSENT_TOOLS } from "./consent-tools"
import { ESCAPE_HATCH_TOOL } from "./escape-hatch"
import { FOCUS_ELEMENT_TOOL } from "./focus-element"
import { NAVIGATE_TOOLS } from "./navigate-tools"
import { PAGE_TOOLS } from "./page-tools"
import { READ_TOOLS } from "./read-tools"
import { RESOLVE_TOOLS } from "./resolve-tools"
import { UNBLOCK_TOOLS } from "./unblock-tools"
import { toolDefinition, type TalkTool, type ToolDefinition, type ToolResult } from "./tool-spec"
import { parseToolArgs } from "./validate-args"
import { WRITE_TOOLS } from "./write-tools"
import { VISUAL_CAPTURE_TOOL } from "./visual-tools"

/**
 * Every tool the Talk orb can execute, and the one entry point that runs them.
 *
 * `executeToolCall` is the seam: the realtime transport hands it a provider's
 * `tool_call` event verbatim. It answers with a value in every case, including
 * every kind of bad input — a throw would take a live voice session down with
 * it. Writes are resident like everything else — the gateway mints the whole
 * catalog when the session opens; `operatorOnly` and voice approval contain them.
 */

export const TALK_TOOLS: readonly TalkTool[] = [
  ...NAVIGATE_TOOLS,
  ...RESOLVE_TOOLS,
  ...READ_TOOLS,
  CHAT_MESSAGE_SEARCH_TOOL,
  ...CHAT_COMPOSER_TOOLS,
  ...WRITE_TOOLS,
  ...CONSENT_TOOLS,
  ...UNBLOCK_TOOLS,
  ...PAGE_TOOLS,
  FOCUS_ELEMENT_TOOL,
  ESCAPE_HATCH_TOOL,
  VISUAL_CAPTURE_TOOL,
]

const BY_NAME = new Map(TALK_TOOLS.map((tool) => [tool.name, tool]))

export function findTool(name: string): TalkTool | undefined {
  return BY_NAME.get(name)
}

/** What a realtime provider is configured with. */
export function toolDefinitions(tools: readonly TalkTool[] = TALK_TOOLS): ToolDefinition[] {
  return tools.map(toolDefinition)
}

function unknownTool(name: string): ToolResult {
  return {
    ok: false,
    error: `There is no tool called "${name}". The available tools are: ${TALK_TOOLS.map((tool) => tool.name).join(", ")}.`,
  }
}

/**
 * Run one tool call. `argsJson` is the raw JSON string the model produced.
 *
 * Nothing is awaited before `tool.execute`, so a navigation tool has already
 * committed its route change by the time this returns a promise — which is what
 * lets the transport dispatch on partial intent.
 */
export async function executeToolCall(name: string, argsJson?: string): Promise<ToolResult> {
  const startedAt = nowMs()
  const tool = findTool(name)
  if (!tool) return unknownTool(name)

  const parsed = parseToolArgs(name, tool.parameters, argsJson)
  if (!parsed.ok) return { ok: false, error: parsed.error }

  let settling: ToolResult | Promise<ToolResult>
  try {
    settling = tool.execute(parsed.args)
  } catch (error) {
    return { ok: false, error: `"${name}" failed: ${error instanceof Error ? error.message : String(error)}.` }
  }

  // Timed to the first frame painted after the call settles. A navigation tool
  // settles on the router's arrival, not on its request, so this is genuinely
  // dispatch-to-visible — the only number the budget can be read against.
  const measure = Promise.resolve(settling).then(() => {
    afterNextPaint(() => recordToolTiming(name, nowMs() - startedAt))
  })
  void measure.catch(() => { /* the failure is reported below; timing is not */ })

  try {
    return await settling
  } catch (error) {
    return { ok: false, error: `"${name}" failed: ${error instanceof Error ? error.message : String(error)}.` }
  }
}
