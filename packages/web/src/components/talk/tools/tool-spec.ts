/**
 * The shape of a tool the Talk orb can execute client-side.
 *
 * A tool's `{ name, description, parameters }` triple is structurally the
 * gateway's `RealtimeTool` (packages/hundredfold/src/shared/types.ts), so the transport
 * can hand `toolDefinitions()` to a provider unchanged. The web package has no
 * import path into the gateway package, so the shape is declared here and pinned
 * by a test instead of imported.
 */

export type ToolPropertyType = "string" | "number" | "integer" | "boolean"

export interface ToolProperty {
  type: ToolPropertyType
  description: string
  enum?: readonly string[]
}

/** A JSON Schema object, narrowed to the subset the tool surface uses. */
export interface ToolParameters {
  type: "object"
  properties: Record<string, ToolProperty>
  required?: readonly string[]
  additionalProperties: false
}

export type ToolArgs = Record<string, unknown>

/** Every result is JSON-serialisable: the transport sends it straight back to
 *  the model as the tool output. Failure is a value, never a throw — a thrown
 *  error would take a live voice session down with it. */
export type ToolResult =
  | { ok: true; data: Record<string, unknown> }
  | { ok: false; error: string }

export interface TalkTool {
  name: string
  description: string
  parameters: ToolParameters
  /** Navigation tools must issue the route change before their first `await`,
   *  so the transport can act on partial intent instead of a finished sentence. */
  execute(args: ToolArgs): ToolResult | Promise<ToolResult>
}

/** What a realtime provider is given: a tool minus its client-side executor. */
export type ToolDefinition = Pick<TalkTool, "name" | "description" | "parameters">

export function toolDefinition(tool: TalkTool): ToolDefinition {
  return { name: tool.name, description: tool.description, parameters: tool.parameters }
}

/** Shorthand for the common `{ type, description }` property. */
export function str(description: string, values?: readonly string[]): ToolProperty {
  return values ? { type: "string", description, enum: values } : { type: "string", description }
}

export function params(properties: Record<string, ToolProperty>, required?: readonly string[]): ToolParameters {
  return { type: "object", properties, additionalProperties: false, ...(required ? { required } : {}) }
}
