/**
 * Provider declarations derived from Talk's authoritative control manifest.
 *
 * The gateway mints exactly the catalog the browser later configures on the
 * realtime session. Execution target and authority remain manifest metadata;
 * the provider sees only its ordinary function declaration.
 */
import type { RealtimeTool } from "../../shared/voice.js";
import { buildTalkControlManifest } from "../control/manifest.js";

function providerTool(operation: ReturnType<typeof buildTalkControlManifest>["operations"][number]): RealtimeTool {
  return {
    name: operation.name,
    description: operation.description,
    parameters: structuredClone(operation.parameters),
  };
}

export function allTools(): RealtimeTool[] {
  return buildTalkControlManifest().operations.map(providerTool);
}

/** Estimated provider-context cost of a tool list. */
export function estimateToolTokens(tools: readonly RealtimeTool[]): number {
  return Math.ceil(JSON.stringify(tools).length / 4);
}

export function toolsByName(names: readonly string[]): RealtimeTool[] {
  const catalog = new Map(allTools().map((tool) => [tool.name, tool]));
  return names.flatMap((name) => {
    const tool = catalog.get(name);
    return tool ? [tool] : [];
  });
}
